import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ReasoningEffortId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { ANTIGRAVITY_PROVIDER, AntigravityAdapter } from '../src/llm-adapter.ts'
import type { PrivateTransportRequest } from '../src/private-transport.ts'

const credential = { accessToken: 'offline-access', refreshToken: 'offline-refresh', projectId: 'offline-project', expiresAt: Date.parse('2030-01-01T00:00:00Z') }
const input = (model: string, effort: string): GenerateOptions => ({
  provider: ANTIGRAVITY_PROVIDER, model, reasoningEffort: ReasoningEffortId(effort),
  messages: [{ id: 'user-one' as never, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }],
})

it.each(['opus', 'sonnet'])('exposes Claude %s 5.5 efforts and sends the selected tier', async family => {
  const requests: Array<{ model: string; request: { labels: { model_enum: string } } }> = []
  const adapter = new AntigravityAdapter({ auth: { credential: async () => credential }, transport: { request: async (request: PrivateTransportRequest) => {
    requests.push(JSON.parse(String(request.body)))
    return new Response('data: {"response":{"parts":[{"text":"ok"}],"finishReason":"STOP"}}\n\n')
  } } })
  const ctx = new Context()
  try {
    const runtime = new LlmRuntime(ctx)
    runtime.registerAdapter([ANTIGRAVITY_PROVIDER], adapter)
    const model = `antigravity-claude-${family}-5-5`
    const info = await adapter.resolveModel(ANTIGRAVITY_PROVIDER, model)
    expect(info.reasoning?.defaultEffort).toBe('low')
    expect(info.reasoning?.efforts.map(item => item.id)).toEqual(['low', 'medium', 'high'])
    for (const effort of ['low', 'medium', 'high']) {
      for await (const _chunk of runtime.stream(input(model, effort))) { /* consume the complete public stream */ }
      expect(requests.at(-1)?.model).toBe(`claude-${family}-5-5-${effort}`)
      expect(requests.at(-1)?.request.labels.model_enum).toMatch(/^MODEL_PLACEHOLDER_M\d+$/u)
    }
    expect(new Set(requests.map(request => request.request.labels.model_enum)).size).toBe(3)
  } finally { await ctx.fiber.dispose() }
})

it.each([
  ['gemini-4-argon-tiered', 'antigravity-gemini-4-argon'],
  ['gemini-4-carbon-tiered', 'antigravity-gemini-4-carbon'],
  ['gemini-4-hydrogen-tiered', 'antigravity-gemini-4-hydrogen'],
  ['gemini-4-neon-high', 'antigravity-gemini-4-neon'],
  ['gemini-pro-orchestrator-neon', 'antigravity-gemini-pro-orchestrator-neon'],
  ['gemini-pro-orchestrator-g1-pro', 'antigravity-gemini-pro-orchestrator-g1-pro'],
  ['claude-opus-5-5', 'antigravity-claude-opus-5-5'],
  ['claude-sonnet-5-5-high', 'antigravity-claude-sonnet-5-5'],
])('admits the new live modelName %s behind a provider catalog key', async (wire, model) => {
  const adapter = new AntigravityAdapter({ auth: { credential: async () => credential }, transport: {
    request: vi.fn(async () => new Response(JSON.stringify({ models: { provider_model_key: { modelName: wire } } }))),
  } })
  expect((await adapter.listModels(ANTIGRAVITY_PROVIDER)).map(item => item.id)).toEqual([model])
})


it.each([
  'antigravity-gemini-3.5-flash', 'antigravity-gemini-3.6-flash', 'antigravity-gemini-3.7-flash',
  'antigravity-gemini-3.1-pro', 'antigravity-claude-opus-4-6-thinking', 'antigravity-claude-sonnet-4-6-thinking',
])('rejects retired route %s before credentials or transport', async model => {
  const auth = { credential: vi.fn(async () => credential) }
  const transport = { request: vi.fn() }
  const adapter = new AntigravityAdapter({ auth, transport })
  expect(adapter.catalogSnapshot().models.map(item => item.id)).not.toContain(model)
  await expect(adapter.resolveModel(ANTIGRAVITY_PROVIDER, model)).rejects.toMatchObject({ code: 'INVALID_MODEL' })
  await expect(adapter.stream(input(model, 'high'))[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'INVALID_MODEL' })
  expect(auth.credential).not.toHaveBeenCalled()
  expect(transport.request).not.toHaveBeenCalled()
})
