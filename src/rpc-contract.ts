/** Browser-safe, value-free RPC contract for the Antigravity login flow. */

import type { ConnectionRpcResult as RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { CAPABILITY_ROW_IDS } from './status.ts'
import type {
  AntigravityStatusView,
  CapabilityGateReasonCode,
  CapabilityGateState,
  CapabilityRowId,
  LoginActionResult,
  LoginPhase,
  LoginStartResult,
  LoginStatusView,
  RiskAcknowledgementResult,
} from './status.ts'
import { isLoginErrorCode, isLoginPhase } from './login-types.ts'
import type { CredentialErrorCode, CredentialState, CredentialStatusView, RevokeActionResult, RevokeErrorCode, RevokeState, RevokeStatusView } from './credential-coordinator.ts'
import type { QuotaGroupView, QuotaState, QuotaStatusView, QuotaWindowKind } from './quota.ts'
import {
  ANTIGRAVITY_MODEL_CATALOG_STATES,
  type AntigravityModelAvailability,
  type AntigravityModelCatalogView,
} from './model-catalog.ts'
import { isSafeRpcErrorCode, safeRpcErrorMessage } from './rpc-vocabulary.ts'
import { isBoundedSafeText } from './safe-text.ts'

export const ANTIGRAVITY_AUTH_RPC_CHANNEL = '/api'
export const ANTIGRAVITY_AUTH_RPC_NAMESPACE = 'antigravity-auth' as const

export interface AntigravityAuthRpcClient {
  status(signal?: AbortSignal): Promise<RpcResult<{ status: AntigravityStatusView }>>
  acknowledgeRisk(signal?: AbortSignal): Promise<RpcResult<RiskAcknowledgementResult>>
  login(signal?: AbortSignal): Promise<RpcResult<LoginStartResult>>
  cancelLogin(signal?: AbortSignal): Promise<RpcResult<LoginActionResult>>
  logout(signal?: AbortSignal): Promise<RpcResult<{ state: 'logged-out' }>>
  revoke(signal?: AbortSignal): Promise<RpcResult<RevokeActionResult>>
  models(signal?: AbortSignal, force?: boolean): Promise<RpcResult<AntigravityModelCatalogView>>
  usage?(signal?: AbortSignal, force?: boolean): Promise<RpcResult<QuotaStatusView>>
}

export interface AntigravityAuthConnectionRpc {
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<RpcResult<unknown>>
}

/** Build the browser face over the plugin-owned guarded account channel. */
export function createAntigravityAuthRpcClient(rpc: AntigravityAuthConnectionRpc): AntigravityAuthRpcClient {
  return {
    status: signal => callValidated(rpc, 'status', {}, signal, value => {
      const status = parseStatusResult(value)
      return status === undefined ? undefined : { status }
    }),
    acknowledgeRisk: signal => callValidated(rpc, 'acknowledge-risk', { acknowledge: true }, signal, parseAcknowledgementResult),
    login: signal => callValidated(rpc, 'login', {}, signal, parseLoginResult),
    cancelLogin: signal => callValidated(rpc, 'cancel', {}, signal, parseActionResult),
    logout: signal => callValidated(rpc, 'logout', {}, signal, parseLogoutResult),
    revoke: signal => callValidated(rpc, 'revoke', { confirmed: true }, signal, parseRevokeResult),
    models: (signal, force = false) => callValidated(rpc, 'models', { force }, signal, parseModelCatalogResult),
    usage: (signal, force = false) => callValidated(rpc, 'usage', { force }, signal, parseUsageResult),
  }
}

async function callValidated<T>(
  rpc: AntigravityAuthConnectionRpc,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal | undefined,
  parse: (value: unknown) => T | undefined,
): Promise<RpcResult<T>> {
  let result: RpcResult<unknown>
  try {
    result = await rpc.call(ANTIGRAVITY_AUTH_RPC_CHANNEL, `${ANTIGRAVITY_AUTH_RPC_NAMESPACE}/${endpoint}`, payload, signal)
  } catch {
    return invalidResponse(endpoint)
  }
  if (!result.ok) return sanitizeFailure(result, endpoint)
  const value = parse(result.value)
  return value === undefined ? invalidResponse(endpoint) : { ok: true, value }
}

function sanitizeFailure(result: Extract<RpcResult<unknown>, { readonly ok: false }>, endpoint: string): RpcResult<never> {
  const error: unknown = result.error
  if (!isRecord(error)
    || !hasExactKeys(error, ['code', 'message', 'details'])
    || !isSafeRpcErrorCode(error.code)
    || typeof error.message !== 'string'
    || !isBoundedSafeText(error.message, 512)
    || !isSafeErrorDetails(error.details)) return invalidResponse(endpoint)
  return {
    ok: false,
    error: {
      code: error.code as never,
      message: safeRpcErrorMessage(error.code),
      details: {},
    },
  }
}

function isSafeErrorDetails(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (Object.keys(value).length === 0) return true
  return hasExactKeys(value, ['issues']) && Array.isArray(value.issues) && value.issues.length === 0
}

/** Parse a closed, value-safe advisory model catalog received by the browser. */
export function parseModelCatalogResult(value: unknown): AntigravityModelCatalogView | undefined {
  if (!isRecord(value)
    || !hasExactKeys(value, ['state', 'models', ...(value.checkedAt === undefined ? [] : ['checkedAt'])])
    || !ANTIGRAVITY_MODEL_CATALOG_STATES.includes(value.state as never)
    || !Array.isArray(value.models)
    || value.models.length === 0
    || value.models.length > 64
    || (value.checkedAt !== undefined && !isIsoTime(value.checkedAt))) return undefined
  const models: Array<{ id: string; name: string; state: AntigravityModelAvailability }> = []
  const ids = new Set<string>()
  for (const model of value.models) {
    if (!isRecord(model)
      || !hasExactKeys(model, ['id', 'name', 'state'])
      || !isBoundedSafeText(model.id, 256)
      || !isBoundedSafeText(model.name, 256)
      || (model.state !== 'snapshot' && model.state !== 'live-available' && model.state !== 'unavailable')
      || ids.has(model.id)) return undefined
    if (value.state === 'live-available' ? model.state === 'snapshot' : model.state !== 'snapshot') return undefined
    ids.add(model.id)
    models.push({ id: model.id, name: model.name, state: model.state })
  }
  return {
    state: value.state as AntigravityModelCatalogView['state'],
    models,
    ...(typeof value.checkedAt === 'string' ? { checkedAt: value.checkedAt } : {}),
  }
}

/** Parse a value-safe, normalized quota envelope received by the browser. */
export function parseUsageResult(value: unknown): QuotaStatusView | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['state', ...(value.checkedAt === undefined ? [] : ['checkedAt']), ...(value.groups === undefined ? [] : ['groups'])])) return undefined
  if (!isQuotaState(value.state)) return undefined
  if (value.checkedAt !== undefined && !isIsoTime(value.checkedAt)) return undefined
  if (value.state === 'available' && value.groups === undefined) return undefined
  if (value.groups !== undefined) {
    if (!Array.isArray(value.groups) || value.groups.length === 0 || value.groups.length > 2) return undefined
    const groups: QuotaGroupView[] = []
    const groupNames = new Set<string>()
    for (const rawGroup of value.groups) {
      if (!isRecord(rawGroup) || !hasExactKeys(rawGroup, ['group', 'modelCount', 'windows']) || (rawGroup.group !== 'gemini' && rawGroup.group !== 'non-gemini') || !Number.isSafeInteger(rawGroup.modelCount) || (rawGroup.modelCount as number) < 0 || !Array.isArray(rawGroup.windows)) return undefined
      if (groupNames.has(rawGroup.group)) return undefined
      groupNames.add(rawGroup.group)
      const modelCount = rawGroup.modelCount as number
      if (rawGroup.windows.length === 0 || rawGroup.windows.length > 2) return undefined
      const windows: Array<{ window: QuotaWindowKind; remainingFraction: number; resetTime: string }> = []
      const windowKinds = new Set<QuotaWindowKind>()
      for (const rawWindow of rawGroup.windows) {
        if (!isRecord(rawWindow) || !hasExactKeys(rawWindow, ['window', 'remainingFraction', 'resetTime']) || (rawWindow.window !== '5h' && rawWindow.window !== 'weekly') || windowKinds.has(rawWindow.window) || typeof rawWindow.remainingFraction !== 'number' || !Number.isFinite(rawWindow.remainingFraction) || rawWindow.remainingFraction < 0 || rawWindow.remainingFraction > 1 || !isIsoTime(rawWindow.resetTime)) return undefined
        windowKinds.add(rawWindow.window)
        windows.push({ window: rawWindow.window, remainingFraction: rawWindow.remainingFraction, resetTime: rawWindow.resetTime })
      }
      groups.push({ group: rawGroup.group, modelCount, windows })
    }
    return { state: value.state, ...(typeof value.checkedAt === 'string' ? { checkedAt: value.checkedAt } : {}), groups }
  }
  return { state: value.state, ...(typeof value.checkedAt === 'string' ? { checkedAt: value.checkedAt } : {}) }
}

