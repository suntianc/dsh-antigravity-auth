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
const models = ['antigravity-gemini-3.7-flash', 'antigravity-claude-opus-4-6-thinking']

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
