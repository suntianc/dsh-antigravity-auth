import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderContextSnapshot, renderPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import { BROWSER_SURFACE_SENTENCE, compatiblePromptAssembly, HARNESS_IDENTITY_SENTENCE, mountPromptCompatibility } from '../src/prompt-compatibility.ts'

it('enables compatibility on upgrade without configuration and allows explicit opt-out', () => {
  expect(Config({}).promptCompatibility).toBe(true)
  expect(Config({ promptCompatibility: false }).promptCompatibility).toBe(false)
  expect(Config({ promptCompatibility: true }).promptCompatibility).toBe(true)
})

it('applies the reference rules on owned routes without mutating input or unrelated contributions', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt, { personaPrefix: HARNESS_IDENTITY_SENTENCE })
    ctx.systemPrompt.variable('provider', () => 'google-antigravity')
    ctx.systemPrompt.variable('model', () => 'antigravity-gemini-3.8-flash')
    ctx.systemPrompt.section({ name: 'harness:source', order: 900, text: 'DeepSeek Harness: use pwd. DeepSeek Harness source: {{source}}.' })
    ctx.systemPrompt.section({ name: 'app:web-surface', order: 910, text: 'DeepSeek Harness GUI: keep the existing server.' })
    ctx.systemPrompt.section({ name: 'tool:bash', order: 920, text: HARNESS_IDENTITY_SENTENCE })
    ctx.systemPrompt.context({ name: 'harness:source', order: 200, text: 'Current DeepSeek Harness checkout: "/safe/app".', interpolate: false })
    ctx.systemPrompt.context({ name: 'app:web-surface', order: 210, text: 'DeepSeek Harness GUI: "http://127.0.0.1:1234".', interpolate: false })
    ctx.systemPrompt.context({ name: 'sandbox:policy', order: 1, text: HARNESS_IDENTITY_SENTENCE, required: true })
    const input = await ctx.systemPrompt.assemble()
    const before = JSON.stringify(input)
    for (const item of [...input.sections, ...input.contexts]) Object.freeze(item)
    Object.freeze(input.sections); Object.freeze(input.contexts); Object.freeze(input)
    const output = compatiblePromptAssembly(input, {}, provider => provider === 'google-antigravity')
    expect(JSON.stringify(input)).toBe(before)
    expect(output.sections.find(s => s.name === 'harness:identity')?.text).toBe('You are an AI coding assistant.')
    expect(output.sections.find(s => s.name === 'harness:source')?.text).toBe('host application: use pwd. host application source: {{source}}.')
    expect(output.sections.find(s => s.name === 'app:web-surface')?.text).toBe('host application GUI: keep the existing server.')
    expect(output.sections.find(s => s.name === 'tool:bash')).toBe(input.sections.find(s => s.name === 'tool:bash'))
    expect(output.contexts.find(s => s.name === 'sandbox:policy')).toBe(input.contexts.find(s => s.name === 'sandbox:policy'))
    expect(output.contexts.find(s => s.name === 'antigravity-prompt-compat:harness:source')).toEqual({ ...input.contexts.find(s => s.name === 'harness:source'), name: 'antigravity-prompt-compat:harness:source', text: 'Current host application checkout: "/safe/app".' })
    expect(output.contexts.find(s => s.name === 'antigravity-prompt-compat:app:web-surface')).toEqual({ ...input.contexts.find(s => s.name === 'app:web-surface'), name: 'antigravity-prompt-compat:app:web-surface', text: 'host application GUI: "http://127.0.0.1:1234".' })
    expect(output.tools).toBe(input.tools)
    expect(output.variables).toBe(input.variables)
    expect(compatiblePromptAssembly(output, {}, () => true)).toBe(output)
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
    const customizedOutput = compatiblePromptAssembly(customized, {}, () => true)
    expect(customizedOutput.sections.find(s => s.name === 'harness:identity')?.text).toBe('You are an AI coding assistant.\nCustom instruction')
    const repeatedIdentity = { ...input, sections: [{ name: 'harness:identity', text: `Before\n${HARNESS_IDENTITY_SENTENCE}\nBetween\n${HARNESS_IDENTITY_SENTENCE}\nAfter` }] }
    expect(compatiblePromptAssembly(repeatedIdentity, {}, () => true).sections[0]?.text).toBe('Before\nYou are an AI coding assistant.\nBetween\nYou are an AI coding assistant.\nAfter')
    const missingRoute = { ...input, variables: {} }
    expect(compatiblePromptAssembly(missingRoute, {}, () => true)).toBe(missingRoute)
  } finally { await ctx.fiber.dispose() }
})