/** Parse the closed status envelope received by the browser. */
export function parseStatusResult(value: unknown): AntigravityStatusView | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['status'])) return undefined
  return parseStatus(value.status)
}

function parseStatus(value: unknown): AntigravityStatusView | undefined {
  if (!isRecord(value)
    || !hasAllowedKeys(value, [
      'pluginId',
      'phase',
      'privateSelfUse',
      'singleAccount',
      'riskAcknowledgementRequired',
      'riskAcknowledged',
      'login',
      'credential',
      'revoke',
      'capabilities',
    ])
    || value.pluginId !== 'dsh-antigravity-auth'
    || value.phase !== 'bootstrap'
    || value.privateSelfUse !== true
    || value.singleAccount !== true
    || value.riskAcknowledgementRequired !== true
    || typeof value.riskAcknowledged !== 'boolean'
    || !Array.isArray(value.capabilities)) return undefined

  const login = parseLoginStatus(value.login)
  if (login === undefined) return undefined
  const credential = value.credential === undefined ? undefined : parseCredentialStatus(value.credential)
  if (value.credential !== undefined && credential === undefined) return undefined
  const revoke = value.revoke === undefined ? undefined : parseRevokeStatus(value.revoke)
  if (value.revoke !== undefined && revoke === undefined) return undefined
  const seen = new Set<string>()
  const capabilities: CapabilityGateStatus[] = []
  for (const capability of value.capabilities) {
    const parsed = parseCapability(capability)
    if (parsed === undefined || seen.has(parsed.id)) return undefined
    seen.add(parsed.id)
    capabilities.push(parsed)
  }
  if (seen.size !== CAPABILITY_ROW_IDS.length || CAPABILITY_ROW_IDS.some(id => !seen.has(id))) return undefined

  return {
    pluginId: 'dsh-antigravity-auth',
    phase: 'bootstrap',
    privateSelfUse: true,
    singleAccount: true,
    riskAcknowledgementRequired: true,
    riskAcknowledged: value.riskAcknowledged,
    login,
    ...(credential === undefined ? {} : { credential }),
    ...(revoke === undefined ? {} : { revoke }),
    capabilities,
  }
}

