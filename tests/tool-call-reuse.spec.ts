import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, LlmRuntime, type GenerateOptions, type Message } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { AntigravityAdapter, ANTIGRAVITY_PROVIDER, buildAntigravityGeneratePayload } from '../src/llm-adapter.ts'
import type { HostCredential } from '../src/credential-coordinator.ts'
import type { PrivateTransportRequest } from '../src/private-transport.ts'

const GEMINI = 'antigravity-gemini-3.8-flash'
const CLAUDE = 'antigravity-claude-opus-4-6-thinking'
const credential: HostCredential = {
  accessToken: 'offline-access', refreshToken: 'offline-refresh',
  expiresAt: Date.parse('2030-01-01T00:00:00.000Z'), projectId: 'offline-project',
}

interface WirePart {
  functionCall?: { id?: string; name: string; args: Record<string, unknown> }
  functionResponse?: { id?: string; name: string; response: { content: string } }
  inlineData?: { mimeType: string; data: string }
}

interface WirePayload {
  request: { contents: Array<{ role: string; parts: WirePart[] }> }
}

function call(id: string, name: string, model = GEMINI): Message {
  return {
    id: `call-${name}` as never, role: 'assistant',
    source: { kind: 'model', provider: ANTIGRAVITY_PROVIDER, model },
    content: [{ type: 'tool-call', id: id as never, name, arguments: '{"file_path":"a.md"}' }],
  }
}

function result(id: string, text: string): Message {
  return {
    id: `result-${text}` as never, role: 'tool',
    source: { kind: 'tool', callId: id as never },
    toolCallId: id as never, isError: false,
    content: [{ type: 'text', text }],
  }
}

function options(messages: Message[], model = GEMINI): GenerateOptions {
  return { provider: ANTIGRAVITY_PROVIDER, model, messages }
}

function parts(payload: WirePayload): WirePart[] {
  return payload.request.contents.flatMap(content => content.parts)
}

function build(messages: Message[], model = GEMINI): WirePart[] {
  return parts(buildAntigravityGeneratePayload(options(messages, model), credential) as unknown as WirePayload)
}

function reusedHistory(names: string[], model = GEMINI): Message[] {
  return names.flatMap((name, index) => [call('call_148362', name, model), result('call_148362', `result-${index}`)])
}

