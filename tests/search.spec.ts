import { describe, expect, it, vi } from 'vitest'
import { AntigravitySearchProvider, apply, buildGroundedSearchPayload } from '../src/search.ts'
import { createStatusView } from '../src/status.ts'

const auth = { credential: vi.fn(async () => ({ accessToken: 'secret', refreshToken: 'refresh', expiresAt: Date.parse('2030-01-01T00:00:00.000Z'), projectId: 'project-id' })) }

describe('grounded Antigravity Search', () => {
  it('returns only validated HTTP grounding sources and bounded content', async () => {
    const transport = {
      request: vi.fn(async () => new Response('data: {"response":{"parts":[{"text":"answer"}],"groundingMetadata":{"groundingChunks":[{"web":{"uri":"https://example.com/a","title":"A","snippet":"snippet"}},{"web":{"uri":"file:///secret"}}]}}}\n\ndata: [DONE]\n\n')),
    }
    const provider = new AntigravitySearchProvider({ auth, transport })
    await expect(provider.search({ query: 'latest release', maxResults: 5 })).resolves.toEqual({
      content: 'answer',
      sources: [{ url: 'https://example.com/a', title: 'A', snippet: 'snippet' }],
      truncated: false,
    })
    expect(buildGroundedSearchPayload('query', { projectId: 'project-id' })).not.toHaveProperty('accessToken')
  })

  it('fails closed when the provider returns no sources or the capability is disabled', async () => {
    const transport = { request: vi.fn(async () => new Response('{"response":{"parts":[{"text":"answer"}]}}')) }
    const empty = new AntigravitySearchProvider({ auth, transport })
    await expect(empty.search({ query: 'query' })).rejects.toMatchObject({ code: 'ANTIGRAVITY_SEARCH_NO_SOURCES' })
    const disabled = new AntigravitySearchProvider({ auth, enabled: () => false, transport })
    await expect(disabled.search({ query: 'query' })).rejects.toMatchObject({ code: 'ANTIGRAVITY_SEARCH_DISABLED' })
  })

  describe('provider registration lifecycle and searchProviderId restoration', () => {
    it.each([
      { name: 'an explicit deepseek-official selection', initialSearchProviderId: 'deepseek-official', selectedProviderId: 'deepseek-official' },
      { name: 'automatic provider selection', initialSearchProviderId: undefined, selectedProviderId: 'antigravity' },
    ])('preserves $name while the capability is unavailable and restores it on logout/disable', async ({ initialSearchProviderId, selectedProviderId }) => {
      let statusListener: (() => void) | undefined
      let unregisterFn = vi.fn()
      const registerSearchProvider = vi.fn(() => unregisterFn)
      const statusFor = (available: boolean) => available
        ? createStatusView(true, { phase: 'success', configured: true, projectAvailable: true }, undefined, undefined, {
          gate0: { outcome: 'passed', checkedAt: '2030-01-01T00:00:00.000Z' },
          capabilities: { search: { outcome: 'passed', checkedAt: '2030-01-01T00:00:00.000Z' } },
        })
        : createStatusView(true, { phase: 'idle', configured: false, projectAvailable: false })
      const mockAuth = {
        credential: vi.fn(),
        status: vi.fn(async () => statusFor(false)),
        watchStatus: vi.fn((listener: () => void) => { statusListener = listener; return vi.fn() }),
        dispose: vi.fn(),
      }

      const webObj: { searchProviderId?: string; registerSearchProvider: typeof registerSearchProvider } = {
        ...(initialSearchProviderId === undefined ? {} : { searchProviderId: initialSearchProviderId }),
        registerSearchProvider,
      }

      let volatileListener: (() => void) | undefined
      const ctx = {
        web: webObj,
        get: vi.fn(() => mockAuth),
        inject: vi.fn(),
        on: vi.fn((event: string, fn: () => void) => {
          if (event === 'loader/volatile-update') volatileListener = fn
          return vi.fn()
        }),
        effect: vi.fn((setup: () => () => Promise<void>) => setup()),
      }

      const config = { enabled: true, model: 'antigravity-gemini-3.7-flash', maxResults: 10 }
      apply(ctx as never, config as never)

      // 1. Initial unauthenticated state: Search provider is not registered and the selection is untouched.
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(registerSearchProvider).not.toHaveBeenCalled()
      expect(webObj.searchProviderId).toBe(initialSearchProviderId)

      // 2. Login succeeds: gate becomes available -> select only when DSH was in automatic mode.
      mockAuth.status.mockResolvedValueOnce(statusFor(true))
      statusListener?.()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(registerSearchProvider).toHaveBeenCalledOnce()
      expect(webObj.searchProviderId).toBe(selectedProviderId)

      // 3. User logs out: gate returns to poc-pending -> unregisters and restores the prior selection.
      mockAuth.status.mockResolvedValueOnce(statusFor(false))
      statusListener?.()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(unregisterFn).toHaveBeenCalledOnce()
      expect(webObj.searchProviderId).toBe(initialSearchProviderId)

      // 4. Re-login: becomes available again -> re-registers without overriding explicit selection.
      unregisterFn = vi.fn()
      mockAuth.status.mockResolvedValueOnce(statusFor(true))
      statusListener?.()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(registerSearchProvider).toHaveBeenCalledTimes(2)
      expect(webObj.searchProviderId).toBe(selectedProviderId)

      // 5. User disables search in settings: unregisters and restores the prior selection.
      config.enabled = false
      volatileListener?.()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(unregisterFn).toHaveBeenCalledOnce()
      expect(webObj.searchProviderId).toBe(initialSearchProviderId)
    })
  })
})
