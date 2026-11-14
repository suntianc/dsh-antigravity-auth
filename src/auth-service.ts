/** Host-side Antigravity risk gate, OAuth coordinator, and credential commit boundary. */

import type { AntigravityAuthRecord, AntigravityAuthStore } from './auth-store.ts'
import { createAuthStore, defaultAuthStorePath } from './auth-store.ts'
import { createCredentialCoordinator, type CredentialCoordinator, type CredentialCoordinatorOptions, type CredentialMutationBinding, type HostCredential } from './credential-coordinator.ts'
import { createOAuthFlow, OAuthFlowError } from './oauth-flow.ts'
import type {
  OAuthFlow,
  OAuthFlowCompletionResult,
  OAuthFlowOptions,
  OAuthToken,
  ProjectValidation,
} from './oauth-flow.ts'
import { createProjectDiscovery } from './project-context.ts'
import { isBoundedSafeText } from './safe-text.ts'
import type { ProjectDiscoveryOptions } from './project-context.ts'
import type {
  AntigravityStatusView,
  BootstrapStatusService,
  RiskAcknowledgementResult,
  LoginActionResult,
  LoginStartResult,
  LoginStatusView,
  CapabilityGateEvidence,
  LlmFamilyId,
} from './status.ts'
import { createStatusView } from './status.ts'
import { createQuotaService, type QuotaService, type QuotaServiceOptions } from './quota.ts'
import {
  createFileCapabilityGates,
  createMemoryCapabilityGates,
  defaultCapabilityGatePath,
  type CapabilityGateRegistry,
} from './capability-gates.ts'
import type { CapabilityGateOutcome, CapabilityRowId } from './status.ts'

export const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo' as const

/**
 * Fetch the account email through the Google userinfo endpoint. Antigravity
 * requests `userinfo.email` but not `openid`, so the token exchange never
 * carries an `id_token`; userinfo is the only email source for this flow.
 * @param accessToken - live bearer token for the current account.
 * @returns the raw email, or undefined when the probe cannot answer.
 */
export async function fetchUserEmail(accessToken: string): Promise<string | undefined> {
  const response = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) return undefined
  const text = await response.text()
  if (text.length > 64 * 1024) return undefined
  const payload = JSON.parse(text) as unknown
  if (typeof payload !== 'object' || payload === null) return undefined
  const email = (payload as { email?: unknown }).email
  return typeof email === 'string' && email.includes('@') ? email : undefined
}

export interface AntigravityAuthServiceOptions {
  readonly store?: AntigravityAuthStore
  readonly storePath?: string
  /** Multi-account cache; in-memory when the auth store is injected without a path. */
  readonly accountStore?: AntigravityAccountStore
  readonly flowOptions?: Omit<OAuthFlowOptions, 'commit' | 'validateProject'>
  /** Inject a complete private transport only for deterministic Host tests. */
  readonly projectOptions?: ProjectDiscoveryOptions
  readonly credentialOptions?: Omit<CredentialCoordinatorOptions, 'store'>
  readonly quotaOptions?: Omit<QuotaServiceOptions, 'auth'>
  readonly gates?: CapabilityGateRegistry
  readonly gatePath?: string
  readonly autoActivateGates?: boolean
  /**
   * Resolve the account email from a live access token. Absent by default so
   * unit compositions never egress; the production mount wires
   * {@link fetchUserEmail}.
   */
  readonly fetchEmail?: (accessToken: string) => Promise<string | undefined>
}

import {
  createAccountStore,
  createMemoryAccountStore,
  defaultAccountStorePath,
  type AntigravityAccountStore,
  type CachedAccount,
} from './account-store.ts'
export type { CachedAccount } from './account-store.ts'

export class AntigravityAuthService implements BootstrapStatusService {
  private readonly store: AntigravityAuthStore
  private readonly credentials: CredentialCoordinator
  private readonly flow: OAuthFlow
  private readonly quota: QuotaService
  private readonly gates: CapabilityGateRegistry
  private readonly autoActivate: boolean
  readonly accountStore: AntigravityAccountStore
  private readonly fetchEmail: ((accessToken: string) => Promise<string | undefined>) | undefined
  private emailBackfillAttempted = false
  private riskAcknowledged = false
  private activeFlowGeneration = 0
  private disposed = false
  private readonly statusListeners = new Set<() => void>()