it('preserves no-match assemblies and rejects context snapshot collisions without disclosing text', () => {
  const input: PromptAssembly = {
    sections: [{ name: 'harness:identity', text: 'A custom persona mentioning DeepSeek Harness.' }],
    contexts: [{ name: 'harness:source', text: 'Current host application checkout: "/safe/app".', interpolate: false }],
    variables: { provider: 'google-antigravity' }, tools: [],
  }
  expect(compatiblePromptAssembly(input, {}, () => true)).toBe(input)
  const collision = { ...input, contexts: [
    { name: 'harness:source', text: 'DeepSeek Harness private-source-path', interpolate: false },
    { name: 'antigravity-prompt-compat:harness:source', text: 'existing', interpolate: false },
  ] }
  expect(() => compatiblePromptAssembly(collision, {}, () => true)).toThrow('antigravity-auth: a compatible context name is already registered.')
})

it.each([
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/',
  'C:\\Apps\\DeepSeek Harness\\dsh',
  '\\\\server\\DeepSeek Harness\\dsh',
  'https://example.test/DeepSeek Harness',
])('retains the literal location %s in current contexts and legacy source sections', location => {
  const literal = JSON.stringify(location)
  const text = `Current DeepSeek Harness checkout: ${literal}. Use this checkout to inspect DeepSeek Harness.`
  const input: PromptAssembly = {
    sections: [{ name: 'harness:source', text }],
    contexts: [{ name: 'harness:source', text, interpolate: false }],
    variables: { provider: 'google-antigravity' }, tools: [],
  }
  const output = compatiblePromptAssembly(input, {}, () => true)
  const expected = `Current host application checkout: ${literal}. Use this checkout to inspect host application.`
  expect(output.sections[0]?.text).toBe(expected)
  expect(output.contexts[0]?.text).toBe(expected)
  expect(input.sections[0]?.text).toBe(text)
})

it('rewrites only the exact web-surface sentence while preserving literal locations and other contributions', () => {
  const compatible = 'The page provides no implicit markup, route, or capture context.'
  const locations = [
    `/safe/${BROWSER_SURFACE_SENTENCE}/DeepSeek Harness`,
    `C:\\Apps\\${BROWSER_SURFACE_SENTENCE}`,
    `\\\\server\\${BROWSER_SURFACE_SENTENCE}`,
    `https://example.test/${BROWSER_SURFACE_SENTENCE}`,
  ].map(location => JSON.stringify(location)).join('\n')
  const text = `Before ${BROWSER_SURFACE_SENTENCE}\n${locations}\nAfter ${BROWSER_SURFACE_SENTENCE}`
  const input: PromptAssembly = {
    sections: [{ name: 'app:web-surface', text }, { name: 'harness:source', text: BROWSER_SURFACE_SENTENCE },
      { name: 'tool:browser', text: BROWSER_SURFACE_SENTENCE }, { name: 'project:rules', text: BROWSER_SURFACE_SENTENCE }],
    contexts: [{ name: 'app:web-surface', text: BROWSER_SURFACE_SENTENCE, interpolate: false }],
    variables: { provider: 'google-antigravity' }, tools: [],
  }
  const output = compatiblePromptAssembly(input, {}, () => true)
  expect(output.sections[0]?.text).toBe(`Before ${compatible}\n${locations}\nAfter ${compatible}`)
  expect(output.sections.slice(1)).toEqual(input.sections.slice(1))
  expect(output.contexts[0]).toEqual({ name: 'antigravity-prompt-compat:app:web-surface', text: compatible, interpolate: false })
  expect(input.sections[0]?.text).toBe(text)
  expect(compatiblePromptAssembly(output, {}, () => true)).toBe(output)
  expect(compatiblePromptAssembly(input, {}, () => false)).toBe(input)
  expect(compatiblePromptAssembly(input, { provider: 'openai' } as never, () => true)).toBe(input)
  const nearMatch = { ...input, sections: [{ name: 'app:web-surface', text: BROWSER_SURFACE_SENTENCE.replace('DOM', 'dom') }], contexts: [] }
  expect(compatiblePromptAssembly(nearMatch, {}, () => true)).toBe(nearMatch)
})

