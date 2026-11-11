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