  constructor(options: AntigravityAuthServiceOptions = {}) {
    this.autoActivate = options.autoActivateGates ?? false
    this.fetchEmail = options.fetchEmail
    const storePath = options.storePath ?? defaultAuthStorePath()
    this.store = options.store ?? createAuthStore(storePath)
    this.accountStore = options.accountStore
      ?? (options.store !== undefined && options.storePath === undefined
        ? createMemoryAccountStore(this.store)
        : createAccountStore(defaultAccountStorePath(storePath), storePath))
    this.gates = options.gates ?? (options.gatePath !== undefined
      ? createFileCapabilityGates(options.gatePath)
      : options.store === undefined
        ? createFileCapabilityGates(defaultCapabilityGatePath(storePath))
        : createMemoryCapabilityGates())
    this.credentials = createCredentialCoordinator({
      ...options.credentialOptions,
      store: this.store,
      onTokenRotated: async (record, previous) => {
        const target = await this.accountForRecord(previous)
        if (target === undefined) return
        await this.accountStore.syncRefreshToken({
          accountId: target.id,
          refreshToken: record.refreshToken,
          previousRefreshToken: previous.refreshToken,
          ...(target.lineage === undefined ? {} : { lineage: target.lineage }),
        })
      },
    })
    this.quota = createQuotaService({
      ...options.quotaOptions,
      auth: this.credentials,
    })
    const projectDiscovery = createProjectDiscovery(options.projectOptions)
    this.flow = createOAuthFlow({
      ...options.flowOptions,
      validateProject: (accessToken, signal) => projectDiscovery.discover(accessToken, signal),
      commit: (token, project, signal) => this.commitCredential(token, project, signal),
    })
  }

  async listAccounts(): Promise<{
    activeId: string | undefined
    accounts: readonly (CachedAccount & { isActive: boolean; index: number })[]
  }> {
    await this.backfillActiveAccountEmail()
    return await this.accountStore.list()
  }

  /**
   * Backfill the active account's email through the injected fetcher, once per
   * process. Accounts saved before the email probe existed (or seeded from an
   * email-less auth.json) stay usable without it; the fetcher failure only
   * leaves the email unset.
   */
  private async backfillActiveAccountEmail(): Promise<void> {
    if (this.emailBackfillAttempted || this.fetchEmail === undefined || this.disposed) return
    this.emailBackfillAttempted = true
    try {
      const accounts = await this.accountStore.read()
      const boundId = accounts.activeId
      if (boundId === undefined) return
      const boundAccount = accounts.accounts.find(account => account.id === boundId)
      if (boundAccount === undefined || boundAccount.email !== undefined) return
      const record = await this.readRecord()
      if (record === undefined || record.email !== undefined) return
      const credential = await this.credentials.credential()
      if (credential === undefined) return
      const email = await this.fetchEmail(credential.accessToken)
      if (email === undefined) return
      const still = await this.accountStore.read()
      if (still.activeId !== boundId) {
        this.emailBackfillAttempted = false
        return
      }
      const currentAccount = still.accounts.find(account => account.id === boundId)
      if (currentAccount === undefined || currentAccount.email !== undefined) return
      const current = await this.readRecord()
      if (current === undefined || current.refreshToken !== currentAccount.refreshToken) {
        this.emailBackfillAttempted = false
        return
      }
      if (current.email !== undefined) return
      const masked = maskEmail(email)
      const committed = await this.store.compareAndCommit(current.revision, {
        refreshToken: current.refreshToken,
        projectId: current.projectId,
        ...(masked === undefined ? {} : { email: masked }),
        ...(current.lineage === undefined ? {} : { lineage: current.lineage }),
      }, current.lineage)
      if (committed === undefined) return
      await this.accountStore.saveAccount({
        id: boundId,
        email,
        projectId: currentAccount.projectId,
        refreshToken: currentAccount.refreshToken,
        updatedAt: committed.updatedAt,
        ...(currentAccount.lineage === undefined ? {} : { lineage: currentAccount.lineage }),
      })
      this.notifyStatus()
    } catch {
      // Best-effort backfill: a missing email never blocks account listing.
    }
  }