function parseCredentialStatus(value: unknown): CredentialStatusView | undefined {
  if (!isRecord(value)
    || typeof value.state !== 'string'
    || !isCredentialState(value.state)
    || typeof value.configured !== 'boolean'
    || !hasAllowedKeys(value, ['state', 'configured', 'expiresAt', 'lastRefreshAt', 'errorCode'])) return undefined
  if (value.expiresAt !== undefined && !isIsoTime(value.expiresAt)) return undefined
  if (value.lastRefreshAt !== undefined && !isIsoTime(value.lastRefreshAt)) return undefined
  if (value.errorCode !== undefined && (typeof value.errorCode !== 'string' || !isCredentialErrorCode(value.errorCode))) return undefined
  return {
    state: value.state,
    configured: value.configured,
    ...(typeof value.expiresAt === 'string' ? { expiresAt: value.expiresAt } : {}),
    ...(typeof value.lastRefreshAt === 'string' ? { lastRefreshAt: value.lastRefreshAt } : {}),
    ...(typeof value.errorCode === 'string' ? { errorCode: value.errorCode } : {}),
  }
}

function parseRevokeStatus(value: unknown): RevokeStatusView | undefined {
  if (!isRecord(value)
    || typeof value.state !== 'string'
    || !isRevokeState(value.state)
    || !hasAllowedKeys(value, ['state', 'errorCode'])) return undefined
  if (value.errorCode !== undefined && (typeof value.errorCode !== 'string' || !isRevokeErrorCode(value.errorCode))) return undefined
  return {
    state: value.state,
    ...(typeof value.errorCode === 'string' ? { errorCode: value.errorCode } : {}),
  }
}

