/** Offline request audit and regression tests; not live-service acceptance. */
import { describe, expect, it, vi } from 'vitest'
import { resolveModelWithTier } from '@cortexkit/antigravity-auth-core'
import { AntigravitySearchProvider, buildGroundedSearchPayload } from '../src/search.ts'
import { createWireIdentity } from '../src/wire-identity.ts'
import { ANTIGRAVITY_SEARCH_ENDPOINT } from '../src/search.ts'

const credential = { accessToken: 'offline-token', refreshToken: 'offline-refresh', expiresAt: 1_900_000_000_000, projectId: 'offline-project' }
const groundingMetadata = { groundingChunks: [{ web: { uri: 'https://example.com/' } }] }
const fixture = (body: unknown, status = 200) => {
  const request = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  const provider = new AntigravitySearchProvider({ auth: { credential: async () => credential }, transport: { request } })
  return { request, provider }
}

describe('issue #44 request audit (current behavior, no private calls)', () => {
  it('resolves 3.8 to Antigravity medium with a 4000-token thinking budget', () => {
    expect(resolveModelWithTier('antigravity-gemini-3.8-flash')).toMatchObject({ actualModel: 'gemini-3.8-flash-medium', thinkingBudget: 4000, tier: 'medium', isThinkingModel: true })
  })
  it('resolves Gemini 4 Argon tiers to their wire routes without a thinking budget', () => {
    expect(resolveModelWithTier('antigravity-gemini-4-argon')).toMatchObject({ actualModel: 'gemini-4-argon-medium', thinkingLevel: 'medium', tier: 'medium' })
    expect(resolveModelWithTier('antigravity-gemini-4-argon-high')).toMatchObject({ actualModel: 'gemini-4-argon-high', thinkingLevel: 'high' })
    expect(resolveModelWithTier('antigravity-gemini-4-argon-low')).not.toHaveProperty('thinkingBudget')
  })
  it('documents the minimal envelope and omitted generation/agent metadata', () => {
    const payload = buildGroundedSearchPayload('query', credential)
    expect(Object.keys(payload)).toEqual(['project', 'model', 'request'])
    expect(payload.request).toMatchObject({ tools: [{ googleSearch: {} }] })
    expect(payload.request).not.toHaveProperty('generationConfig')
    expect(payload.request).not.toHaveProperty('sessionId')
  })
  it('serializes the 3.8 payload through the real allowlisted wire without local rejection', () => {
    const bytes = createWireIdentity().serialize(ANTIGRAVITY_SEARCH_ENDPOINT, { authorization: 'Bearer offline-token', body: JSON.stringify(buildGroundedSearchPayload('query', credential)) })
    const wire = new TextDecoder().decode(bytes)
    expect(wire).toContain('POST /v1internal:generateContent HTTP/1.1')
    expect(wire).toContain('Authorization: Bearer offline-token')
    expect(wire).toContain('X-DeepSeek-Harness-Attribution:')
    expect(wire).toContain('gemini-3.8-flash-medium')
  })
  it.each([[401, 'ANTIGRAVITY_SEARCH_AUTH_REQUIRED'], [403, 'ANTIGRAVITY_SEARCH_FORBIDDEN'], [429, 'ANTIGRAVITY_SEARCH_RATE_LIMITED']] as const)('classifies HTTP %s with no retry', async (status, code) => {
    const { provider, request } = fixture({ error: { message: 'private detail' } }, status)
    await expect(provider.search({ query: 'query' })).rejects.toMatchObject({ code })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it.each([
    [{ error: { code: 403, message: 'private detail' } }, 'ANTIGRAVITY_SEARCH_FORBIDDEN'],
    [{ response: { error: { code: 401 } } }, 'ANTIGRAVITY_SEARCH_AUTH_REQUIRED'],
    [{ response: { error: { status: 'RESOURCE_EXHAUSTED' } } }, 'ANTIGRAVITY_SEARCH_RATE_LIMITED'],
    [{ error: { code: 400 } }, 'ANTIGRAVITY_SEARCH_PROTOCOL_DRIFT'],
    [{ error: { code: 500 } }, 'ANTIGRAVITY_SEARCH_FAILED'],
    [{ error: { code: '403', status: 'private detail' } }, 'ANTIGRAVITY_SEARCH_FAILED'],
    [{ error: { code: 200, message: 'private detail' } }, 'ANTIGRAVITY_SEARCH_FAILED'],
    [{ error: 'private detail' }, 'ANTIGRAVITY_SEARCH_FAILED'],
    [{ error: false }, 'ANTIGRAVITY_SEARCH_FAILED'],
    [{ response: { promptFeedback: { blockReason: 'SAFETY' } } }, 'ANTIGRAVITY_SEARCH_BLOCKED'],
    [{ response: { candidates: [{ finishReason: 'SAFETY', groundingMetadata }] } }, 'ANTIGRAVITY_SEARCH_BLOCKED'],
    [{ response: { candidates: [{ finish_reason: 'RECITATION' }] } }, 'ANTIGRAVITY_SEARCH_BLOCKED'],
  ])('classifies embedded errors and blocks without exposing provider data', async (body, code) => {
    const { provider, request } = fixture(body)
    const error = await provider.search({ query: 'query' }).catch((error: unknown) => error)
    expect(error).toMatchObject({ code })
    expect(String(error)).not.toContain('private detail')
    expect(JSON.stringify(error)).not.toContain('private detail')
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('collects normal candidates/content JSON text once', async () => {
    const { provider } = fixture({ response: { candidates: [{ content: { parts: [{ text: 'answer' }] }, groundingMetadata }] } })
    await expect(provider.search({ query: 'query' })).resolves.toMatchObject({ content: 'answer', sources: [{ url: 'https://example.com/' }] })
  })
  it('rejects embedded errors even when grounding sources are also present', async () => {
    const { provider } = fixture({ error: { code: 403 }, response: { groundingMetadata } })
    await expect(provider.search({ query: 'query' })).rejects.toMatchObject({ code: 'ANTIGRAVITY_SEARCH_FORBIDDEN' })
  })
  it('does not mistake STOP, null error or unspecified blocking for a refusal', async () => {
    const { provider } = fixture({ error: null, response: { promptFeedback: { blockReason: 'BLOCK_REASON_UNSPECIFIED' }, candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'answer' }] }, groundingMetadata }] } })
    await expect(provider.search({ query: 'query' })).resolves.toMatchObject({ content: 'answer' })
  })
  it('does not return earlier grounded SSE content when a later frame reports failure', async () => {
    const request = vi.fn(async () => new Response(`data: ${JSON.stringify({ response: { groundingMetadata } })}\n\ndata: ${JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'private detail' } })}\n\n`))
    const provider = new AntigravitySearchProvider({ auth: { credential: async () => credential }, transport: { request } })
    await expect(provider.search({ query: 'query' })).rejects.toMatchObject({ code: 'ANTIGRAVITY_SEARCH_FORBIDDEN' })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('fails before transport when credentials are unavailable', async () => {
    const request = vi.fn()
    const provider = new AntigravitySearchProvider({ auth: { credential: async () => undefined }, transport: { request } })
    await expect(provider.search({ query: 'query' })).rejects.toMatchObject({ code: 'ANTIGRAVITY_SEARCH_AUTH_REQUIRED' })
    expect(request).not.toHaveBeenCalled()
  })
  it.each(['line one\nline two', 'line one\r\nline two', 'column one\tcolumn two', 'line one\rline two'])('preserves normal answer whitespace: %j', async text => {
    const { provider } = fixture({ response: { candidates: [{ content: { parts: [{ text }] }, groundingMetadata }] } })
    await expect(provider.search({ query: 'query' })).resolves.toMatchObject({ content: text })
  })
  it.each([...Array.from({ length: 32 }, (_, code) => code).filter(code => ![9, 10, 13].includes(code)), 127])('still rejects answer parts containing control character %i', async code => {
    const { provider } = fixture({ response: { candidates: [{ content: { parts: [{ text: `unsafe${String.fromCharCode(code)}text` }, { text: 'safe answer' }] }, groundingMetadata }] } })
    await expect(provider.search({ query: 'query' })).resolves.toMatchObject({ content: 'safe answer' })
  })
  it('keeps URL/title/snippet validation strict while preserving body Markdown', async () => {
    const { provider } = fixture({ response: { candidates: [{ content: { parts: [{ text: '# Title\n\n- first\n- second\tvalue' }] }, groundingMetadata: { groundingChunks: [
      { web: { uri: 'https://example.com/', title: 'bad\ntitle', snippet: 'bad\tsnippet' } },
      { web: { uri: 'https://example.com/a\nb' } },
    ] } }] } })
    await expect(provider.search({ query: 'query' })).resolves.toEqual({ content: '# Title\n\n- first\n- second\tvalue', sources: [{ url: 'https://example.com/' }], truncated: false })
  })

})