  private async accountForRecord(record: AntigravityAuthRecord): Promise<CachedAccount | undefined> {
    const accounts = await this.accountStore.read()
    return accounts.accounts.find(account => account.refreshToken === record.refreshToken
      && account.projectId === record.projectId
      && (account.lineage === undefined || account.lineage === record.lineage))
  }

  private async bindCredentialMutation(): Promise<CredentialMutationBinding> {
    const record = await this.readRecord()
    const account = record === undefined ? undefined : await this.accountForRecord(record)
    return {
      record,
      onCleared: async () => {
        this.quota.invalidate()
        if (account !== undefined) await this.accountStore.removeAccount(account.id, account)
        if (record !== undefined) await this.gates.clear(gateSubject(record))
      },
    }
  }

  async switchAccount(idOrEmailOrIndex: string): Promise<{
    ok: boolean
    message: string
    account?: CachedAccount
  }> {
    if (this.disposed) throw new OAuthFlowError('internal', 'The Antigravity login is unavailable')
    const account = await this.accountStore.setActive(idOrEmailOrIndex)
    if (account === undefined) {
      return { ok: false, message: `未找到匹配的 Antigravity 账号 "${idOrEmailOrIndex}"` }
    }
    const maskedAccountEmail = maskEmail(account.email)
    const draft = {
      refreshToken: account.refreshToken,
      projectId: account.projectId,
      ...(maskedAccountEmail === undefined ? {} : { email: maskedAccountEmail }),
      ...(account.lineage === undefined ? {} : { lineage: account.lineage }),
    }
    const committed = await this.store.commit(draft)
    this.quota.invalidate()
    this.credentials.resetCache()
    if (this.autoActivate) {
      await this.autoActivateGates(committed.lineage ?? 'legacy-account')
    }
    this.notifyStatus()
    return {
      ok: true,
      message: `已切换至账号: ${account.email ?? account.maskedEmail ?? account.id} (项目: ${account.projectId})`,
      account,
    }
  }

  async removeAccount(idOrEmailOrIndex: string): Promise<{ ok: boolean; message: string }> {
    if (this.disposed) throw new OAuthFlowError('internal', 'The Antigravity login is unavailable')
    const removed = await this.accountStore.removeAccount(idOrEmailOrIndex)
    if (removed === undefined) {
      return { ok: false, message: `未找到匹配的 Antigravity 账号 "${idOrEmailOrIndex}"` }
    }
    const current = await this.accountStore.read()
    if (current.activeId !== undefined) {
      await this.switchAccount(current.activeId)
    } else {
      await this.logout()
    }
    this.notifyStatus()
    return { ok: true, message: `已移除账号: ${removed.email ?? removed.maskedEmail ?? removed.id}` }
  }

  async status(): Promise<AntigravityStatusView> {
    const record = await this.readRecord()
    const flowStatus = this.flow.status()
    const phase = flowStatus.phase === 'idle' && record !== undefined ? 'success' : flowStatus.phase
    const maskedEmail = maskEmail(record?.email)
    const credentialStatus = await this.credentials.status()
    const gateEvidence = await this.gateEvidenceFor(record)
    const login: LoginStatusView = {
      phase,
      configured: record !== undefined,
      projectAvailable: record?.projectId !== undefined,
      ...(flowStatus.authorizationUrl === undefined ? {} : { authorizationUrl: flowStatus.authorizationUrl }),
      ...(flowStatus.expiresAt === undefined ? {} : { expiresAt: flowStatus.expiresAt }),
      ...(maskedEmail === undefined ? {} : { maskedEmail }),
      ...(flowStatus.errorCode === undefined ? {} : { errorCode: flowStatus.errorCode }),
    }
    return createStatusView(this.riskAcknowledged, login, credentialStatus, this.credentials.revokeStatus(), gateEvidence)
  }

  async acknowledgeRisk(): Promise<RiskAcknowledgementResult> {
    this.riskAcknowledged = true
    this.notifyStatus()
    return { acknowledged: true }
  }

  /** Observe value-safe gate changes so capability rows can register without polling secrets. */
  watchStatus(listener: () => void): () => void {
    this.statusListeners.add(listener)
    return () => { this.statusListeners.delete(listener) }
  }

  async recordGate0(outcome: CapabilityGateOutcome): Promise<void> {
    const subject = gateSubject(await this.requireRecord())
    await this.gates.recordGate0(subject, outcome)
    this.notifyStatus()
  }