it.each(['antigravity-gemini-3.8-flash', 'antigravity-gemini-3.7-flash', 'antigravity-claude-sonnet-4-6-thinking', 'antigravity-gpt-oss-120b-medium', 'unreleased-next-family-999'])('uses real waterfall and restores owned route for %s', async model => {
  const ctx = new Context()
  let owned = true
  try {
    await ctx.plugin(SystemPrompt, {})
    ctx.systemPrompt.section({ name: 'harness:source', order: 900, text: 'DeepSeek Harness: use pwd before editing.' })
    ctx.systemPrompt.section({ name: 'app:web-surface', order: 910, text: `DeepSeek Harness: keep the current GUI URL. ${BROWSER_SURFACE_SENTENCE}` })
    ctx.systemPrompt.context({ name: 'harness:source', order: 200, text: 'DeepSeek Harness checkout: "/safe/app".', interpolate: false })
    ctx.systemPrompt.context({ name: 'app:web-surface', order: 210, text: `DeepSeek Harness GUI: "http://127.0.0.1:1234". ${BROWSER_SURFACE_SENTENCE}`, interpolate: false })
    ctx.systemPrompt.context({ name: 'sandbox:policy', order: 100, text: 'Only the workspace is writable.', required: true })
    ctx.systemPrompt.variable('provider', () => 'google-antigravity')
    ctx.systemPrompt.variable('model', () => model)
    const fork = ctx.plugin({ apply: (scope: Context) => mountPromptCompatibility(scope, () => owned) })
    await fork
    const assembly = await ctx.systemPrompt.assemble()
    expect(renderPrompt(assembly)).toContain('You are an AI coding assistant.')
    expect(renderPrompt(assembly)).not.toContain('DeepSeek Harness')
    expect(renderPrompt(assembly)).toContain('use pwd before editing.')
    expect(renderPrompt(assembly)).not.toContain(BROWSER_SURFACE_SENTENCE)
    expect(renderPrompt(assembly)).toContain('The page provides no implicit markup, route, or capture context.')
    const refreshed = renderContextSnapshot(ctx.systemPrompt.refreshContext(assembly))
    expect(refreshed).not.toContain('DeepSeek Harness')
    expect(refreshed).toContain('/safe/app')
    expect(refreshed).toContain('http://127.0.0.1:1234')
    expect(refreshed).toContain('Only the workspace is writable.')
    expect(refreshed).not.toContain(BROWSER_SURFACE_SENTENCE)
    expect(refreshed).toContain('The page provides no implicit markup, route, or capture context.')
    owned = false
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain(HARNESS_IDENTITY_SENTENCE)
    owned = true
    await fork.dispose()
    const restored = await ctx.systemPrompt.assemble()
    expect(renderPrompt(restored)).toContain(HARNESS_IDENTITY_SENTENCE)
    expect(renderPrompt(restored)).toContain(BROWSER_SURFACE_SENTENCE)
    expect(renderContextSnapshot(ctx.systemPrompt.refreshContext(restored))).toContain('DeepSeek Harness')
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
