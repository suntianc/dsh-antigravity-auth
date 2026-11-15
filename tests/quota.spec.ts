import { describe, expect, it, vi } from 'vitest'
import { createQuotaService, normalizeQuotaResponse } from '../src/quota.ts'
import { ANTIGRAVITY_WIRE_ORIGIN } from '../src/wire-identity.ts'

const reset = '2030-01-01T00:00:00.000Z'

describe('Antigravity quota', () => {
  it('normalizes windowed provider groups and discards unknown fields', () => {
    const result = normalizeQuotaResponse({
      groups: [
        {
          displayName: 'Gemini',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.25, resetTime: reset, secret: 'discard' },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.75, resetTime: reset },
          ],
        },
        { displayName: 'Claude', buckets: [{ bucketId: 'claude-5h', window: '5h', remainingFraction: 0.5, resetTime: reset }] },
      ],
    }, Date.parse('2029-01-01T00:00:00.000Z'))
    expect(result).toEqual({
      state: 'available',
      checkedAt: '2029-01-01T00:00:00.000Z',
      groups: [
        { group: 'gemini', modelCount: 0, windows: [{ window: '5h', remainingFraction: 0.25, resetTime: reset }, { window: 'weekly', remainingFraction: 0.75, resetTime: reset }] },
        { group: 'non-gemini', modelCount: 0, windows: [{ window: '5h', remainingFraction: 0.5, resetTime: reset }] },
      ],
    })
    expect(JSON.stringify(result)).not.toMatch(/secret|bucketId|displayName/u)
  })

  it('keeps the Gemini 4 Argon weekly pool separate from the shared Gemini pool', () => {
    const result = normalizeQuotaResponse({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 1, resetTime: reset },
            { bucketId: 'gemini-argon-wtu-weekly', displayName: 'Gemini 4 Argon Weekly Limit', window: 'weekly', remainingFraction: 0.94, resetTime: reset },
          ],
        },
      ],
    }, Date.parse('2029-01-01T00:00:00.000Z'))
    expect(result.groups).toEqual([
      { group: 'gemini', modelCount: 0, windows: [{ window: 'weekly', remainingFraction: 1, resetTime: reset }] },
      { group: 'gemini-argon', modelCount: 0, windows: [{ window: 'weekly', remainingFraction: 0.94, resetTime: reset }] },
    ])
  })

  it('keeps Carbon and Hydrogen on the shared Gemini pool', () => {
    const result = normalizeQuotaResponse({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.8, resetTime: reset },
            { bucketId: 'gemini-4-hydrogen-weekly', displayName: 'Gemini 4 Hydrogen Weekly Limit', window: 'weekly', remainingFraction: 0.7, resetTime: reset },
          ],
        },
      ],
    }, Date.parse('2029-01-01T00:00:00.000Z'))
    // Carbon and Hydrogen are metered by the ordinary Gemini pool, so their
    // buckets merge into one group instead of claiming a separate limit.
    expect(result.groups).toEqual([
      { group: 'gemini', modelCount: 0, windows: [{ window: 'weekly', remainingFraction: 0.7, resetTime: reset }] },
    ])
  })

  it('coalesces refreshes, enforces the minimum interval, and keeps errors value-safe', async () => {
    const now = vi.fn(() => 1_900_000_000_000)
    const request = vi.fn(async input => {
      expect(input.url).toBe(`${ANTIGRAVITY_WIRE_ORIGIN}/v1internal:retrieveUserQuotaSummary`)
      expect(input.body).toContain('project-id')
      return new Response(JSON.stringify({ groups: [{ displayName: 'Gemini', buckets: [{ window: '5h', remainingFraction: 1, resetTime: reset }] }] }))
    })
    const service = createQuotaService({
      auth: { credential: vi.fn(async () => ({ accessToken: 'secret', refreshToken: 'refresh', expiresAt: Date.parse(reset), projectId: 'project-id' })) },
      transport: { request },
      now,
    })
    const [first, second] = await Promise.all([service.refresh(), service.refresh()])
    expect(first).toEqual(second)
    expect(request).toHaveBeenCalledOnce()
    await expect(service.refresh()).resolves.toEqual(first)
    expect(request).toHaveBeenCalledOnce()
    await service.dispose()
  })
})

function quotaResponse(fraction: number): Response {
  return new Response(JSON.stringify({ groups: [{ displayName: 'Gemini', buckets: [{ window: 'weekly', remainingFraction: fraction, resetTime: reset }] }] }))
}