  async recordLlmFamilyGate(family: LlmFamilyId, outcome: CapabilityGateOutcome): Promise<void> {
    const record = await this.requireRecord()
    const subject = gateSubject(record)
    await this.gates.recordLlmFamily(subject, family, outcome)
    this.notifyStatus()
  }

  async recordCapabilityGate(id: CapabilityRowId, outcome: CapabilityGateOutcome): Promise<void> {
    const record = await this.requireRecord()
    const subject = gateSubject(record)
    if (id === 'auth-llm') {
      throw new OAuthFlowError('internal', 'Auth/LLM availability is derived from independent family evidence')
    }
    await this.gates.recordCapability(subject, id, outcome)
    this.notifyStatus()
  }

  async capabilityGateEvidence(): Promise<CapabilityGateEvidence> {
    return this.gateEvidenceFor(await this.readRecord())
  }

  async gate0Passed(): Promise<boolean> {
    return (await this.capabilityGateEvidence()).gate0?.outcome === 'passed'
  }

  async capabilityAvailable(id: CapabilityRowId): Promise<boolean> {
    const status = await this.status()
    return status.capabilities.some(capability => capability.id === id && capability.state === 'available')
  }

  async startLogin(): Promise<LoginStartResult> {
    if (this.disposed) throw new OAuthFlowError('internal', 'The Antigravity login is unavailable')
    if (!this.riskAcknowledged) {
      throw new OAuthFlowError('risk-acknowledgement-required', 'Risk acknowledgement is required before login')
    }
    const started = await this.flow.start()
    this.activeFlowGeneration = this.flow.generation()
    this.notifyStatus()
    return started
  }

  async completeCallback(callbackUrl: string): Promise<OAuthFlowCompletionResult> {
    if (this.disposed) throw new OAuthFlowError('internal', 'The Antigravity login is unavailable')
    try {
      return await this.flow.completeCallbackUrl(callbackUrl)
    } finally {
      this.notifyStatus()
    }
  }

  async cancelLogin(): Promise<LoginActionResult> {
    const status = await this.flow.cancel()
    if (status.phase !== 'success') this.activeFlowGeneration = 0
    this.notifyStatus()
    return {
      phase: status.phase,
      ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
    }
  }

  async credential(signal?: AbortSignal, options?: { readonly forceRefresh?: boolean }): Promise<HostCredential | undefined> {
    return await this.credentials.credential(signal, options)
  }

  async usage(signal?: AbortSignal, force = false): Promise<import('./quota.ts').QuotaStatusView> {
    return await this.quota.refresh(signal, force)
  }

  async logout(): Promise<import('./credential-coordinator.ts').LogoutResult> {
    if (this.disposed) throw new OAuthFlowError('internal', 'The Antigravity login is unavailable')
    this.activeFlowGeneration = 0
    try {
      const binding = await this.bindCredentialMutation()
      await this.flow.cancel()
      const result = await this.credentials.logout(binding)
      this.notifyStatus()
      return result
    } catch {
      throw new OAuthFlowError('persistence-failed', 'The local Antigravity credential could not be cleared')
    }
  }

  async revoke(confirmed: boolean, signal?: AbortSignal): Promise<import('./credential-coordinator.ts').RevokeActionResult> {
    if (this.disposed) throw new OAuthFlowError('internal', 'The Antigravity login is unavailable')
    const binding = confirmed ? await this.bindCredentialMutation() : undefined
    const result = await this.credentials.revoke(confirmed, signal, binding)
    this.notifyStatus()
    return result
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.activeFlowGeneration = 0
    this.statusListeners.clear()
    await Promise.all([this.flow.dispose(), this.credentials.dispose(), this.quota.dispose()])
  }

