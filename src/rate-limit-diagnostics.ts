/** Lossy, allowlisted diagnostics only. Never expose upstream prose or metadata. */
export const RATE_LIMIT_MESSAGE = 'Antigravity request was rate-limited (HTTP 429); this does not by itself mean the displayed weekly quota is exhausted'
const MAX_BYTES = 16 * 1024
const MAX_READ_MS = 1_000
const MAX_CHUNKS = 1024
const MAX_RETRY_SECONDS = 24 * 60 * 60
const REASONS = ['RATE_LIMIT_EXCEEDED', 'QUOTA_EXCEEDED', 'MODEL_CAPACITY_EXHAUSTED'] as const
export interface RateLimitDiagnostics {
  readonly status?: 'RESOURCE_EXHAUSTED'
  readonly reasons?: readonly (typeof REASONS)[number][]
  readonly quotaViolation?: true
  readonly retryAfterSeconds?: number
}

/** Hints are advisory only; callers must not automatically replay the request. */
export async function readRateLimitDiagnostics(response: Response, signal?: AbortSignal, now = Date.now()): Promise<RateLimitDiagnostics> {
  const headerDelay = parseRetryAfter(response.headers.get('retry-after'), now)
  const result: RateLimitDiagnostics = headerDelay === undefined ? {} : { retryAfterSeconds: headerDelay }
  if (signal?.aborted === true) {
    void response.body?.cancel().catch(() => {})
    return result
  }
  if (response.body === null) return result
  const reader = response.body.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeAbort: (() => void) | undefined
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('diagnostic timeout')), MAX_READ_MS)
    const abort = (): void => reject(new Error('diagnostic cancelled'))
    signal?.addEventListener('abort', abort, { once: true })
    removeAbort = () => signal?.removeEventListener('abort', abort)
  })
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    let count = 0
    for (;;) {
      const chunk = await Promise.race([reader.read(), stop])
      if (chunk.done) break
      if (++count > MAX_CHUNKS) return result
      size += chunk.value.byteLength
      if (size > MAX_BYTES) return result
      chunks.push(chunk.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!isRecord(parsed) || !isRecord(parsed.error)) return result
    const error = parsed.error
    const reasons: (typeof REASONS)[number][] = []
    let quotaViolation = false
    let delay = headerDelay
    if (Array.isArray(error.details)) {
      for (const detail of error.details.slice(0, 16)) {
        if (!isRecord(detail)) continue
        if (detail['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo') {
          for (const reason of REASONS) {
            if (detail.reason === reason && !reasons.includes(reason)) reasons.push(reason)
          }
        }
        if (detail['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure' && Array.isArray(detail.violations) && detail.violations.length > 0) quotaViolation = true
        if (detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo') {
          const next = parseRetryDuration(detail.retryDelay)
          if (next !== undefined) delay = Math.max(delay ?? 0, next)
        }
      }
    }
    return {
      ...(error.status === 'RESOURCE_EXHAUSTED' ? { status: 'RESOURCE_EXHAUSTED' } : {}),
      ...(reasons.length === 0 ? {} : { reasons }),
      ...(quotaViolation ? { quotaViolation: true } : {}),
      ...(delay === undefined ? {} : { retryAfterSeconds: delay }),
    }
  } catch {
    // Malformed, oversized, stalled or cancelled diagnostics never replace 429.
    return result
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    removeAbort?.()
    // A broken underlying cancellation must not hold the user's turn open.
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function rateLimitMessage(diagnostics: RateLimitDiagnostics): string {
  const hints: string[] = []
  if (diagnostics.status !== undefined) hints.push(`status=${diagnostics.status}`)
  if (diagnostics.reasons !== undefined) hints.push(`reason=${diagnostics.reasons.join(',')}`)
  if (diagnostics.quotaViolation === true) hints.push('quotaViolation=true')
  if (diagnostics.retryAfterSeconds !== undefined) hints.push(`retryAfterSeconds=${String(diagnostics.retryAfterSeconds)}`)
  return hints.length === 0 ? RATE_LIMIT_MESSAGE : `${RATE_LIMIT_MESSAGE}; provider hints: ${hints.join('; ')}`
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null || value.length > 64) return undefined
  if (/^\d{1,8}$/u.test(value)) return boundedDelay(Number(value))
  // Only the standard HTTP-date form, not permissive Date.parse inputs.
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value)) return undefined
  const date = Date.parse(value)
  if (!Number.isFinite(date) || new Date(date).toUTCString() !== value) return undefined
  return boundedDelay((date - now) / 1000)
}

function parseRetryDuration(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{1,8}(?:\.\d{1,9})?s$/u.test(value)) return undefined
  return boundedDelay(Number(value.slice(0, -1)))
}

function boundedDelay(seconds: number): number | undefined {
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_RETRY_SECONDS ? Math.ceil(seconds) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