function account(name: string) {
  return { accessToken: `access-${name}`, refreshToken: `refresh-${name}`, expiresAt: Date.parse(reset), projectId: `project-${name}` }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('account-bound quota snapshots', () => {
  it('does not reuse account A quota for account B inside the throttle window', async () => {
    let active = account('A')
    const request = vi.fn(async () => quotaResponse(active.projectId === 'project-A' ? 1 : 0.2))
    const service = createQuotaService({ auth: { credential: async () => active }, transport: { request } })
    expect((await service.refresh()).groups?.[0]?.windows[0]?.remainingFraction).toBe(1)
    active = account('B')
    expect((await service.refresh()).groups?.[0]?.windows[0]?.remainingFraction).toBe(0.2)
    expect(request).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(service.status())).not.toMatch(/access-|refresh-|project-/u)
    await service.dispose()
  })

  it('invalidates synchronously and fences an old result even if transport ignores abort', async () => {
    let active = account('A')
    const oldResponse = deferred<Response>()
    const newResponse = deferred<Response>()
    const request = vi.fn(async input => input.accessToken === 'access-A' ? await oldResponse.promise : await newResponse.promise)
    const service = createQuotaService({ auth: { credential: async () => active }, transport: { request } })
    const old = service.refresh()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    active = account('B')
    service.invalidate()
    expect(service.status()).toEqual({ state: 'unauthenticated' })
    const fresh = service.refresh()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    await expect(old).resolves.toEqual({ state: 'unauthenticated' })
    oldResponse.resolve(quotaResponse(1))
    const shared = service.refresh(undefined, true)
    newResponse.resolve(quotaResponse(0.2))
    expect((await fresh).groups?.[0]?.windows[0]?.remainingFraction).toBe(0.2)
    expect(await shared).toEqual(service.status())
    expect(request).toHaveBeenCalledTimes(2)
    await service.dispose()
  })

  it('fences stale credential lookups across explicit invalidation', async () => {
    const lookup = deferred<ReturnType<typeof account>>()
    const credential = vi.fn().mockReturnValueOnce(lookup.promise).mockResolvedValue(account('B'))
    const request = vi.fn(async () => quotaResponse(0.2))
    const service = createQuotaService({ auth: { credential }, transport: { request } })
    const old = service.refresh()
    service.invalidate()
    const fresh = await service.refresh()
    lookup.resolve(account('A'))
    expect(await old).toEqual(fresh)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(expect.objectContaining({accessToken: 'access-B'}))
    await service.dispose()
  })

  it('clears snapshots on logout and allows bounded disposal of an uncooperative request', async () => {
    let active: ReturnType<typeof account> | undefined = account('A')
    const hanging = deferred<Response>()
    const request = vi.fn().mockResolvedValueOnce(quotaResponse(1)).mockReturnValue(hanging.promise)
    const service = createQuotaService({ auth: { credential: async () => active }, transport: { request } })
    await service.refresh()
    active = undefined
    expect(await service.refresh()).toEqual({ state: 'unauthenticated' })
    active = account('B')
    const pending = service.refresh()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    await service.dispose()
    expect(await pending).toEqual({ state: 'unauthenticated' })
    hanging.resolve(quotaResponse(1))
    expect(service.status()).toEqual({ state: 'unauthenticated' })
  })
})


it.each(['resolved', 'rejected'] as const)('ignores an older %s credential lookup after a newer account snapshot', async outcome => {
  let resolve!: (value: ReturnType<typeof account>) => void
  let reject!: (error: Error) => void
  const pendingCredential = new Promise<ReturnType<typeof account>>((done, fail) => { resolve = done; reject = fail })
  const credential = vi.fn().mockReturnValueOnce(pendingCredential).mockResolvedValue(account('B'))
  const request = vi.fn(async () => quotaResponse(0.2))
  const service = createQuotaService({auth: {credential}, transport: {request}})
  const old = service.refresh()
  const fresh = await service.refresh()
  if (outcome === 'resolved') resolve(account('A'))
  else reject(new Error('obsolete lookup failure'))
  expect(await old).toEqual(fresh)
  expect(service.status()).toEqual(fresh)
  expect(request).toHaveBeenCalledTimes(1)
  expect(request).toHaveBeenCalledWith(expect.objectContaining({accessToken: 'access-B'}))
  await service.dispose()
})
