import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createSystemMessage, createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import { ANTIGRAVITY_PROVIDER, AntigravityAdapter, buildAntigravityGeneratePayload } from '../src/llm-adapter.js'

const credential = {
  accessToken: 'offline-access', refreshToken: 'offline-refresh',
  expiresAt: Date.now() + 3_600_000, projectId: 'offline-project',
}
const models = ['antigravity-gemini-3.8-flash', 'antigravity-claude-opus-5-5']

it('repairs the admitted system prompt on the next turn of a previously refused session', async () => {
  const { mountPromptCompatibility, BROWSER_SURFACE_SENTENCE } = await import('../src/prompt-compatibility.ts')
  const ctx = new Context()
  const requests: string[] = []
  const adapter = new AntigravityAdapter({ auth: { credential: async () => credential }, transport: { request: async input => {
    requests.push(String(input.body))
    const system = JSON.stringify(JSON.parse(String(input.body)).request.systemInstruction)
    return system.includes(BROWSER_SURFACE_SENTENCE)
      ? new Response('{"error":{"status":"RESOURCE_EXHAUSTED"}}', { status: 429 })
      : new Response('data: {"response":{"parts":[{"text":"ok"}],"finishReason":"STOP"}}\n\n')
  } } })
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'Preserve this instruction.' })
    ctx.systemPrompt.section({ name: 'app:web-surface', order: 910, text: BROWSER_SURFACE_SENTENCE })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter([ANTIGRAVITY_PROVIDER], adapter)
    const agent = await ctx.agentLoop.create(SessionId('prompt-compat-existing-failure'), { provider: ANTIGRAVITY_PROVIDER, model: 'antigravity-gemini-3.8-flash' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain(BROWSER_SURFACE_SENTENCE)
    const historicalEvents = JSON.stringify(agent.session.snapshotEvents())
    expect(historicalEvents).toContain('RATE_LIMIT')
    await ctx.plugin({ apply: (scope: Context) => mountPromptCompatibility(scope, provider => provider === ANTIGRAVITY_PROVIDER) })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(requests).toHaveLength(2)
    const repaired = JSON.parse(requests[1]!)
    expect(JSON.stringify(repaired.request.systemInstruction)).not.toContain(BROWSER_SURFACE_SENTENCE)
    expect(JSON.stringify(repaired.request.systemInstruction)).toContain('The page provides no implicit markup, route, or capture context.')
    expect(JSON.stringify(repaired.request.contents)).toContain('hello')
    expect(JSON.stringify(repaired.request.contents)).toContain('Continue.')
    // The old failure remains an immutable event; only the newly admitted surface changes.
    expect(JSON.stringify(agent.session.snapshotEvents()).includes(historicalEvents.slice(1, -1))).toBe(true)
    expect(JSON.stringify(agent.session.snapshotEvents().at(-1))).not.toContain('RATE_LIMIT')
  } finally { await ctx.fiber.dispose() }
})

it.each(models)('preserves the durable system prompt through the V3 AgentLoop for %s', async model => {
  const ctx = new Context()
  const requests: string[] = []
  const options: GenerateOptions[] = []
  const marker = 'V3 durable system instruction'
  const adapter = new AntigravityAdapter({
    auth: { credential: async () => credential },
    transport: { request: async input => {
      requests.push(String(input.body))
      return new Response('data: {"response":{"parts":[{"text":"ok"}],"finishReason":"STOP"}}\n\n')
    } },
  })
  const stream = adapter.stream.bind(adapter)
  adapter.stream = input => { options.push(input); return stream(input) }
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: marker })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter([ANTIGRAVITY_PROVIDER], adapter)
    const agent = await ctx.agentLoop.create(SessionId('v3-' + model), { provider: ANTIGRAVITY_PROVIDER, model })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(options).toHaveLength(1)
    expect(options[0]?.system).toBeUndefined()
    expect(JSON.stringify(agent.session.snapshotEvents().filter(event => event.type === 'system/message'))).toContain(marker)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain(marker)
  } finally {
    await ctx.fiber.dispose()
  }
})

it.each(models)('preserves ordered system messages and legacy one-shot instructions for %s', model => {
  const payload = buildAntigravityGeneratePayload({
    provider: ANTIGRAVITY_PROVIDER, model, system: 'one-shot preface',
    messages: [createSystemMessage('first system instruction'), createSystemMessage('second system instruction')],
  }, credential)
  const body = JSON.stringify(payload)
  expect(body).toContain('one-shot preface')
  expect(body).toContain('first system instruction')
  expect(body).toContain('second system instruction')
  expect(body.indexOf('first system instruction')).toBeLessThan(body.indexOf('second system instruction'))
})

