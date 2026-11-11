/** Single-account Antigravity quota normalization and bounded Host service. */

import {
  ANTIGRAVITY_WIRE_ORIGIN,
} from './wire-identity.ts'
import type { CredentialCoordinator, HostCredential } from './credential-coordinator.ts'
import {
  DEFAULT_PRIVATE_RESPONSE_BYTES,
  PrivateTransportError,
  createPrivateTransport,
  privateStatusError,
  readPrivateText,
  type PrivateTransport,
  type PrivateTransportOptions,
} from './private-transport.ts'
import { classifyPrivateFailure, type PrivateFailureKind } from './private-failure.ts'

export const ANTIGRAVITY_QUOTA_ENDPOINT = `${ANTIGRAVITY_WIRE_ORIGIN}/v1internal:retrieveUserQuotaSummary` as const
export const QUOTA_REFRESH_MIN_INTERVAL_MS = 30_000

export type QuotaState = 'available' | 'unauthenticated' | 'forbidden' | 'rate-limited' | 'offline' | 'timeout' | 'protocol-drift'
export type QuotaWindowKind = '5h' | 'weekly'
/**
 * Gemini 4 Argon is metered by its own weekly pool (`gemini-argon-wtu-weekly`
 * upstream) instead of the shared Gemini pool, so it must stay a distinct group
 * or its usage is reported against the wrong limit.
 */
export type QuotaGroupKind = 'gemini' | 'gemini-argon' | 'non-gemini'

export interface QuotaWindowView {
  readonly window: QuotaWindowKind
  readonly remainingFraction: number
  readonly resetTime: string
}

export interface QuotaGroupView {
  readonly group: QuotaGroupKind
  readonly modelCount: number
  readonly windows: readonly QuotaWindowView[]
}

export interface QuotaStatusView {
  readonly state: QuotaState
  readonly checkedAt?: string
  readonly groups?: readonly QuotaGroupView[]
}

export interface QuotaService {
  refresh(signal?: AbortSignal, force?: boolean): Promise<QuotaStatusView>
  status(): QuotaStatusView
  dispose(): Promise<void>
}

export interface QuotaServiceOptions {
  readonly auth: Pick<CredentialCoordinator, 'credential'> | { credential(signal?: AbortSignal): Promise<HostCredential | undefined> }
  readonly transport?: PrivateTransport
  readonly transportOptions?: PrivateTransportOptions
  readonly now?: () => number
  readonly minIntervalMs?: number
}

/** Normalize only validated, display-safe quota facts from a provider response. */
export function normalizeQuotaResponse(value: unknown, now = Date.now()): QuotaStatusView {
  const groups: QuotaGroupView[] = []
  const sourceValue = isRecord(value) && isRecord(value.response) ? value.response : value
  const source = isRecord(sourceValue) ? sourceValue : undefined
  const candidates = source === undefined ? [] : [
    ...(Array.isArray(source.groups) ? source.groups : []),
    ...(Array.isArray(source.buckets) ? source.buckets : []),
    ...(Array.isArray(source.quotaBuckets) ? source.quotaBuckets : []),
    ...(Array.isArray(source.quota_buckets) ? source.quota_buckets : []),
    ...(Array.isArray(source.userQuotaSummary) ? source.userQuotaSummary : []),
    ...(Array.isArray(source.quotas) ? source.quotas : []),
  ]
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue
    const buckets = Array.isArray(candidate.buckets)
      ? candidate.buckets
      : Array.isArray(candidate.quotaBuckets)
        ? candidate.quotaBuckets
        : Array.isArray(candidate.windows)
          ? candidate.windows
          : [candidate]
    for (const rawBucket of buckets) {
      if (!isRecord(rawBucket)) continue
      const window = identifyWindow(rawBucket)
      const resetTime = normalizeResetTime(rawBucket.resetTime ?? rawBucket.reset_time ?? rawBucket.resetAt ?? rawBucket.reset_at, now)
      const fraction = normalizeFraction(rawBucket.remainingFraction ?? rawBucket.remaining_fraction ?? rawBucket.fraction ?? rawBucket.remaining ?? rawBucket.remaining_percent ?? rawBucket.percentage)
      if (window === undefined || resetTime === undefined || fraction === undefined) continue
      const group = identifyGroup(candidate, rawBucket)
      if (group === undefined) continue
      const modelCount = boundedCount(candidate.modelCount ?? candidate.model_count ?? candidate.models ?? descriptionModelCount(candidate.description))
      const existing = groups.find(item => item.group === group)
      if (existing === undefined) groups.push({ group, modelCount, windows: [{ window, remainingFraction: fraction, resetTime }] })
      else if (!existing.windows.some(item => item.window === window)) {
        const updated: QuotaGroupView = {
          group,
          modelCount: Math.max(existing.modelCount, modelCount),
          windows: [...existing.windows, { window, remainingFraction: fraction, resetTime }].sort(windowOrder),
        }
        groups.splice(groups.indexOf(existing), 1, updated)
      } else {
        const updatedWindows = existing.windows.map(item => item.window === window
          ? { window, remainingFraction: Math.min(item.remainingFraction, fraction), resetTime: item.resetTime }
          : item)
        const updated: QuotaGroupView = {
          group,
          modelCount: Math.max(existing.modelCount, modelCount),
          windows: updatedWindows.sort(windowOrder),
        }
        groups.splice(groups.indexOf(existing), 1, updated)
      }
    }
  }
  if (groups.length === 0) {
    if (isRecord(source)) {
      return { state: 'available', checkedAt: new Date(now).toISOString(), groups: [] }
    }
    throw new QuotaNormalizationError('The quota response did not contain recognized windows')
  }
  return { state: 'available', checkedAt: new Date(now).toISOString(), groups: groups.sort((left, right) => left.group.localeCompare(right.group)) }
}

