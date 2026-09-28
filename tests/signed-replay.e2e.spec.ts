/**
 * End-to-end regression guard for the Antigravity HTTP 400 / PROTOCOL_DRIFT defect.
 *
 * The injected transport behaves the way the private endpoint does for Gemini
 * thinking models: a replayed model turn whose functionCall carries neither a
 * provider-issued thinking signature nor the documented skip validator is
 * rejected with HTTP 400. That is precisely the failure recorded in the
 * affected sessions, where a turn replied with reasoning plus a tool call and
 * the follow-up request replaying that history was refused.
 */
import { describe, expect, it } from 'vitest'
import { AntigravityAdapter, ANTIGRAVITY_PROVIDER } from '../src/llm-adapter.ts'
import type { HostCredential } from '../src/credential-coordinator.ts'
import type { PrivateTransportRequest } from '../src/private-transport.ts'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

const credential = (token: string): HostCredential => ({
  accessToken: token,
  refreshToken: 'refresh',
  expiresAt: Date.parse('2030-01-01T00:00:00.000Z'),
  projectId: 'project-id',
})

/** Signature values the endpoint accepts on a replayed functionCall. */
const REAL_SIGNATURE = 'gemini-issued-thought-signature'
const SKIP_VALIDATOR = 'skip_thought_signature_validator'

interface RecordedContent {
  readonly role: string
  readonly parts: Array<Record<string, unknown>>
}

function acceptedSignature(part: Record<string, unknown>): boolean {
  const signature = part.thoughtSignature
  return signature === REAL_SIGNATURE || signature === SKIP_VALIDATOR
}

/** Provider rule: every replayed model functionCall must be signed or skipped. */
function hasUnsignedFunctionCall(contents: readonly RecordedContent[]): boolean {
  for (const content of contents) {
    if (content.role !== 'model') continue
    for (const part of content.parts) {
      if (part.functionCall !== undefined && !acceptedSignature(part)) return true
    }
  }
  return false
}

function providerProbe(): (input: PrivateTransportRequest) => Promise<Response> {
  return async (input: PrivateTransportRequest) => {
    const payload = JSON.parse(String(input.body)) as { request?: { contents?: RecordedContent[] } }
    const contents = payload.request?.contents ?? []
    if (hasUnsignedFunctionCall(contents)) {
      return new Response(
        JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'missing thought signature' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('data: {"response":{"parts":[{"text":"done"}],"finishReason":"STOP"}}\n\n')
  }
}

/** The persisted history shape that used to fail: reasoning plus an unsigned call. */
function driftingHistory(model: string): Message[] {
  const user: Message = {
    id: 'user-1' as never,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'list the files' }],
  }
  const toolCallId = 'call-e2e-1'
  const assistant = {
    id: 'assistant-1',
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'I should inspect the directory first.' },
      { type: 'tool-call', id: toolCallId, name: 'glob', arguments: '{"pattern":"*"}' },
    ],
    source: { kind: 'model', provider: ANTIGRAVITY_PROVIDER, model },
  } as unknown as Message
  const toolResult: Message = {
    id: 'result-1' as never,
    role: 'tool',
    source: { kind: 'tool', callId: toolCallId as never },
    toolCallId: toolCallId as never, isError: false,
    content: [{ type: 'text', text: 'a.ts' }],
  }
  return [user, assistant, toolResult]
}

function options(model: string): GenerateOptions {
  return {
    provider: ANTIGRAVITY_PROVIDER,
    model,
    messages: driftingHistory(model),
    tools: [{
      name: 'glob',
      description: 'Find files',
      parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
    }],
  }
}

async function collect(adapter: AntigravityAdapter, input: GenerateOptions) {
  const chunks = []
  for await (const chunk of adapter.stream(input)) chunks.push(chunk)
  return chunks
}

describe('Antigravity signed replay', () => {
  it('signs a replayed reasoning-plus-tool-call history the provider would otherwise reject', async () => {
    const probe = providerProbe()
    let observed: readonly RecordedContent[] = []
    const adapter = new AntigravityAdapter({
      auth: { credential: async () => credential('opaque-test-value') },
      transport: {
        request: async input => {
          const payload = JSON.parse(String(input.body)) as { request?: { contents?: RecordedContent[] } }
          observed = payload.request?.contents ?? []
          return await probe(input)
        },
      },
    })

    const chunks = await collect(adapter, options('antigravity-gemini-3.7-flash'))
    const finish = chunks.at(-1)
    expect(finish).toMatchObject({ type: 'finish' })
    if (finish?.type === 'finish') expect(finish.reason.kind).toBe('stop')
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'done' }))
    expect(hasUnsignedFunctionCall(observed)).toBe(false)
  })

  it('prefers a real thinking signature carried by the replayed block', async () => {
    const model = 'antigravity-gemini-3.7-flash'
    const messages = driftingHistory(model)
    const assistant = messages[1] as unknown as { content: Array<Record<string, unknown>>; source: Record<string, unknown> }
    assistant.source.replayState = {
      response: { version: 1, provider: ANTIGRAVITY_PROVIDER, model, family: 'gemini', finish: 'STOP' },
      blocks: [{ kind: 'reasoning', signature: REAL_SIGNATURE }, { kind: 'tool-call' }],
    }

    let observed: readonly RecordedContent[] = []
    const adapter = new AntigravityAdapter({
      auth: { credential: async () => credential('opaque-test-value') },
      transport: {
        request: async input => {
          const payload = JSON.parse(String(input.body)) as { request?: { contents?: RecordedContent[] } }
          observed = payload.request?.contents ?? []
          return new Response('data: {"response":{"parts":[{"text":"ok"}],"finishReason":"STOP"}}\n\n')
        },
      },
    })

    await collect(adapter, { provider: ANTIGRAVITY_PROVIDER, model, messages })
    const callPart = observed
      .flatMap(content => content.parts)
      .find(part => part.functionCall !== undefined)
    expect(callPart?.thoughtSignature).toBe(REAL_SIGNATURE)
  })

  it('still reports a genuine HTTP 400 rejection as a protocol-drift failure', async () => {
    const adapter = new AntigravityAdapter({
      auth: { credential: async () => credential('opaque-test-value') },
      transport: {
        request: async () => new Response('rejected', { status: 400 }),
      },
    })

    await expect(collect(adapter, options('antigravity-gemini-3.7-flash'))).rejects.toMatchObject({
      code: 'PROTOCOL_DRIFT',
      message: expect.stringContaining('HTTP 400'),
    })
  })
})
