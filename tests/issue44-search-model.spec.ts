import { describe, expect, it, vi } from 'vitest'
import { liveValue } from '../src/volatile-config.ts'
import { ANTIGRAVITY_SEARCH_MODEL, AntigravitySearchProvider, Config, buildGroundedSearchPayload } from '../src/search.ts'

const credential = { accessToken: 'offline-token', refreshToken: 'offline-refresh', expiresAt: 1_900_000_000_000, projectId: 'offline-project' }
const groundedResponse = () => new Response('data: {"response":{"parts":[{"text":"offline answer"}],"groundingMetadata":{"groundingChunks":[{"web":{"uri":"https://example.com/","title":"Fixture"}}]}}}\n\ndata: [DONE]\n\n')

describe('issue #44 search model regression (offline fixtures only)', () => {
  it('defaults the schema and payload to the current 3.8 Flash route', () => {
    expect(ANTIGRAVITY_SEARCH_MODEL).toBe('antigravity-gemini-3.8-flash')
    expect(liveValue(Config({} as Config).model)).toBe('antigravity-gemini-3.8-flash')
    expect(buildGroundedSearchPayload('offline query', credential).model).toBe('gemini-3.8-flash-medium')
  })

  it.each([
    ['antigravity-gemini-3.8-flash', 'gemini-3.8-flash-medium'],
    ['antigravity-gemini-3.8-flash', 'gemini-3.8-flash-medium'],
  ])('preserves explicit model %s', (model, actual) => {
    expect(buildGroundedSearchPayload('offline query', credential, model).model).toBe(actual)
  })

  it('sends the current default when settings are omitted', async () => {
    const request = vi.fn(async () => groundedResponse())
    const provider = new AntigravitySearchProvider({ auth: { credential: async () => credential }, transport: { request } })
    await expect(provider.search({ query: 'offline query' })).resolves.toMatchObject({ sources: [{ url: 'https://example.com/' }] })
    const sent = request.mock.calls[0] as unknown as [{ body: string }]
    expect(JSON.parse(sent[0].body).model).toBe('gemini-3.8-flash-medium')
  })

  it('reads a changed explicit model without replacing the provider', async () => {
    let model = 'antigravity-gemini-3.8-flash'
    const request = vi.fn(async () => groundedResponse())
    const provider = new AntigravitySearchProvider({
      auth: { credential: async () => credential }, transport: { request },
      settings: () => ({ enabled: true, model, maxResults: 10 }),
    })
    await provider.search({ query: 'offline query' })
    model = 'antigravity-gemini-3.8-flash'
    await provider.search({ query: 'offline query' })
    const calls = request.mock.calls as unknown as [{ body: string }][]
    expect(calls.map(([sent]) => JSON.parse(sent.body).model)).toEqual(['gemini-3.8-flash-medium', 'gemini-3.8-flash-medium'])
  })

  it.each([[400, 'ANTIGRAVITY_SEARCH_PROTOCOL_DRIFT'], [404, 'ANTIGRAVITY_SEARCH_PROTOCOL_DRIFT'], [500, 'ANTIGRAVITY_SEARCH_FAILED']] as const)('redacts HTTP %s without silently switching models', async (status, code) => {
    const request = vi.fn(async () => new Response('private upstream response must never escape', { status }))
    const provider = new AntigravitySearchProvider({ auth: { credential: async () => credential }, transport: { request } })
    const error = await provider.search({ query: 'offline query' }).catch((error: unknown) => error)
    expect(error).toMatchObject({ message: 'The Antigravity Search request failed safely', code })
    expect(request).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(error)).not.toContain('private upstream response')
  })
})
