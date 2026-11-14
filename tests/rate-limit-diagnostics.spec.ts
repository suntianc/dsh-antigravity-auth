import { afterEach, describe, expect, it, vi } from 'vitest'
import { AntigravityAdapter, ANTIGRAVITY_PROVIDER } from '../src/llm-adapter.ts'
import { RATE_LIMIT_MESSAGE, readRateLimitDiagnostics } from '../src/rate-limit-diagnostics.ts'
import LlmRuntime, { type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'

const input: GenerateOptions = {
  provider: ANTIGRAVITY_PROVIDER,
  model: 'antigravity-gemini-3.8-flash',
  messages: [{ id: 'test' as never, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }],
}
function fixture(response: Response) {
  const request = vi.fn(async () => response)
  const adapter = new AntigravityAdapter({
    auth: { credential: async () => ({ accessToken: 'test-token', refreshToken: 'test-refresh', projectId: 'test-project', expiresAt: Date.parse('2030-01-01') }) },
    transport: { request },
  })
  const run = async (options = input) => { for await (const _chunk of adapter.stream(options)) { /* drain */ } }
  return { request, run }
}
const json = (error: unknown, headers?: HeadersInit) => new Response(JSON.stringify({ error }), { status: 429, ...(headers === undefined ? {} : { headers }) })

afterEach(() => vi.useRealTimers())

describe('rate-limit diagnostics', () => {
  it('retains only allowlisted facts, never upstream message, metadata or identifiers', async () => {
    const secret = 'secret-token-project-url'
    const response = json({
      status: 'RESOURCE_EXHAUSTED', message: secret,
      details: [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED', domain: secret, metadata: { model: secret, consumer: secret } },
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: secret },
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ subject: secret, description: secret }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1.25s' },
      ],
    }, { 'Retry-After': '3' })
    const { request, run } = fixture(response)
    const error: unknown = await run().catch(error => error)
    expect(error).toMatchObject({ code: 'RATE_LIMIT', failure: { status: 429, providerRetryAfterMs: 3000 } })
    expect((error as Error).message).toBe(`${RATE_LIMIT_MESSAGE}; provider hints: status=RESOURCE_EXHAUSTED; reason=RATE_LIMIT_EXCEEDED; quotaViolation=true; retryAfterSeconds=3`)
    expect(JSON.stringify(error) + String(error)).not.toContain(secret)
    expect(request).toHaveBeenCalledOnce()
  })

  it.each(['', '<html>secret</html>', '{', JSON.stringify({ error: { status: 'secret', message: 'secret', details: [{ reason: 'QUOTA_EXCEEDED' }] } })])('keeps an unknown or malformed response neutral: %s', async body => {
    const { request, run } = fixture(new Response(body, { status: 429 }))
    await expect(run()).rejects.toMatchObject({ code: 'RATE_LIMIT', message: RATE_LIMIT_MESSAGE })
    expect(request).toHaveBeenCalledOnce()
  })

  it('bounds response bytes and retains a valid header hint', async () => {
    const response = json({ status: 'RESOURCE_EXHAUSTED', message: 'secret'.repeat(4000) }, { 'Retry-After': '5' })
    await expect(readRateLimitDiagnostics(response)).resolves.toEqual({ retryAfterSeconds: 5 })
  })

  it('returns promptly even if an upstream body and its cancellation never settle', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const response = new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}), cancel }), { status: 429 })
    const result = readRateLimitDiagnostics(response)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(result).resolves.toEqual({})
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('honors cancellation without retrying or exposing the body', async () => {
    const controller = new AbortController()
    const { request, run } = fixture(new Response(new ReadableStream<Uint8Array>(), { status: 429 }))
    const result = run({ ...input, signal: controller.signal })
    // Allow dispatch to reach the bounded body reader before cancellation.
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    const assertion = expect(result).rejects.toMatchObject({ code: 'CANCELLED' })
    controller.abort()
    await assertion
    expect(request).toHaveBeenCalledOnce()
  })

  it('preserves the disabled provider retry policy even with diagnostic delays', () => {
    const adapter = new AntigravityAdapter({ auth: { credential: async () => undefined } })
    expect(adapter.providerRetryPolicy()).toMatchObject({ mode: 'normal', maxRetries: 0 })
  })

  it('does not retry a provider capacity hint on 429', async () => {
    const { request, run } = fixture(json({ details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'MODEL_CAPACITY_EXHAUSTED' }] }))
    await expect(run()).rejects.toMatchObject({ code: 'RATE_LIMIT', message: `${RATE_LIMIT_MESSAGE}; provider hints: reason=MODEL_CAPACITY_EXHAUSTED` })
    expect(request).toHaveBeenCalledOnce()
  })

  it.each(['-1', '1.2', 'Infinity', 'NaN', '86401', '9999999999999999999', 'tomorrow', '2026-11-14', 'secret'])('rejects unsafe Retry-After %s', async value => {
    await expect(readRateLimitDiagnostics(json({}, { 'Retry-After': value }))).resolves.toEqual({})
  })

  it('accepts a strict future HTTP date and rejects expired dates', async () => {
    const now = Date.parse('2026-11-14T12:00:00Z')
    await expect(readRateLimitDiagnostics(json({}, { 'Retry-After': 'Sat, 14 Nov 2026 12:00:30 GMT' }), undefined, now)).resolves.toEqual({ retryAfterSeconds: 30 })
    await expect(readRateLimitDiagnostics(json({}, { 'Retry-After': 'Sat, 14 Nov 2026 11:59:59 GMT' }), undefined, now)).resolves.toEqual({})
  })

  it.each(['-1s', '86401s', 'NaNs', 'secret', { seconds: 1 }, 1])('rejects invalid RetryInfo %j', async retryDelay => {
    await expect(readRateLimitDiagnostics(json({ details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] }))).resolves.toEqual({})
  })

  it('bounds empty chunks even when they continuously starve the timeout timer', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array()) }, cancel,
    }), { status: 429 })
    await expect(readRateLimitDiagnostics(response)).resolves.toEqual({})
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body?.locked).toBe(false)
  })

  it('preserves safe retry hints through the public runtime without resending', async () => {
    const ctx = new Context()
    const request = vi.fn(async () => json({
      status: 'RESOURCE_EXHAUSTED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2s' }],
    }))
    try {
      const runtime = new LlmRuntime(ctx)
      runtime.registerAdapter([ANTIGRAVITY_PROVIDER], new AntigravityAdapter({
        auth: { credential: async () => ({ accessToken: 'test-token', refreshToken: 'test-refresh', projectId: 'test-project', expiresAt: Date.parse('2030-01-01') }) },
        transport: { request },
      }))
      const chunks = []
      for await (const chunk of runtime.stream(input)) chunks.push(chunk)
      expect(chunks).toEqual([expect.objectContaining({
        type: 'finish',
        reason: { kind: 'error', failure: expect.objectContaining({ code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 2000 }) },
      })])
      expect(request).toHaveBeenCalledOnce()
      expect(runtime.providerRetryPolicy(ANTIGRAVITY_PROVIDER)).toMatchObject({ mode: 'normal', maxRetries: 0 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not treat provider prose as evidence or echo an unknown status', async () => {
    await expect(readRateLimitDiagnostics(json({
      status: 'SECRET_TOKEN', message: 'QUOTA_EXCEEDED MODEL_CAPACITY_EXHAUSTED',
      details: [{ '@type': 'unrecognized', reason: 'QUOTA_EXCEEDED' }],
    }))).resolves.toEqual({})
  })

  it('limits the number of structured details inspected', async () => {
    await expect(readRateLimitDiagnostics(json({ details: [
      ...Array.from({ length: 16 }, () => ({})),
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'QUOTA_EXCEEDED' },
    ] }))).resolves.toEqual({})
  })

  it('does not pass a zero delay into the positive-only LLM error field', async () => {
    const { run } = fixture(json({}, { 'Retry-After': '0' }))
    const error: unknown = await run().catch(error => error)
    expect(error).toMatchObject({ code: 'RATE_LIMIT', failure: { status: 429 } })
    expect(error).not.toHaveProperty('failure.providerRetryAfterMs')
    expect((error as Error).message).toContain('retryAfterSeconds=0')
  })

  it('rounds fractional seconds up and uses the longest valid hint', async () => {
    await expect(readRateLimitDiagnostics(json({ details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3.1s' }] }, { 'Retry-After': '1' }))).resolves.toEqual({ retryAfterSeconds: 4 })
  })
})