  private async commitCredential(token: OAuthToken, project: ProjectValidation, signal: AbortSignal): Promise<void> {
    const flowGeneration = this.flow.generation()
    if (this.disposed || flowGeneration !== this.activeFlowGeneration || signal.aborted) {
      throw new OAuthFlowError('cancelled', 'The OAuth login was cancelled')
    }
    const current = await this.readRecord()
    if (this.disposed || flowGeneration !== this.activeFlowGeneration || signal.aborted) {
      throw new OAuthFlowError('cancelled', 'The OAuth login was cancelled')
    }
    const rawEmail = project.email ?? token.email
      ?? (this.fetchEmail === undefined
        ? undefined
        : await this.fetchEmail(token.accessToken).catch(() => undefined))
    const email = maskEmail(rawEmail)
    const draft = {
      refreshToken: token.refreshToken,
      projectId: project.projectId,
      ...(email === undefined ? {} : { email }),
    }
    const committed = await this.store.compareAndCommit(current?.revision ?? 0, draft, current?.lineage)
    if (committed === undefined) throw new OAuthFlowError('credential-conflict', 'The login changed while it was completing')
    this.quota.invalidate()
    await this.accountStore.saveAccount({
      projectId: project.projectId,
      refreshToken: token.refreshToken,
      updatedAt: committed.updatedAt,
      ...(rawEmail === undefined ? {} : { email: rawEmail }),
      ...(committed.lineage === undefined ? {} : { lineage: committed.lineage }),
    }).catch(() => {})
    if (this.autoActivate) {
      const subject = committed.lineage ?? 'legacy-account'
      await this.autoActivateGates(subject)
    } else {
      // The lineage fence makes prior evidence unusable atomically with this commit.
      // Physical cleanup is best-effort: a stale file cannot authorize the new lineage.
      await this.gates.clear().catch(() => {})
    }
    // The persistent compare-and-commit is the linearization point. A later abort
    // cannot turn a committed replacement into a reported failed login.
    this.credentials.replaceFromLogin({
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      projectId: project.projectId,
    }, committed)
    // The browser redirect commits through the flow's loopback listener, which
    // never reaches the public completeCallback wrapper. Publish the committed
    // credential here so capability lifecycles register the LLM/search/image/
    // video routes without a Host restart.
    this.notifyStatus()
  }

  private notifyStatus(): void {
    for (const listener of this.statusListeners) {
      try { listener() } catch { /* observer failures cannot change auth state */ }
    }
  }

  private async gateEvidenceFor(record: AntigravityAuthRecord | undefined): Promise<CapabilityGateEvidence> {
    try {
      const evidence = await this.gates.read()
      if (record === undefined) return {}
      const subject = gateSubject(record)
      if (evidence.subject === subject) return evidence

      if (this.autoActivate && record.projectId !== undefined) {
        await this.autoActivateGates(subject)
        return await this.gates.read()
      }
      return {}
    } catch {
      return { gate0: { outcome: 'protocol-drift', checkedAt: new Date().toISOString() } }
    }
  }

  private async autoActivateGates(subject: string): Promise<void> {
    try {
      await this.gates.recordGate0(subject, 'passed')
      await this.gates.recordLlmFamily(subject, 'gemini', 'passed')
      await this.gates.recordLlmFamily(subject, 'claude', 'passed')
      await this.gates.recordLlmFamily(subject, 'gpt-oss', 'passed')
      await this.gates.recordCapability(subject, 'search', 'passed')
      await this.gates.recordCapability(subject, 'image', 'passed')
      await this.gates.recordCapability(subject, 'video', 'passed')
    } catch {
      // Best-effort auto-activation
    }
  }

  private async requireRecord(): Promise<AntigravityAuthRecord> {
    const record = await this.readRecord()
    if (record === undefined) throw new OAuthFlowError('internal', 'Antigravity login is required')
    return record
  }

  private async readRecord(): Promise<AntigravityAuthRecord | undefined> {
    try {
      return await this.store.read()
    } catch {
      throw new OAuthFlowError('persistence-failed', 'The Antigravity auth store could not be read')
    }
  }
}

function gateSubject(record: AntigravityAuthRecord): string {
  return record.lineage ?? 'legacy-account'
}

export function createAntigravityAuthService(options: AntigravityAuthServiceOptions = {}): AntigravityAuthService {
  return new AntigravityAuthService(options)
}

export function maskEmail(value: string | undefined): string | undefined {
  if (!isBoundedSafeText(value, 4096)) return undefined
  const at = value.indexOf('@')
  if (at <= 0 || at === value.length - 1) return undefined
  const local = value.slice(0, at)
  const domain = value.slice(at + 1)
  if (!/^[^\s@]+$/u.test(local) || !/^[^\s@]+$/u.test(domain)) return undefined
  return `${local.slice(0, 1)}***@${domain}`
}
