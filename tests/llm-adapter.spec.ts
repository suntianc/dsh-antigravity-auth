import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { CONTEXT_WINDOW_EXCEEDED_CODE, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AntigravityAdapter, ANTIGRAVITY_AVAILABLE_MODELS_ENDPOINT, ANTIGRAVITY_PROVIDER, buildAntigravityGeneratePayload } from '../src/llm-adapter.ts'
import type { HostCredential } from '../src/credential-coordinator.ts'
import { PrivateTransportError, type PrivateTransportRequest } from '../src/private-transport.ts'

const credential = (token: string): HostCredential => ({
  accessToken: token,
  refreshToken: 'refresh',
  expiresAt: Date.parse('2030-01-01T00:00:00.000Z'),
  projectId: 'project-id',
})

const liveCatalog = () => new Response(JSON.stringify({
  models: { 'gemini-3.7-flash-medium': { displayName: 'Gemini live' } },
}))

const message = (text: string): Message => ({
  id: 'message-id' as never,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

const options = (overrides: Partial<GenerateOptions> = {}): GenerateOptions => ({
  provider: ANTIGRAVITY_PROVIDER,
  model: 'antigravity-gemini-3.7-flash',
  messages: [message('hello')],
  ...overrides,
})

async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const output: StreamChunk[] = []
  for await (const chunk of chunks) output.push(chunk)
  return output
}

async function collectThroughRuntime(adapter: AntigravityAdapter, input: GenerateOptions): Promise<StreamChunk[]> {
  const ctx = new Context()
  try {
    const runtime = new LlmRuntime(ctx)
    runtime.registerAdapter([ANTIGRAVITY_PROVIDER], adapter)
    return await collect(runtime.stream(input))
  } finally {
    await ctx.fiber.dispose()
  }
}

describe('Antigravity LLM adapter', () => {
  it('streams bounded text, usage, finish, and replay metadata through the public LLM vocabulary', async () => {
    const transport = {
      request: vi.fn(async ({ url }: { url: string }) => url.endsWith(':fetchAvailableModels')
        ? liveCatalog()
        : new Response(
            'data: {"response":{"parts":[{"text":"hello","thoughtSignature":"provider-sig"}]}}\n\n'
            + 'data: {"response":{"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3},"finishReason":"STOP"}}\n\n'
            + 'data: [DONE]\n\n',
          )),
    }
    const adapter = new AntigravityAdapter({ auth: { credential: vi.fn(async () => credential('access')) }, transport })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(options())) chunks.push(chunk)
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'hello')).toBe(true)
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } })
    const finish = chunks.at(-1)
    expect(finish?.type).toBe('finish')
    if (finish?.type === 'finish') expect(finish.replayState).toMatchObject({ response: { provider: ANTIGRAVITY_PROVIDER }, blocks: [{ kind: 'text', signature: 'provider-sig' }] })
  })

  it('drains the Gemini 3.8 stream after a terminal event instead of cancelling the live body early', async () => {
    const encoder = new TextEncoder()
    let cancelled = false
    let tailDelivered = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"response":{"parts":[{"text":"ok"}],"finishReason":"STOP"}}\n\n'))
        timer = setTimeout(() => {
          tailDelivered = true
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        }, 10)
      },
      cancel() {
        cancelled = true
        if (timer !== undefined) clearTimeout(timer)
      },
    })
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('access')) },
      transport: { request: vi.fn(async () => new Response(body)) },
    })

    const chunks = await collect(adapter.stream(options({ model: 'antigravity-gemini-3.8-flash' })))

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(tailDelivered).toBe(true)
    expect(cancelled).toBe(false)
  })

  it.each([
    {
      family: 'Gemini', model: 'antigravity-gemini-3.7-flash', wireModel: 'gemini-3-flash', errorCode: 'SAFETY',
      event: '{"response":{"parts":[{"text":"gemini-reason","thought":true},{"text":"gemini-answer"},{"functionCall":{"id":"gemini-call","name":"gemini_lookup","args":{"q":"g"}}}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3},"finishReason":"STOP"}}',
    },
    {
      family: 'Claude', model: 'antigravity-claude-sonnet-4-6-thinking', wireModel: 'claude-sonnet-4-6', errorCode: 'RESOURCE_EXHAUSTED',
      event: '{"response":{"parts":[{"text":"claude-reason","thinking":true},{"text":"claude-answer"},{"function_call":{"id":"claude-call","name":"claude_lookup","args":{"q":"c"}}}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3},"finishReason":"STOP"}}',
    },
    {
      family: 'GPT-OSS', model: 'antigravity-gpt-oss-120b-medium', wireModel: 'gpt-oss-120b-medium', errorCode: 'INVALID_ARGUMENT',
      event: '{"response":{"parts":[{"text":"gpt-reason","reasoning":true},{"text":"gpt-answer"},{"functionCall":{"id":"gpt-call","name":"gpt_lookup","args":{"q":"o"}}}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3},"finishReason":"STOP"}}',
    },
  ])('keeps $family text, reasoning, tool, usage, finish, and error fixtures independent', async fixture => {
    const request = vi.fn(async (input: PrivateTransportRequest) => {
      expect(JSON.parse(String(input.body))).toMatchObject({ model: fixture.wireModel })
      return new Response(`data: ${fixture.event}\n\n`)
    })
    const success = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('opaque-test-value')) },
      transport: { request },
    })
    const chunks = await collect(success.stream(options({ model: fixture.model })))
    expect(chunks.some(chunk => chunk.type === 'reasoning-delta')).toBe(true)
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
    expect(chunks.some(chunk => chunk.type === 'tool-call-delta')).toBe(true)
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })

    const failed = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('opaque-test-value')) },
      transport: { request: vi.fn(async () => new Response(`data: {"error":{"status":400,"code":"${fixture.errorCode}"}}\n\n`)) },
    })
    expect((await collect(failed.stream(options({ model: fixture.model })))).at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: fixture.errorCode } },
    })
  })

  it('preserves the complete DSH system prompt and tool declaration for Claude Opus', async () => {
    const tail = '[ISSUE-20-TOOL-INSTRUCTIONS-END]'
    const system = `[INITIAL]\n${'x'.repeat(66_000)}\n[CONTEXT]\n${tail}`
    const request = vi.fn(async (input: PrivateTransportRequest) => {
      const payload = JSON.parse(String(input.body)) as {
        model: string
        request: {
          systemInstruction?: { parts?: Array<{ text?: string }> }
          tools?: Array<{ functionDeclarations?: Array<{ name?: string; description?: string }> }>
          toolConfig?: { functionCallingConfig?: { mode?: string } }
        }
      }
      expect(payload.model).toBe('claude-opus-4-6-thinking')
      expect(payload.request.systemInstruction?.parts?.[0]?.text).toBe(system)
      expect(payload.request.systemInstruction?.parts?.some(part => part.text?.includes(tail) === true)).toBe(true)
      expect(payload.request.systemInstruction?.parts?.some(part => part.text?.includes('CRITICAL TOOL USAGE INSTRUCTIONS') === true)).toBe(true)
      expect(payload.request.systemInstruction?.parts?.at(-1)?.text).toContain('Interleaved thinking is enabled')
      const declaration = payload.request.tools?.[0]?.functionDeclarations?.find(item => item.name === 'lookup')
      expect(declaration?.description).toContain('STRICT PARAMETERS: query (string, REQUIRED)')
      expect(payload.request.toolConfig?.functionCallingConfig?.mode).toBe('VALIDATED')
      return new Response('data: {"response":{"parts":[{"function_call":{"id":"call-1","name":"lookup","args":{"query":"x"}}}],"finishReason":"FUNCTION_CALL"}}\n\n')
    })
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('opaque-test-value')) },
      transport: { request },
    })

    await expect(collectThroughRuntime(adapter, options({
      model: 'antigravity-claude-opus-4-6-thinking',
      system,
      tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
    }))).resolves.toContainEqual(expect.objectContaining({
      type: 'tool-call-delta',
      name: 'lookup',
      argumentsDelta: '{"query":"x"}',
    }))
    expect(request).toHaveBeenCalledOnce()
  })

  it('replays Claude tool calls and results with matching ids while dropping unsigned reasoning', async () => {
    const model = 'antigravity-claude-opus-4-6-thinking'
    const bashCallId = 'toolu_vrtx_bash'
    const globCallId = 'toolu_vrtx_glob'
    const assistant = {
      id: 'assistant-tools',
      role: 'assistant',
      source: {
        kind: 'model',
        provider: ANTIGRAVITY_PROVIDER,
        model,
        replayState: {
          response: { version: 1, provider: ANTIGRAVITY_PROVIDER, model, family: 'claude', finish: 'STOP' },
          blocks: [{ kind: 'reasoning' }, { kind: 'tool-call' }, { kind: 'tool-call' }],
        },
      },
      content: [
        { type: 'reasoning', text: 'unsigned provider reasoning' },
        { type: 'tool-call', id: bashCallId, name: 'bash', arguments: '{"command":"pwd"}' },
        { type: 'tool-call', id: globCallId, name: 'glob', arguments: '{"pattern":"*/package.json"}' },
      ],
    } as unknown as Message
    const result = (id: string, name: string, text: string): Message => ({
      id: `result-${name}` as never,
      role: 'tool',
      source: { kind: 'tool', callId: id as never },
      toolCallId: id as never, isError: false,
      content: [{ type: 'text', text }],
    })
    const request = vi.fn(async (input: PrivateTransportRequest) => {
      const payload = JSON.parse(String(input.body)) as {
        request: { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> }
      }
      const contents = payload.request.contents
      expect(contents[1]?.parts).toEqual([
        {
          functionCall: { id: bashCallId, name: 'bash', args: { command: 'pwd' } },
          thoughtSignature: 'skip_thought_signature_validator',
        },
        { functionCall: { id: globCallId, name: 'glob', args: { pattern: '*/package.json' } } },
      ])
      expect(contents).toHaveLength(3)
      expect(contents[2]?.parts).toEqual([
        { functionResponse: { id: bashCallId, name: 'bash', response: { content: '/workspace' } } },
        { functionResponse: { id: globCallId, name: 'glob', response: { content: 'plugin/package.json' } } },
      ])
      return new Response('data: {"response":{"parts":[{"text":"continued"}],"finishReason":"STOP"}}\n\n')
    })
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('opaque-test-value')) },
      transport: { request },
    })

    const chunks = await collectThroughRuntime(adapter, options({
      model,
      messages: [message('test tools'), assistant, result(bashCallId, 'bash', '/workspace'), result(globCallId, 'glob', 'plugin/package.json')],
      tools: [
        { name: 'bash', description: 'Run shell', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
        { name: 'glob', description: 'Find files', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
      ],
    }))
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'continued' }))
    expect(request).toHaveBeenCalledOnce()
  })

  it('carries one response-level Gemini thinking signature into an unsigned tool call and replays it', async () => {
    const signature = 'gemini-thought-signature'
    const body = 'data: {"response":{"parts":[{"text":"planning","thought":true},{"functionCall":{"id":"call-sig","name":"bash","args":{"command":"pwd"}}}],"thoughtSignature":"gemini-thought-signature"}}\n\n'
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('opaque-test-value')) },
      transport: { request: vi.fn(async () => new Response(body)) },
    })

    const chunks = await collectThroughRuntime(adapter, options())
    const finish = chunks.at(-1)
    expect(finish?.type).toBe('finish')
    if (finish?.type === 'finish') {
      expect(finish.replayState).toMatchObject({
        blocks: [
          { kind: 'reasoning' },
          { kind: 'tool-call', signature },
        ],
      })
    }
  })

  it('describes an HTTP 400 rejection without losing the protocol-drift classification', async () => {
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('opaque-test-value')) },
      transport: { request: vi.fn(async () => new Response('rejected', { status: 400 })) },
    })

    const chunks = await collectThroughRuntime(adapter, options())
    const finish = chunks.at(-1)
    expect(finish).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'PROTOCOL_DRIFT', status: 400 } },
    })
    expect(finish).toMatchObject({
      reason: { failure: { message: expect.stringContaining('HTTP 400') } },
    })
    expect(JSON.stringify(finish)).not.toMatch(/The Antigravity private request failed safely/)
  })

  it('repairs a truncated historical tool-call argument object and replays it', async () => {
    const toolCallId = 'call_repairable'
    const model = 'antigravity-gemini-3.7-flash'
    const assistant = {
      id: 'assistant-repairable',
      role: 'assistant',
      content: [{ type: 'tool-call', id: toolCallId, name: 'bash', arguments: '{"command":"pwd"' }],
      source: { kind: 'model', provider: ANTIGRAVITY_PROVIDER, model },
    } as unknown as Message
    const toolResult: Message = {
      id: 'result-repairable' as never,
      role: 'tool',
      source: { kind: 'tool', callId: toolCallId as never },
      toolCallId: toolCallId as never, isError: false,
      content: [{ type: 'text', text: '/workspace' }],
    }
    const request = vi.fn(async (input: PrivateTransportRequest) => {
      const payload = JSON.parse(String(input.body)) as {
        request: { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> }
      }
      const call = payload.request.contents[1]?.parts?.[0] as { functionCall?: { args?: unknown } } | undefined
      expect(call?.functionCall?.args).toEqual({ command: 'pwd' })
      return new Response('data: {"response":{"parts":[{"text":"repaired"}],"finishReason":"STOP"}}\n\n')
    })
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('opaque-test-value')) },
      transport: { request },
    })

    const chunks = await collectThroughRuntime(adapter, options({ model, messages: [message('hello'), assistant, toolResult] }))
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'repaired' }))
    expect(request).toHaveBeenCalledOnce()
  })

  it('drops an unrepairable historical tool-call fragment instead of locking the session', async () => {
    const toolCallId = 'call_truncated'
    const model = 'antigravity-gemini-3.7-flash'
    const assistant = {
      id: 'assistant-truncated',
      role: 'assistant',
      content: [{ type: 'tool-call', id: toolCallId, name: 'bash', arguments: '{"command":"echo hi' }],
      source: { kind: 'model', provider: ANTIGRAVITY_PROVIDER, model },
    } as unknown as Message
    const toolResult: Message = {
      id: 'result-truncated' as never,
      role: 'tool',
      source: { kind: 'tool', callId: toolCallId as never },
      toolCallId: toolCallId as never, isError: false,
      content: [{ type: 'text', text: 'hi' }],
    }
    const request = vi.fn(async (input: PrivateTransportRequest) => {
      const payload = JSON.parse(String(input.body)) as {
        request: { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> }
      }
      const call = payload.request.contents[1]?.parts?.[0] as { functionCall?: { args?: unknown } } | undefined
      expect(call?.functionCall?.args).toEqual({})
      return new Response('data: {"response":{"parts":[{"text":"recovered"}],"finishReason":"STOP"}}\n\n')
    })
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('opaque-test-value')) },
      transport: { request },
    })

    const chunks = await collectThroughRuntime(adapter, options({ model, messages: [message('hello'), assistant, toolResult] }))
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'recovered' }))
    expect(request).toHaveBeenCalledOnce()
  })

  it('maps a bounded multiline HTTP 400 SSE error to DSH context-overflow recovery', async () => {
    const providerDetail = 'prompt is too long: 200001 tokens > 200000 maximum'
    const payload = JSON.stringify({
      error: {
        code: 400,
        message: JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: providerDetail },
          request_id: 'provider-request-id-must-not-leak',
        }),
        status: 'INVALID_ARGUMENT',
      },
    })
    const split = payload.indexOf('"message"')
    const body = [
      'event: heartbeat',
      'data: {"ignored":true}',
      '',
      'event: error',
      `data: ${payload.slice(0, split)}`,
      `data: ${payload.slice(split)}`,
      '',
      '',
    ].join('\n')
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('opaque-test-value')) },
      transport: { request: vi.fn(async () => new Response(body, { status: 400, headers: { 'content-type': 'text/event-stream' } })) },
    })

    const chunks = await collectThroughRuntime(adapter, options({ model: 'antigravity-claude-opus-4-6-thinking' }))
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: CONTEXT_WINDOW_EXCEEDED_CODE,
          message: 'The Antigravity request exceeded the model context window',
          status: 400,
        },
      },
    })
    expect(JSON.stringify(chunks)).not.toMatch(/200001|200000|provider-request-id-must-not-leak/u)
  })

  it('maps a plain HTTP 400 JSON error with whitespace around its nested JSON wrapper', async () => {
    const nested = JSON.stringify({
      error: { message: 'prompt is too long: 200001 tokens > 200000 maximum' },
      request_id: 'plain-request-id-must-not-leak',
    })
    const body = JSON.stringify({
      error: {
        code: 400,
        message: ` \n${nested}\t`,
        status: 'INVALID_ARGUMENT',
      },
    })
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('opaque-test-value')) },
      transport: { request: vi.fn(async () => new Response(body, { status: 400 })) },
    })

    const chunks = await collectThroughRuntime(adapter, options({ model: 'antigravity-claude-opus-4-6-thinking' }))
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE, status: 400 } },
    })
    expect(JSON.stringify(chunks)).not.toMatch(/200001|200000|plain-request-id-must-not-leak/u)
  })

  it('cancels the HTTP error body after early bounded overflow detection', async () => {
    const payload = JSON.stringify({
      error: { message: 'prompt is too long: 200001 tokens > 200000 maximum' },
    })
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start: streamController => {
        streamController.enqueue(new TextEncoder().encode(`event: error\ndata: ${payload}\n\n`))
      },
      pull: () => new Promise<void>(() => {}),
      cancel: () => { cancelled = true },
    })
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('opaque-test-value')) },
      transport: { request: vi.fn(async () => new Response(body, { status: 400 })) },
    })

    const chunks = await collectThroughRuntime(adapter, options({ model: 'antigravity-claude-opus-4-6-thinking' }))
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE, status: 400 } },
    })
    expect(cancelled).toBe(true)
  })

  it('maps a streamed prompt-too-long event without exposing provider details', async () => {
    const providerDetail = 'prompt is too long: 200001 tokens > 200000 maximum'
    const event = JSON.stringify({
      error: {
        code: 'INVALID_ARGUMENT',
        status: 400,
        message: JSON.stringify({ error: { message: providerDetail }, request_id: 'stream-request-id-must-not-leak' }),
      },
    })
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('opaque-test-value')) },
      transport: { request: vi.fn(async () => new Response(`data: ${event}\n\n`)) },
    })

    const chunks = await collectThroughRuntime(adapter, options({ model: 'antigravity-claude-opus-4-6-thinking' }))
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE, status: 400 } },
    })
    expect(JSON.stringify(chunks)).not.toMatch(/200001|200000|stream-request-id-must-not-leak/u)
  })

  it.each([
    'PROMPT IS TOO LONG: 200001 tokens > 200000 maximum',
    'prompt is too long:  200001 tokens > 200000 maximum',
    'prompt is too long: 200001 tokens > 200000 maximum.',
    ' prompt is too long: 200001 tokens > 200000 maximum',
    'prompt is too long: 200000 tokens > 200000 maximum',
    'prompt is too long: 199999 tokens > 200000 maximum',
  ])('does not classify a near-match provider message as context overflow: %s', async providerDetail => {
    const body = JSON.stringify({ error: { message: JSON.stringify({ error: { message: providerDetail } }) } })
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('opaque-test-value')) },
      transport: { request: vi.fn(async () => new Response(body, { status: 400 })) },
    })

    const chunks = await collectThroughRuntime(adapter, options({ model: 'antigravity-claude-opus-4-6-thinking' }))
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'PROTOCOL_DRIFT', status: 400 } },
    })
  })

  it('does not classify an auxiliary SSE frame with a top-level exact-looking message', async () => {
    const body = 'event: heartbeat\ndata: {"message":"prompt is too long: 200001 tokens > 200000 maximum"}\n\n'
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('opaque-test-value')) },
      transport: { request: vi.fn(async () => new Response(body, { status: 400 })) },
    })

    const chunks = await collectThroughRuntime(adapter, options({ model: 'antigravity-claude-opus-4-6-thinking' }))
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'PROTOCOL_DRIFT', status: 400 } },
    })
  })

  it('rejects deeply nested and oversized HTTP error bodies without classifying their contents', async () => {
    let nested: unknown = { message: 'prompt is too long: 200001 tokens > 200000 maximum' }
    for (let depth = 0; depth < 12; depth += 1) nested = { error: nested }
    const bodies = [
      JSON.stringify(nested),
      JSON.stringify({ padding: 'x'.repeat(70 * 1024), error: { message: 'prompt is too long: 200001 tokens > 200000 maximum' } }),
    ]

    for (const body of bodies) {
      const adapter = new AntigravityAdapter({
        auth: { credential: vi.fn(async () => credential('opaque-test-value')) },
        transport: { request: vi.fn(async () => new Response(body, { status: 400 })) },
      })
      const chunks = await collectThroughRuntime(adapter, options({ model: 'antigravity-claude-opus-4-6-thinking' }))
      expect(chunks.at(-1)).toMatchObject({
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'PROTOCOL_DRIFT', status: 400 } },
      })
    }
  })

  it('honors dedicated and tighter configured HTTP error response and frame limits', async () => {
    const exactMessage = 'prompt is too long: 200001 tokens > 200000 maximum'
    const smallPayload = JSON.stringify({ padding: 'x'.repeat(2 * 1024), error: { message: exactMessage } })
    const largeFramePayload = JSON.stringify({ padding: 'x'.repeat(20 * 1024), error: { message: exactMessage } })
    const fixtures = [
      { body: smallPayload, maxResponseBytes: 1024 },
      { body: `data: ${smallPayload}\n\n`, maxFrameBytes: 1024 },
      { body: `data: ${largeFramePayload}\n\n` },
    ]

    for (const fixture of fixtures) {
      const adapter = new AntigravityAdapter({
        auth: { credential: vi.fn(async () => credential('opaque-test-value')) },
        transport: { request: vi.fn(async () => new Response(fixture.body, { status: 400 })) },
        ...('maxResponseBytes' in fixture ? { maxResponseBytes: fixture.maxResponseBytes } : {}),
        ...('maxFrameBytes' in fixture ? { maxFrameBytes: fixture.maxFrameBytes } : {}),
      })
      const chunks = await collectThroughRuntime(adapter, options({ model: 'antigravity-claude-opus-4-6-thinking' }))
      expect(chunks.at(-1)).toMatchObject({
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'PROTOCOL_DRIFT', status: 400 } },
      })
    }
  })

  it('preserves mid-read cancellation and cancels the HTTP error body', async () => {
    const controller = new AbortController()
    let pulls = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull: streamController => {
        pulls += 1
        if (pulls === 1) {
          streamController.enqueue(new TextEncoder().encode('event: error\ndata: {"error":'))
          return
        }
        return new Promise<void>(resolve => {
          setTimeout(() => {
            controller.abort()
            resolve()
          }, 0)
        })
      },
      cancel: () => { cancelled = true },
    })
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('opaque-test-value')) },
      transport: { request: vi.fn(async () => new Response(body, { status: 400 })) },
    })

    const chunks = await collectThroughRuntime(adapter, options({
      model: 'antigravity-claude-opus-4-6-thinking',
      signal: controller.signal,
    }))
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'aborted', failure: { code: 'CANCELLED' } },
    })
    expect(pulls).toBeGreaterThanOrEqual(2)
    expect(cancelled).toBe(true)
  })

  it.each([
    { name: 'idle timeout', idleTimeoutMs: 5, totalTimeoutMs: 50 },
    { name: 'total timeout', idleTimeoutMs: 50, totalTimeoutMs: 5 },
  ])('bounds an HTTP error body on $name and cancels its reader', async fixture => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel: () => { cancelled = true },
    })
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('opaque-test-value')) },
      transport: { request: vi.fn(async () => new Response(body, { status: 400 })) },
      idleTimeoutMs: fixture.idleTimeoutMs,
      totalTimeoutMs: fixture.totalTimeoutMs,
    })

    const chunks = await collectThroughRuntime(adapter, options({ model: 'antigravity-claude-opus-4-6-thinking' }))
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'PROTOCOL_DRIFT', status: 400 } },
    })
    expect(cancelled).toBe(true)
  })

  it('replays exactly once after a pre-delta authentication response', async () => {
    const transport = {
      request: vi.fn()
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockResolvedValueOnce(new Response('data: {"response":{"parts":[{"text":"ok"}],"finishReason":"STOP"}}\n\n')),
    }
    const auth = {
      credential: vi.fn()
        .mockResolvedValueOnce(credential('old'))
        .mockResolvedValueOnce(credential('new')),
    }
    const adapter = new AntigravityAdapter({ auth, transport })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(options())) chunks.push(chunk)
    expect(transport.request).toHaveBeenCalledTimes(2)
    expect(auth.credential).toHaveBeenCalledTimes(2)
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'ok')).toBe(true)
  })

  it('exposes newly supported Gemini 3.8 while filtering absent legacy models through the public catalog', async () => {
    const ctx = new Context()
    try {
      const runtime = new LlmRuntime(ctx)
      runtime.registerAdapter([ANTIGRAVITY_PROVIDER], new AntigravityAdapter({
        auth: { credential: vi.fn(async () => credential('access')) },
        transport: {
          request: vi.fn(async () => new Response(JSON.stringify({
            models: {
              'gemini-3.8-flash-tiered': { displayName: 'Gemini 3.8 Flash' },
            },
          }))),
        },
      }))

      await expect(runtime.listModels(ANTIGRAVITY_PROVIDER).then(models => models.map(model => model.id)))
        .resolves.toEqual(['antigravity-gemini-3.8-flash'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses Gemini 3.8 native medium as the public runtime default', async () => {
    const request = vi.fn(async (_input: PrivateTransportRequest) => new Response(
      'data: {"response":{"parts":[{"text":"ok"}],"finishReason":"STOP"}}\n\n',
    ))
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('access')) },
      transport: { request },
    })

    const resolved = await adapter.resolveModel(ANTIGRAVITY_PROVIDER, 'antigravity-gemini-3.8-flash')
    expect(resolved.reasoning?.defaultEffort).toBe('medium')

    await collectThroughRuntime(adapter, options({ model: 'antigravity-gemini-3.8-flash' }))
    const body = JSON.parse(String(request.mock.calls[0]?.[0].body))
    expect(body).toMatchObject({
      model: 'gemini-3.8-flash-medium',
      userAgent: 'antigravity',
      requestType: 'agent',
      request: {
        labels: { model_enum: 'MODEL_PLACEHOLDER_M319' },
        generationConfig: {
          maxOutputTokens: 65536,
          thinkingConfig: { includeThoughts: true, thinkingBudget: 4000 },
        },
      },
    })
    expect(body.request.generationConfig.thinkingConfig).not.toHaveProperty('thinkingLevel')
    expect(Object.keys(body)).toEqual(['project', 'requestId', 'request', 'model', 'userAgent', 'requestType'])
  })

  it('maps an explicit Gemini 3.8 High effort to the captured High wire route', async () => {
    const request = vi.fn(async (_input: PrivateTransportRequest) => new Response(
      'data: {"response":{"parts":[{"text":"ok"}],"finishReason":"STOP"}}\n\n',
    ))
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('access')) },
      transport: { request },
    })

    await collectThroughRuntime(adapter, options({
      model: 'antigravity-gemini-3.8-flash',
      reasoningEffort: ReasoningEffortId('high'),
    }))
    const body = JSON.parse(String(request.mock.calls[0]?.[0].body))
    expect(body).toMatchObject({
      model: 'gemini-3.8-flash-high',
      userAgent: 'antigravity',
      requestType: 'agent',
      request: {
        labels: { model_enum: 'MODEL_PLACEHOLDER_M318' },
        generationConfig: {
          maxOutputTokens: 65536,
          thinkingConfig: { includeThoughts: true, thinkingBudget: -1 },
        },
      },
    })
    expect(body.request.generationConfig.thinkingConfig).not.toHaveProperty('thinkingLevel')
  })

  it('intersects the pinned snapshot with the authenticated live model catalog', async () => {
    const transport = {
      request: vi.fn(async (_input: PrivateTransportRequest) => new Response(JSON.stringify({
        models: {
          'gemini-3.7-flash-medium': { displayName: 'Gemini live' },
          'provider-unknown-model': { displayName: 'Unknown' },
        },
      }))),
    }
    const adapter = new AntigravityAdapter({ auth: { credential: vi.fn(async () => credential('access')) }, transport })

    const models = await adapter.listModels(ANTIGRAVITY_PROVIDER)

    expect(models.map(model => model.id)).toEqual(['antigravity-gemini-3.7-flash'])
    expect(transport.request).toHaveBeenCalledOnce()
    expect(transport.request.mock.calls[0]?.[0]).toMatchObject({
      url: ANTIGRAVITY_AVAILABLE_MODELS_ENDPOINT,
      accessToken: 'access',
    })
    expect(JSON.parse(String(transport.request.mock.calls[0]?.[0].body))).toEqual({ project: 'project-id' })
  })

  it('projects snapshot, live-available, unavailable, refresh-failed, and protocol-drift catalog states safely', async () => {
    const live = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('access')) },
      transport: { request: vi.fn(async () => liveCatalog()) },
    })
    expect(live.catalogSnapshot()).toMatchObject({ state: 'snapshot' })
    const liveView = await live.modelCatalog()
    expect(liveView.state).toBe('live-available')
    expect(liveView.models.find(model => model.id === 'antigravity-gemini-3.7-flash')?.state).toBe('live-available')
    expect(liveView.models.some(model => model.state === 'unavailable')).toBe(true)

    const rateLimited = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('access')) },
      transport: { request: vi.fn(async () => new Response('', { status: 429 })) },
    })
    await expect(rateLimited.modelCatalog()).resolves.toMatchObject({ state: 'refresh-failed' })

    const drifted = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('access')) },
      transport: { request: vi.fn(async () => new Response(JSON.stringify({ models: [] }))) },
    })
    await expect(drifted.modelCatalog()).resolves.toMatchObject({ state: 'protocol-drift' })
  })

  it('keeps exact pinned-model resolution independent from the advisory live catalog', async () => {
    const transport = { request: vi.fn(async () => new Response(JSON.stringify({ models: {} }))) }
    const adapter = new AntigravityAdapter({ auth: { credential: vi.fn(async () => credential('access')) }, transport })

    await expect(adapter.resolveModel(ANTIGRAVITY_PROVIDER, 'antigravity-gemini-3.7-flash')).resolves.toMatchObject({
      provider: ANTIGRAVITY_PROVIDER,
      id: 'antigravity-gemini-3.7-flash',
    })
    expect(transport.request).not.toHaveBeenCalled()
  })

  it('refreshes credentials once when live catalog authentication expires', async () => {
    const auth = {
      credential: vi.fn()
        .mockResolvedValueOnce(credential('old'))
        .mockResolvedValueOnce(credential('new')),
    }
    const transport = {
      request: vi.fn()
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockResolvedValueOnce(liveCatalog()),
    }
    const adapter = new AntigravityAdapter({ auth, transport })

    await expect(adapter.listModels(ANTIGRAVITY_PROVIDER)).resolves.toHaveLength(1)
    expect(auth.credential).toHaveBeenNthCalledWith(2, undefined, { forceRefresh: true })
    expect(transport.request).toHaveBeenCalledTimes(2)
  })

  it('keeps the pinned text snapshot visible when live discovery is rate-limited or drifts', async () => {
    const rateRequest = vi.fn(async () => new Response('', { status: 429 }))
    const rateLimited = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('access')) },
      transport: { request: rateRequest },
    })
    const rateSnapshot = rateLimited.catalogSnapshot().models.map(model => model.id)
    expect(rateSnapshot).toContain('antigravity-gemini-3.8-flash')
    await expect(rateLimited.listModels(ANTIGRAVITY_PROVIDER).then(models => models.map(model => model.id)))
      .resolves.toEqual(rateSnapshot)
    await expect(rateLimited.listModels(ANTIGRAVITY_PROVIDER)).resolves.toHaveLength(rateSnapshot.length)
    await expect(rateLimited.modelCatalog()).resolves.toMatchObject({ state: 'refresh-failed' })
    expect(rateRequest).toHaveBeenCalledOnce()

    const drifted = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('access')) },
      transport: { request: vi.fn(async () => new Response(JSON.stringify({ models: [] }))) },
    })
    const driftSnapshot = drifted.catalogSnapshot().models.map(model => model.id)
    await expect(drifted.listModels(ANTIGRAVITY_PROVIDER).then(models => models.map(model => model.id)))
      .resolves.toEqual(driftSnapshot)
    await expect(drifted.modelCatalog()).resolves.toMatchObject({ state: 'protocol-drift' })
  })

  it('does not advertise pinned models when the successful live intersection is empty', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      models: { 'provider-new-model-id': { displayName: 'New live model' } },
    })))
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('access')) },
      transport: { request },
    })

    await expect(adapter.listModels(ANTIGRAVITY_PROVIDER)).resolves.toEqual([])
    const view = await adapter.modelCatalog()
    expect(view.state).toBe('live-available')
    expect(view.models.every(model => model.state === 'unavailable')).toBe(true)
    expect(request).toHaveBeenCalledOnce()
  })

  it('does not fall back to the pinned text snapshot for missing auth, cancellation, or unclassified failures', async () => {
    const unauthenticated = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => undefined) },
      transport: { request: vi.fn() },
    })
    await expect(unauthenticated.listModels(ANTIGRAVITY_PROVIDER)).rejects.toMatchObject({ code: 'AUTH' })

    const cancelled = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('access')) },
      transport: {
        request: vi.fn(async () => {
          throw new PrivateTransportError('cancelled', 'cancelled')
        }),
      },
    })
    await expect(cancelled.listModels(ANTIGRAVITY_PROVIDER)).rejects.toMatchObject({ code: 'CANCELLED' })

    const unclassified = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('access')) },
      transport: {
        request: vi.fn(async () => {
          throw new Error('unexpected transport failure')
        }),
      },
    })
    await expect(unclassified.listModels(ANTIGRAVITY_PROVIDER)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
  })

  it('keeps authorization denial fail-closed instead of advertising the snapshot', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('access')) },
      transport: { request },
    })

    await expect(adapter.listModels(ANTIGRAVITY_PROVIDER)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('preserves attribution rejection and cancellation from the projectless 403 retry', async () => {
    const attributionRequest = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockRejectedValueOnce(new PrivateTransportError('attribution-rejected', 'redacted', { accepted: false, status: 403 }))
    const attributionRejected = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('access')) },
      transport: { request: attributionRequest },
    })
    await expect(attributionRejected.listModels(ANTIGRAVITY_PROVIDER)).rejects.toMatchObject({ code: 'GATE_0_ATTRIBUTION' })

    const cancelledRequest = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockRejectedValueOnce(new PrivateTransportError('cancelled', 'cancelled'))
    const cancelled = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('access')) },
      transport: { request: cancelledRequest },
    })
    await expect(cancelled.listModels(ANTIGRAVITY_PROVIDER)).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('preserves cancellation while reading a successful live catalog body', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new PrivateTransportError('cancelled', 'cancelled'))
      },
    })
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('access')) },
      transport: { request: vi.fn(async () => new Response(body)) },
    })

    await expect(adapter.listModels(ANTIGRAVITY_PROVIDER)).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('keeps the provider group visible through the public Host model catalog', async () => {
    const ctx = new Context()
    try {
      const runtime = new LlmRuntime(ctx)
      const adapter = new AntigravityAdapter({
        auth: { credential: vi.fn(async () => credential('access')) },
        transport: { request: vi.fn(async () => new Response('', { status: 429 })) },
      })
      runtime.registerAdapter([ANTIGRAVITY_PROVIDER], adapter)

      expect(runtime.listProviders()).toEqual([
        expect.objectContaining({ id: ANTIGRAVITY_PROVIDER }),
      ])
      await expect(runtime.listModels(ANTIGRAVITY_PROVIDER)).resolves.toEqual(
        adapter.catalogSnapshot().models.map(model => expect.objectContaining({
          provider: ANTIGRAVITY_PROVIDER,
          id: model.id,
        })),
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('replays tool results with the original function name correlated by call id', () => {
    const toolCallId = 'call-7'
    const request = options({ messages: [
      {
        id: 'assistant-1',
        role: 'assistant',
        source: { kind: 'model', provider: ANTIGRAVITY_PROVIDER, model: 'antigravity-gemini-3.7-flash' },
        content: [{ type: 'tool-call', id: toolCallId, name: 'lookup_weather', arguments: '{"city":"Paris"}' }],
      } as unknown as Message,
      {
        id: 'tool-1',
        role: 'tool',
        source: { kind: 'tool', callId: toolCallId },
        toolCallId, isError: false,
        content: [{ type: 'text', text: 'sunny' }],
      } as unknown as Message,
    ] })

    const payload = buildAntigravityGeneratePayload(request, credential('access'))
    const contents = (payload.request as { contents: Array<{ parts: unknown[] }> }).contents

    expect(contents[1]?.parts).toEqual([{ functionResponse: { name: 'lookup_weather', response: { content: 'sunny' } } }])
  })

  it('assembles fragmented provider function names in the final public tool block', async () => {
    const transport = {
      request: vi.fn(async ({ url }: PrivateTransportRequest) => url.endsWith(':fetchAvailableModels')
        ? liveCatalog()
        : new Response(
            'data: {"response":{"parts":[{"functionCall":{"id":"call-9","name":"lookup_","args":"{\\"city\\":"}}]}}\n\n'
            + 'data: {"response":{"parts":[{"functionCall":{"id":"call-9","name":"weather","args":"\\"Paris\\"}"}}],"finishReason":"STOP"}}\n\n',
          )),
    }
    const adapter = new AntigravityAdapter({ auth: { credential: vi.fn(async () => credential('access')) }, transport })

    const chunks = await collect(adapter.stream(options()))
    const end = chunks.find(chunk => chunk.type === 'block-end')

    expect(end).toMatchObject({ block: { type: 'tool-call', id: 'call-9', name: 'lookup_weather', arguments: '{"city":"Paris"}' } })
  })

  it('fails Gate 0 closed on secondary-attribution rejection without retrying', async () => {
    const request = vi.fn(async () => {
      throw new PrivateTransportError('attribution-rejected', 'provider-secret-body', { accepted: false, status: 403 })
    })
    const adapter = new AntigravityAdapter({ auth: { credential: vi.fn(async () => credential('access-secret')) }, transport: { request } })

    const operation = adapter.listModels(ANTIGRAVITY_PROVIDER)
    await expect(operation).rejects.toMatchObject({ code: 'GATE_0_ATTRIBUTION' })
    await expect(operation).rejects.not.toThrow(/access-secret|provider-secret-body/u)
    expect(request).toHaveBeenCalledOnce()
  })

  it('rejects unknown models and keeps request payloads free of access tokens', async () => {
    const adapter = new AntigravityAdapter({ auth: { credential: vi.fn(async () => credential('access-secret')) }, transport: { request: vi.fn() } })
    await expect(adapter.resolveModel(ANTIGRAVITY_PROVIDER, 'unknown-model')).rejects.toMatchObject({ code: 'INVALID_MODEL' })
    const payload = buildAntigravityGeneratePayload(options({ tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }] }), credential('access-secret'))
    const encoded = JSON.stringify(payload)
    expect(encoded).toContain('project-id')
    expect(encoded).not.toContain('access-secret')
    expect(encoded).toContain('functionDeclarations')
  })

  it('drops trailing empty text part when tool call is emitted for Gemini', async () => {
    const request = vi.fn(async () => new Response(
      'data: {"response":{"parts":[{"text":"thinking...\\n\\n","thought":true}]}}\n\n'
      + 'data: {"response":{"parts":[{"functionCall":{"id":"call-1","name":"pwsh","args":{"command":"ls"}}}]}}\n\n'
      + 'data: {"response":{"parts":[{"text":""}],"finishReason":"STOP"}}\n\n'
    ))
    const adapter = new AntigravityAdapter({
      auth: { credential: vi.fn(async () => credential('access-secret')) },
      transport: { request },
    })
    const chunks = await collect(adapter.stream(options({ model: 'antigravity-gemini-3.8-flash' })))

    expect(chunks.some(chunk => chunk.type === 'block-start' && chunk.blockType === 'text')).toBe(false)
    const reasoningEnd = chunks.find(chunk => chunk.type === 'block-end' && 'block' in chunk && chunk.block.type === 'reasoning')
    expect(reasoningEnd).toMatchObject({ block: { type: 'reasoning', text: 'thinking...' } })
    const toolCallEnd = chunks.find(chunk => chunk.type === 'block-end' && 'block' in chunk && chunk.block.type === 'tool-call')
    expect(toolCallEnd).toBeDefined()
  })
})