it.each([false, true])('records compatible assembly without user rewrites; documents later reroute=%s', async reroute => {
  const { mountPromptCompatibility, HARNESS_IDENTITY_SENTENCE, BROWSER_SURFACE_SENTENCE } = await import('../src/prompt-compatibility.ts')
  const ctx = new Context()
  const requests: string[] = []
  const adapter = new AntigravityAdapter({ auth: { credential: async () => credential }, transport: { request: async input => {
    requests.push(String(input.body))
    return new Response('data: {"response":{"parts":[{"text":"ok"}],"finishReason":"STOP"}}\n\n')
  } } })
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'Preserve this instruction.' })
    ctx.systemPrompt.section({ name: 'harness:source', order: 900, text: 'DeepSeek Harness: use pwd before editing.' })
    ctx.systemPrompt.section({ name: 'app:web-surface', order: 910, text: `DeepSeek Harness: use the current GUI. ${BROWSER_SURFACE_SENTENCE}` })
    ctx.systemPrompt.context({ name: 'harness:source', order: 200, text: 'DeepSeek Harness checkout: "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/".', interpolate: false })
    ctx.systemPrompt.context({ name: 'app:web-surface', order: 210, text: 'DeepSeek Harness GUI: "http://127.0.0.1:1234".', interpolate: false })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin({ apply: (scope: Context) => mountPromptCompatibility(scope, provider => provider === ANTIGRAVITY_PROVIDER) })
    ctx.llm.registerAdapter([ANTIGRAVITY_PROVIDER], adapter)
    if (reroute) ctx.on('agent/request', async (_context, next) => ({ ...await next(), model: 'antigravity-gemini-4-carbon' }))
    const agent = await ctx.agentLoop.create(SessionId('prompt-compat-e2e'), { provider: ANTIGRAVITY_PROVIDER, model: 'antigravity-gemini-3.8-flash' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: `${HARNESS_IDENTITY_SENTENCE} ${BROWSER_SURFACE_SENTENCE}` }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(requests).toHaveLength(1)
    const body = JSON.parse(requests[0]!)
    // Assembly precedes routing: a later reroute keeps the admitted prompt.
    expect(body.model).toBe(reroute ? 'gemini-4-carbon-medium' : 'gemini-3.8-flash-medium')
    expect(JSON.stringify(body.request.systemInstruction)).toContain('You are an AI coding assistant.')
    expect(JSON.stringify(body.request.systemInstruction)).not.toContain(HARNESS_IDENTITY_SENTENCE)
    expect(JSON.stringify(body.request.systemInstruction)).toContain('Preserve this instruction.')
    expect(JSON.stringify(body.request.systemInstruction)).toContain('host application: use pwd before editing.')
    expect(JSON.stringify(body.request.systemInstruction)).toContain('host application: use the current GUI.')
    expect(JSON.stringify(body.request.systemInstruction)).not.toContain(BROWSER_SURFACE_SENTENCE)
    expect(JSON.stringify(body.request.systemInstruction)).toContain('The page provides no implicit markup, route, or capture context.')
    expect(JSON.stringify(body.request.systemInstruction)).not.toContain('DeepSeek Harness')
    expect(JSON.stringify(body.request.contents)).toContain(HARNESS_IDENTITY_SENTENCE)
    expect(JSON.stringify(body.request.contents)).toContain(BROWSER_SURFACE_SENTENCE)
    expect(JSON.stringify(body.request.contents)).toContain('host application checkout:')
    expect(JSON.stringify(body.request.contents)).toContain('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/')
    expect(JSON.stringify(body.request.contents)).not.toContain('/Applications/host application.app/')
    expect(JSON.stringify(body.request.contents)).toContain('host application GUI:')
    expect(JSON.stringify(body.request.contents)).toContain('http://127.0.0.1:1234')
    expect(JSON.stringify(body.request.contents)).not.toContain('DeepSeek Harness checkout:')
    expect(JSON.stringify(body.request.contents)).not.toContain('DeepSeek Harness GUI:')
    expect(JSON.stringify(agent.session.snapshotEvents().filter(event => event.type === 'system/message'))).toContain('You are an AI coding assistant.')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(requests).toHaveLength(2)
    const continued = JSON.parse(requests[1]!)
    expect(JSON.stringify(continued.request.systemInstruction)).not.toContain('DeepSeek Harness')
    expect(JSON.stringify(continued.request.systemInstruction)).not.toContain(BROWSER_SURFACE_SENTENCE)
    expect(JSON.stringify(continued.request.systemInstruction)).toContain('The page provides no implicit markup, route, or capture context.')
    expect(JSON.stringify(continued.request.contents)).toContain(BROWSER_SURFACE_SENTENCE)
    expect(JSON.stringify(continued.request.contents)).toContain('host application checkout:')
    expect(JSON.stringify(continued.request.contents)).toContain('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/')
    expect(JSON.stringify(continued.request.contents)).toContain('host application GUI:')
    expect(JSON.stringify(continued.request.contents)).not.toContain('DeepSeek Harness checkout:')
    expect(JSON.stringify(continued.request.contents)).not.toContain('DeepSeek Harness GUI:')
  } finally { await ctx.fiber.dispose() }
})