export class QuotaNormalizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuotaNormalizationError'
  }
}

export function createQuotaService(options: QuotaServiceOptions): QuotaService {
  const now = options.now ?? (() => Date.now())
  const minInterval = positive(options.minIntervalMs, QUOTA_REFRESH_MIN_INTERVAL_MS)
  const transport = options.transport ?? createPrivateTransport({
    ...(options.transportOptions?.responseHeaderTimeoutMs === undefined ? {} : { responseHeaderTimeoutMs: options.transportOptions.responseHeaderTimeoutMs }),
    ...(options.transportOptions?.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.transportOptions.maxRequestBytes }),
  })
  let current: QuotaStatusView = { state: 'unauthenticated' }
  let checkedAt = 0
  let inFlight: Promise<QuotaStatusView> | undefined
  let inFlightAbort: (() => void) | undefined
  const lifecycleController = new AbortController()
  let disposed = false

  return {
    refresh: async (signal, force = false) => {
      if (disposed) return current
      if (!force && checkedAt > 0 && now() - checkedAt < minInterval) return current
      if (inFlight !== undefined) return await waitForCaller(inFlight, signal)
      const combined = mergeAbortSignals(undefined, lifecycleController.signal)
      inFlightAbort = combined.dispose
      inFlight = refreshQuota(options.auth, transport, combined.signal, now).then(value => {
        current = value
        checkedAt = now()
        return value
      }).catch(error => {
        current = mapQuotaError(error, now())
        checkedAt = now()
        return current
      }).finally(() => { combined.dispose(); inFlightAbort = undefined; inFlight = undefined })
      return await waitForCaller(inFlight, signal)
    },
    status: () => current,
    dispose: async () => {
      disposed = true
      lifecycleController.abort()
      inFlightAbort?.()
      await inFlight?.catch(() => {})
    },
  }
}

