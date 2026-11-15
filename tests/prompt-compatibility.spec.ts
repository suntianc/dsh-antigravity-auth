import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import { compatiblePromptAssembly, HARNESS_IDENTITY_SENTENCE, mountPromptCompatibility } from '../src/prompt-compatibility.ts'

it('enables compatibility on upgrade without configuration and allows explicit opt-out', () => {
  expect(Config({}).promptCompatibility).toBe(true)
  expect(Config({ promptCompatibility: false }).promptCompatibility).toBe(false)
  expect(Config({ promptCompatibility: true }).promptCompatibility).toBe(true)
})

it('changes only the exact named default on the owned Antigravity route without mutating input', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt, { personaPrefix: HARNESS_IDENTITY_SENTENCE })
    ctx.systemPrompt.variable('provider', () => 'google-antigravity')
    ctx.systemPrompt.variable('model', () => 'antigravity-gemini-3.8-flash')
    ctx.systemPrompt.section({ name: 'harness:source', order: 900, text: HARNESS_IDENTITY_SENTENCE })
    ctx.systemPrompt.context({ name: 'sandbox:policy', order: 1, text: HARNESS_IDENTITY_SENTENCE, required: true })
    const input = await ctx.systemPrompt.assemble()
    const before = JSON.stringify(input)
    for (const section of input.sections) Object.freeze(section)
    Object.freeze(input.sections); Object.freeze(input)
    const output = compatiblePromptAssembly(input, {}, provider => provider === 'google-antigravity')
    expect(JSON.stringify(input)).toBe(before)
    expect(output.sections.find(s => s.name === 'harness:identity')?.text).toBe('You are an AI coding assistant.')
    expect(output.sections.filter(s => s.name !== 'harness:identity')).toEqual(input.sections.filter(s => s.name !== 'harness:identity'))
    expect(output.contexts).toBe(input.contexts)
    expect(output.tools).toBe(input.tools)
    expect(output.variables).toBe(input.variables)
    expect(compatiblePromptAssembly(input, {}, () => false)).toBe(input)
    for (const model of ['antigravity-gemini-3.7-flash', 'antigravity-gemini-3.8-flash', 'antigravity-claude-sonnet-4-6-thinking', 'antigravity-gpt-oss-120b-medium', 'future-model']) {
      expect(compatiblePromptAssembly(input, { model } as never, () => true).sections.find(s => s.name === 'harness:identity')?.text).toBe('You are an AI coding assistant.')
    }
    for (const provider of ['magpie', 'workbuddy', 'openai', 'google-antigravity-other', 'Google']) {
      expect(compatiblePromptAssembly(input, { provider } as never, () => true)).toBe(input)
    }
    expect(compatiblePromptAssembly(input, { provider: 'google' } as never, () => false)).toBe(input)
    expect(compatiblePromptAssembly(input, { provider: 'google' } as never, () => true)).not.toBe(input)
    const customized = { ...input, sections: input.sections.map(s => ({ ...s, text: s.text + '\nCustom instruction' })) }
    expect(compatiblePromptAssembly(customized, {}, () => true)).toBe(customized)
    const missingRoute = { ...input, variables: {} }
    expect(compatiblePromptAssembly(missingRoute, {}, () => true)).toBe(missingRoute)
  } finally { await ctx.fiber.dispose() }
})

it.each(['antigravity-gemini-3.8-flash', 'antigravity-gemini-3.7-flash', 'antigravity-claude-sonnet-4-6-thinking', 'antigravity-gpt-oss-120b-medium', 'unreleased-next-family-999'])('uses real waterfall and restores owned route for %s', async model => {
  const ctx = new Context()
  let owned = true
  try {
    await ctx.plugin(SystemPrompt, {})
    ctx.systemPrompt.variable('provider', () => 'google-antigravity')
    ctx.systemPrompt.variable('model', () => model)
    const fork = ctx.plugin({ apply: (scope: Context) => mountPromptCompatibility(scope, () => owned) })
    await fork
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe('You are an AI coding assistant.')
    owned = false
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(HARNESS_IDENTITY_SENTENCE)
    owned = true
    await fork.dispose()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(HARNESS_IDENTITY_SENTENCE)
  } finally { await ctx.fiber.dispose() }
})

it('does not bypass complete personas or require SystemPrompt in other compositions', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin({ apply: (scope: Context) => mountPromptCompatibility(scope, () => true) })
    await ctx.plugin(SystemPrompt, {})
    ctx.systemPrompt.variable('provider', () => 'google-antigravity')
    ctx.systemPrompt.variable('model', () => 'antigravity-gemini-3.8-flash')
    ctx.systemPrompt.section({ name: 'custom-complete', order: 0, complete: true, text: HARNESS_IDENTITY_SENTENCE })
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(HARNESS_IDENTITY_SENTENCE)
  } finally { await ctx.fiber.dispose() }
})