describe('Gemini historical tool call ID reuse (#33)', () => {
  it.each([
    { label: 'different tools', names: ['read', 'edit', 'read'] },
    { label: 'the same tool', names: ['read', 'read'] },
  ])('replays completed calls to $label with their own result names', ({ names }) => {
    const messages = reusedHistory(names)
    const snapshot = structuredClone(messages)
    const wire = build(messages)

    expect(wire.flatMap(part => part.functionCall ? [part.functionCall] : [])).toEqual(
      names.map(name => ({ name, args: { file_path: 'a.md' } })),
    )
    expect(wire.flatMap(part => part.functionResponse ? [part.functionResponse] : [])).toEqual(
      names.map((name, index) => ({ name, response: { content: `result-${index}` } })),
    )
    expect(messages).toEqual(snapshot)
  })

  it.each([false, true])('continues through LlmRuntime with mixed image messages: %s', async withImages => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==', 'base64')
    const image = {
      attachmentId: 'offline-image' as never, mediaType: 'image/png' as const,
      bytes: png.byteLength, width: 1, height: 1,
    }
    const messages = reusedHistory(['read', 'edit']).map(message => withImages
      ? { ...message, content: [{ type: 'image' as const, attachment: image }, ...message.content] }
      : message)
    const readImage = vi.fn(async () => ({ ref: image, data: png }))
    const request = vi.fn(async (_input: PrivateTransportRequest) => new Response(
      'data: {"response":{"parts":[{"text":"continued"}],"finishReason":"STOP"}}\n\n',
    ))
    const adapter = new AntigravityAdapter({
      auth: { credential: async () => credential }, transport: { request }, attachments: { readImage },
    })
    const ctx = new Context()
    try {
      const runtime = new LlmRuntime(ctx)
      runtime.registerAdapter([ANTIGRAVITY_PROVIDER], adapter)
      const assembled = new BlockAssembler()
      for await (const chunk of runtime.stream(options(messages))) assembled.push(chunk)

      expect(assembled.blocks()).toEqual([{ type: 'text', text: 'continued' }])
      expect(request).toHaveBeenCalledOnce()
      const input = request.mock.calls[0]![0]
      const wire = parts(JSON.parse(String(input.body)) as WirePayload)
      expect(wire.flatMap(part => part.functionResponse ? [part.functionResponse] : [])).toEqual([
        { name: 'read', response: { content: 'result-0' } },
        { name: 'edit', response: { content: 'result-1' } },
      ])
      expect(wire.flatMap(part => part.functionCall ? [part.functionCall.id] : [])).toEqual([undefined, undefined])
      expect(readImage).toHaveBeenCalledTimes(withImages ? 2 : 0)
      expect(wire.filter(part => part.inlineData !== undefined)).toHaveLength(withImages ? 2 : 0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([
    { name: 'read', together: true }, { name: 'edit', together: true },
    { name: 'read', together: false }, { name: 'edit', together: false },
  ])('rejects an unresolved duplicate ID ($name, same message: $together)', ({ name, together }) => {
    const first = call('duplicate', 'read')
    const second = call('duplicate', name)
    const messages = together
      ? [{ ...first, content: [...first.content, ...second.content] }]
      : [first, second]
    messages.push(result('duplicate', 'ambiguous'))

    expect(() => build(messages)).toThrow(expect.objectContaining({
      code: 'INVALID_ARGS', message: 'A tool call id was reused before its prior result',
    }))
  })

  it.each([
    { label: 'orphan', messages: [result('missing', 'orphan')] },
    { label: 'result before call', messages: [result('later', 'early'), call('later', 'read')] },
    { label: 'duplicate result', messages: [call('done', 'read'), result('done', 'first'), result('done', 'second')] },
  ])('rejects an $label instead of borrowing a completed name', ({ messages }) => {
    expect(() => build(messages)).toThrow(expect.objectContaining({
      code: 'INVALID_ARGS', message: 'A tool result did not match a prior tool call',
    }))
  })

  it('correlates out-of-order parallel results and reuses only the completed ID', () => {
    const first = call('a', 'read')
    const second = call('b', 'glob')
    const wire = build([
      { ...first, content: [...first.content, ...second.content] },
      result('b', 'files'), call('b', 'edit'), result('a', 'file a'), result('b', 'edited'),
    ])
    expect(wire.flatMap(part => part.functionResponse ? [part.functionResponse] : [])).toEqual([
      { name: 'glob', response: { content: 'files' } },
      { name: 'read', response: { content: 'file a' } },
      { name: 'edit', response: { content: 'edited' } },
    ])
  })

  it('does not carry a tool binding from one payload into another', () => {
    build([call('earlier-request', 'read')])
    expect(() => build([result('earlier-request', 'orphan')])).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
  })

  it.each([CLAUDE, 'antigravity-gpt-oss-120b-medium'])('retains the existing cross-name reuse check for %s', model => {
    expect(() => build(reusedHistory(['read', 'edit'], model), model)).toThrow(expect.objectContaining({
      code: 'INVALID_ARGS', message: 'A tool call id was reused with a different name',
    }))
  })

  it('preserves Claude wire IDs and parallel result grouping', () => {
    const first = call('claude-a', 'read', CLAUDE)
    const second = call('claude-b', 'edit', CLAUDE)
    const payload = buildAntigravityGeneratePayload(options([
      { ...first, content: [...first.content, ...second.content] },
      result('claude-b', 'edited'), result('claude-a', 'file a'),
    ], CLAUDE), credential) as unknown as WirePayload
    expect(payload.request.contents).toHaveLength(2)
    expect(payload.request.contents[1]?.parts).toEqual([
      { functionResponse: { id: 'claude-b', name: 'edit', response: { content: 'edited' } } },
      { functionResponse: { id: 'claude-a', name: 'read', response: { content: 'file a' } } },
    ])
    expect(parts(payload).flatMap(part => part.functionCall ? [part.functionCall.id] : [])).toEqual(['claude-a', 'claude-b'])
  })
})