function parseLoginStatus(value: unknown): LoginStatusView | undefined {
  if (!isRecord(value)
    || typeof value.phase !== 'string'
    || !isLoginPhase(value.phase)
    || typeof value.configured !== 'boolean'
    || typeof value.projectAvailable !== 'boolean') return undefined
  const allowed = ['phase', 'configured', 'projectAvailable', 'authorizationUrl', 'expiresAt', 'maskedEmail', 'errorCode']
  if (Object.keys(value).some(key => !allowed.includes(key))) return undefined
  if (value.authorizationUrl !== undefined && !isSafeAuthorizationUrl(value.authorizationUrl)) return undefined
  if (value.expiresAt !== undefined && !isIsoTime(value.expiresAt)) return undefined
  if (value.maskedEmail !== undefined && (typeof value.maskedEmail !== 'string' || !isMaskedEmail(value.maskedEmail))) return undefined
  if (value.errorCode !== undefined && !isLoginErrorCode(value.errorCode)) return undefined
  if (isErrorPhase(value.phase)
    ? typeof value.errorCode !== 'string'
    : value.errorCode !== undefined) return undefined
  if (value.phase === 'pending'
    ? typeof value.authorizationUrl !== 'string' || typeof value.expiresAt !== 'string'
    : value.authorizationUrl !== undefined) return undefined
  return {
    phase: value.phase,
    configured: value.configured,
    projectAvailable: value.projectAvailable,
    ...(typeof value.authorizationUrl === 'string' ? { authorizationUrl: value.authorizationUrl } : {}),
    ...(typeof value.expiresAt === 'string' ? { expiresAt: value.expiresAt } : {}),
    ...(typeof value.maskedEmail === 'string' ? { maskedEmail: value.maskedEmail } : {}),
    ...(typeof value.errorCode === 'string' ? { errorCode: value.errorCode } : {}),
  }
}

function parseCapability(value: unknown): CapabilityGateStatus | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'state', 'reasonCode'])) return undefined
  if (!isCapabilityRowId(value.id) || !isCapabilityGateState(value.state) || !isCapabilityReasonCode(value.reasonCode)) {
    return undefined
  }
  return { id: value.id, state: value.state, reasonCode: value.reasonCode }
}

function parseAcknowledgementResult(value: unknown): RiskAcknowledgementResult | undefined {
  return isRecord(value) && hasExactKeys(value, ['acknowledged']) && value.acknowledged === true
    ? { acknowledged: true }
    : undefined
}

function parseLoginResult(value: unknown): LoginStartResult | undefined {
  return isRecord(value)
    && hasExactKeys(value, ['started', 'phase', 'authorizationUrl', 'expiresAt'])
    && value.started === true
    && value.phase === 'pending'
    && isSafeAuthorizationUrl(value.authorizationUrl)
    && isIsoTime(value.expiresAt)
    ? {
        started: true,
        phase: 'pending',
        authorizationUrl: value.authorizationUrl,
        expiresAt: value.expiresAt,
      }
    : undefined
}

function parseActionResult(value: unknown): LoginActionResult | undefined {
  if (!isRecord(value) || typeof value.phase !== 'string' || !isLoginPhase(value.phase)) return undefined
  if (Object.keys(value).some(key => key !== 'phase' && key !== 'errorCode')) return undefined
  if (value.errorCode !== undefined && !isLoginErrorCode(value.errorCode)) return undefined
  return {
    phase: value.phase,
    ...(typeof value.errorCode === 'string' ? { errorCode: value.errorCode } : {}),
  }
}

function parseLogoutResult(value: unknown): { readonly state: 'logged-out' } | undefined {
  return isRecord(value) && hasExactKeys(value, ['state']) && value.state === 'logged-out'
    ? { state: 'logged-out' }
    : undefined
}

function parseRevokeResult(value: unknown): RevokeActionResult | undefined {
  if (!isRecord(value) || typeof value.state !== 'string') return undefined
  if (value.state === 'confirmation-required' || value.state === 'revoked' || value.state === 'logged-out' || value.state === 'superseded') {
    return hasExactKeys(value, ['state']) ? { state: value.state } : undefined
  }
  if (value.state === 'failed'
    && hasExactKeys(value, ['state', 'errorCode'])
    && typeof value.errorCode === 'string'
    && isRevokeErrorCode(value.errorCode)) {
    return { state: 'failed', errorCode: value.errorCode }
  }
  return undefined
}

function isSafeAuthorizationUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) return false
  try {
    const parsed = new URL(value)
    const allowed = new Set(['client_id', 'response_type', 'redirect_uri', 'scope', 'code_challenge', 'code_challenge_method', 'state', 'access_type', 'prompt'])
    for (const [key, parameter] of parsed.searchParams) {
      if (!allowed.has(key) || parsed.searchParams.getAll(key).length !== 1 || !isBoundedSafeText(parameter, 4096)) return false
    }
    const state = parsed.searchParams.get('state')
    const clientId = parsed.searchParams.get('client_id')
    const challenge = parsed.searchParams.get('code_challenge')
    const prompt = parsed.searchParams.get('prompt')
    return parsed.protocol === 'https:'
      && parsed.hostname === 'accounts.google.com'
      && parsed.port === ''
      && parsed.username === ''
      && parsed.password === ''
      && parsed.pathname === '/o/oauth2/v2/auth'
      && parsed.hash.length === 0
      && typeof state === 'string'
      && /^[A-Za-z0-9_-]{43}$/u.test(state)
      && (clientId === null || (clientId.length <= 256 && clientId.endsWith('.apps.googleusercontent.com')))
      && (challenge === null || /^[A-Za-z0-9_-]{43}$/u.test(challenge))
      && (parsed.searchParams.get('response_type') === null || parsed.searchParams.get('response_type') === 'code')
      && (parsed.searchParams.get('redirect_uri') === null || parsed.searchParams.get('redirect_uri') === 'http://localhost:51121/oauth-callback')
      && (parsed.searchParams.get('code_challenge_method') === null || parsed.searchParams.get('code_challenge_method') === 'S256')
      && (parsed.searchParams.get('access_type') === null || parsed.searchParams.get('access_type') === 'offline')
      && (prompt === null || prompt === 'consent' || prompt === 'select_account consent')
  } catch {
    return false
  }
}

function isMaskedEmail(value: string): boolean {
  return isBoundedSafeText(value, 256) && /^.[*]{3}[^@]*@[^@\s]+$/u.test(value)
}

function isErrorPhase(value: LoginPhase): boolean {
  return value === 'cancelled' || value === 'expired' || value === 'port-conflict' || value === 'failed'
}

function isQuotaState(value: unknown): value is QuotaState {
  return value === 'available' || value === 'unauthenticated' || value === 'forbidden' || value === 'rate-limited' || value === 'offline' || value === 'timeout' || value === 'protocol-drift'
}

function isIsoTime(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function isCapabilityRowId(value: unknown): value is CapabilityRowId {
  return typeof value === 'string' && CAPABILITY_ROW_IDS.includes(value as CapabilityRowId)
}

function isCapabilityGateState(value: unknown): value is CapabilityGateState {
  return value === 'available'
    || value === 'disabled'
    || value === 'poc-pending'
    || value === 'protocol-drift'
}

function isCapabilityReasonCode(value: unknown): value is CapabilityGateReasonCode {
  return value === 'gate-not-run'
    || value === 'project-unavailable'
    || value === 'capability-ready'
    || value === 'unauthenticated'
    || value === 'rate-limited'
    || value === 'cancelled'
    || value === 'gate-0-failed'
    || value === 'gate-failed'
    || value === 'unsupported-video'
    || value === 'protocol-drift'
}

function isCredentialState(value: unknown): value is CredentialState {
  return value === 'logged-out'
    || value === 'logged-in'
    || value === 'refreshing'
    || value === 'refresh-failed'
    || value === 're-login-required'
}

function isCredentialErrorCode(value: unknown): value is CredentialErrorCode {
  return value === 'invalid-grant'
    || value === 'network'
    || value === 'timeout'
    || value === 'rate-limited'
    || value === 'server-error'
    || value === 'http-error'
    || value === 'invalid-response'
    || value === 'conflict'
    || value === 'storage'
    || value === 'cancelled'
}

function isRevokeState(value: unknown): value is RevokeState {
  return value === 'idle'
    || value === 'pending'
    || value === 'confirmation-required'
    || value === 'revoked'
    || value === 'logged-out'
    || value === 'failed'
    || value === 'superseded'
}

function isRevokeErrorCode(value: unknown): value is RevokeErrorCode {
  return value === 'network'
    || value === 'timeout'
    || value === 'rate-limited'
    || value === 'server-error'
    || value === 'http-error'
    || value === 'invalid-response'
    || value === 'storage'
}

function hasAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index])
}

function invalidResponse(endpoint: string): RpcResult<never> {
  return {
    ok: false,
    error: {
      code: 'internal',
      message: `antigravity-auth: invalid ${endpoint} response from Host`,
      details: {},
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type CapabilityGateStatus = AntigravityStatusView['capabilities'][number]