async function refreshQuota(
  auth: QuotaServiceOptions['auth'],
  transport: PrivateTransport,
  signal: AbortSignal | undefined,
  now: () => number,
): Promise<QuotaStatusView> {
  const credential = await auth.credential(signal)
  if (credential === undefined) return { state: 'unauthenticated' }
  const body = credential.projectId ? { project: credential.projectId } : {}
  let response = await transport.request({
    url: ANTIGRAVITY_QUOTA_ENDPOINT,
    accessToken: credential.accessToken,
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
  if (response.status === 403 && credential.projectId) {
    try {
      const retryResponse = await transport.request({
        url: ANTIGRAVITY_QUOTA_ENDPOINT,
        accessToken: credential.accessToken,
        body: JSON.stringify({}),
        ...(signal === undefined ? {} : { signal }),
      })
      if (retryResponse.ok) {
        response = retryResponse
      }
    } catch {
      // Fall through
    }
  }
  const statusError = privateStatusError(response.status)
  if (statusError !== undefined) {
    await response.body?.cancel().catch(() => {})
    throw statusError
  }
  let value: unknown
  try {
    value = JSON.parse(await readPrivateText(response, { ...(signal === undefined ? {} : { signal }), maxBytes: DEFAULT_PRIVATE_RESPONSE_BYTES })) as unknown
  } catch (error) {
    if (error instanceof PrivateTransportError) throw error
    throw new QuotaNormalizationError('The quota response was not valid JSON')
  }
  return normalizeQuotaResponse(value, now())
}

const QUOTA_FAILURE_STATES: Readonly<Record<PrivateFailureKind, QuotaState>> = {
  authentication: 'unauthenticated',
  forbidden: 'forbidden',
  'rate-limited': 'rate-limited',
  cancelled: 'offline',
  timeout: 'timeout',
  'attribution-rejected': 'protocol-drift',
  'protocol-drift': 'protocol-drift',
  'response-limit': 'protocol-drift',
  'request-limit': 'protocol-drift',
  upstream: 'offline',
  network: 'offline',
  failed: 'offline',
}

function mapQuotaError(error: unknown, checkedAt: number): QuotaStatusView {
  const state: QuotaState = error instanceof PrivateTransportError
    ? QUOTA_FAILURE_STATES[classifyPrivateFailure(error)]
    : error instanceof QuotaNormalizationError ? 'protocol-drift' : 'offline'
  return { state, checkedAt: new Date(checkedAt).toISOString() }
}

function identifyWindow(value: Record<string, unknown>): QuotaWindowKind | undefined {
  const raw = String(value.window ?? value.windowType ?? value.window_type ?? value.bucketId ?? value.bucket_id ?? '').toLowerCase()
  if (raw.includes('5h') || raw.includes('5-hour') || raw.includes('five')) return '5h'
  if (raw.includes('week') || raw.includes('weekly') || raw.includes('7d')) return 'weekly'
  const seconds = numberValue(value.durationSeconds ?? value.duration_seconds)
  if (seconds !== undefined) {
    if (seconds <= 5 * 60 * 60) return '5h'
    if (seconds <= 8 * 24 * 60 * 60) return 'weekly'
  }
  return undefined
}

function identifyGroup(candidate: Record<string, unknown>, bucket?: Record<string, unknown>): QuotaGroupKind | undefined {
  const raw = [
    candidate.displayName,
    candidate.group,
    candidate.quotaGroup,
    candidate.quota_group,
    candidate.modelFamily,
    candidate.title,
    candidate.name,
    candidate.description,
    bucket?.bucketId,
    bucket?.bucket_id,
    bucket?.displayName,
  ].filter(Boolean).map(String).join(' ').toLowerCase()
  // Argon must win over the generic `gemini` fallback: its bucket id is
  // `gemini-argon-wtu-weekly`, which would otherwise be read as the Gemini pool.
  if (raw.includes('argon')) return 'gemini-argon'
  if (raw.includes('3p') || raw.includes('non') || raw.includes('claude') || raw.includes('gpt') || raw.includes('openai') || raw.includes('anthropic') || raw.includes('third-party') || raw.includes('external')) return 'non-gemini'
  if (raw.includes('gemini') || raw.includes('google') || raw.includes('chat') || raw.includes('code') || raw.includes('default') || raw.length === 0) return 'gemini'
  return 'gemini'
}

function normalizeFraction(value: unknown): number | undefined {
  const number = numberValue(value)
  if (number === undefined) return undefined
  if (number >= 0 && number <= 1) return number
  if (number <= 100) return number / 100
  return undefined
}

function normalizeResetTime(value: unknown, now: number): string | undefined {
  const parsed = typeof value === 'number' ? value < 10_000_000_000 ? value * 1000 : value : typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100_000_000_000_000) return undefined
  const iso = new Date(parsed).toISOString()
  return Number.isFinite(Date.parse(iso)) && parsed >= now - 365 * 24 * 60 * 60 * 1000 ? iso : undefined
}

function boundedCount(value: unknown): number {
  if (Array.isArray(value)) return Math.min(value.length, 10_000)
  const number = numberValue(value)
  return number === undefined ? 0 : Math.min(Math.floor(number), 10_000)
}

function descriptionModelCount(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16 * 1024) return 0
  if (!/^[^:]{1,256}:\s*/u.test(value)) return 0
  const payload = value.replace(/^[^:]{1,256}:\s*/u, '')
  return Math.min(payload.split(',').map(item => item.trim()).filter(item => item.length > 0).length, 10_000)
}

function windowOrder(left: QuotaWindowView, right: QuotaWindowView): number {
  return left.window === right.window ? 0 : left.window === '5h' ? -1 : 1
}

function positive(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : Math.min(Math.floor(value), 24 * 60 * 60 * 1000)
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

async function waitForCaller<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await promise
  if (signal.aborted) throw new PrivateTransportError('cancelled', 'The quota request was cancelled', { accepted: false })
  let remove: (() => void) | undefined
  const cancellation = new Promise<never>((_, reject) => {
    const abort = (): void => reject(new PrivateTransportError('cancelled', 'The quota request was cancelled', { accepted: false }))
    remove = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([promise, cancellation])
  } finally {
    remove?.()
  }
}

function mergeAbortSignals(first: AbortSignal | undefined, second: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const abort = (event: Event): void => { if (!controller.signal.aborted) controller.abort((event.target as AbortSignal).reason) }
  const signals = first === undefined ? [second] : [first, second]
  for (const signal of signals) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', abort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose: () => { for (const signal of signals) signal.removeEventListener('abort', abort) },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
