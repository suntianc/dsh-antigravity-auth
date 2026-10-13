/** Bounded, block-aligned replay metadata for Antigravity model turns. */

import type { ReplayEnvelope, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'

export const ANTIGRAVITY_REPLAY_VERSION = 1 as const
const MAX_SIGNATURE_LENGTH = 16 * 1024
const MAX_BLOCKS = 128

export type ReplayBlockKind = 'text' | 'reasoning' | 'tool-call'

export interface AntigravityReplayBlock {
  readonly kind: ReplayBlockKind
  readonly signature?: string
}

export const ANTIGRAVITY_SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set(['google-antigravity', 'google'])

export function isAntigravityProvider(provider: unknown): provider is 'google-antigravity' | 'google' {
  return typeof provider === 'string' && ANTIGRAVITY_SUPPORTED_PROVIDERS.has(provider)
}

export interface AntigravityReplayResponse {
  readonly version: typeof ANTIGRAVITY_REPLAY_VERSION
  readonly provider: 'google-antigravity' | 'google'
  readonly model: string
  readonly family: 'gemini' | 'claude' | 'gpt-oss' | 'unknown'
  readonly finish?: string
}

export interface AntigravityReplayState extends ReplayEnvelope {
  readonly response: AntigravityReplayResponse
  readonly blocks: readonly AntigravityReplayBlock[]
}

/** Keep only provider-issued signatures and bounded response facts. */
export function createReplayState(
  model: string,
  family: AntigravityReplayResponse['family'],
  finish: string | undefined,
  blocks: readonly AntigravityReplayBlock[],
  provider: string = 'google-antigravity',
): AntigravityReplayState {
  const boundedBlocks: AntigravityReplayBlock[] = blocks.slice(0, MAX_BLOCKS).map(block => {
    const signature = safeSignature(block.signature)
    return { kind: block.kind, ...(signature === undefined ? {} : { signature }) }
  })
  const boundedFinish = safeFinish(finish)
  return {
    response: {
      version: ANTIGRAVITY_REPLAY_VERSION,
      provider: isAntigravityProvider(provider) ? provider : 'google-antigravity',
      model: model.slice(0, 256),
      family,
      ...(boundedFinish === undefined ? {} : { finish: boundedFinish }),
    },
    blocks: boundedBlocks,
  }
}

/** Validate replay metadata before it can affect a later private request. */
export function compatibleReplayState(
  message: Message,
  provider: string,
  model: string,
  blockKinds?: readonly ReplayBlockKind[],
): AntigravityReplayState | undefined {
  if (!isAntigravityProvider(provider) || message.role !== 'assistant') return undefined
  const provenance = isRecord(message.source) ? (message.source as Record<string, unknown>) : undefined
  if (provenance !== undefined && provenance.kind === 'model') {
    if (!isAntigravityProvider(provenance.provider) || provenance.model !== model) return undefined
  }
  const value = isRecord(provenance?.replayState)
    ? provenance.replayState
    : isRecord((message as unknown as Record<string, unknown>).replayState)
      ? (message as unknown as Record<string, unknown>).replayState
      : undefined
  if (!isRecord(value) || !isRecord(value.response) || !Array.isArray(value.blocks)) return undefined
  const family = value.response.family
  if (value.response.version !== ANTIGRAVITY_REPLAY_VERSION
    || !isAntigravityProvider(value.response.provider)
    || value.response.model !== model
    || !isFamily(family)
    || value.blocks.length > MAX_BLOCKS) return undefined
  const blocks: AntigravityReplayBlock[] = []
  for (const item of value.blocks) {
    if (!isRecord(item) || typeof item.kind !== 'string') continue
    const kind = item.kind as ReplayBlockKind
    const signature = typeof item.signature === 'string' && safeSignature(item.signature) !== undefined ? item.signature : undefined
    blocks.push({ kind, ...(signature === undefined ? {} : { signature }) })
  }
  if (blockKinds !== undefined
    && (blocks.length !== blockKinds.length || blocks.some((block, index) => block.kind !== blockKinds[index]))) return undefined
  const finish = value.response.finish === undefined ? undefined : safeFinish(value.response.finish)
  if (value.response.finish !== undefined && finish === undefined) return undefined
  return {
    response: {
      version: ANTIGRAVITY_REPLAY_VERSION,
      provider: isAntigravityProvider(provider) ? provider : 'google-antigravity',
      model,
      family,
      ...(finish === undefined ? {} : { finish }),
    },
    blocks,
  }
}

/** Return the block family without allowing a model alias to cross families. */
export function antigravityModelFamily(model: string): AntigravityReplayResponse['family'] {
  const value = model.toLowerCase()
  if (value.includes('gemini')) return 'gemini'
  if (value.includes('claude')) return 'claude'
  if (value.includes('gpt-oss')) return 'gpt-oss'
  return 'unknown'
}

/** Convert DSH schemas to the small function-declaration subset accepted privately. */
export function sanitizeToolSchemas(tools: readonly ToolSchema[] | undefined): readonly Record<string, unknown>[] {
  if (tools === undefined) return []
  return tools.slice(0, 64).map(tool => ({
    name: boundedName(tool.name),
    description: boundedText(tool.description, 4096),
    parameters: sanitizeSchema(tool.parameters),
  }))
}

export function buildFunctionDeclarations(tools: readonly ToolSchema[] | undefined): readonly Record<string, unknown>[] {
  return sanitizeToolSchemas(tools).map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

function sanitizeSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 8 || !isRecord(value)) return { type: 'object', properties: {} }
  const type = typeof value.type === 'string' && ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(value.type)
    ? value.type
    : 'object'
  const output: Record<string, unknown> = { type }
  if (typeof value.description === 'string') output.description = boundedText(value.description, 1024)
  if (Array.isArray(value.required)) output.required = value.required.filter(item => typeof item === 'string').slice(0, 128)
  if (Array.isArray(value.enum)) output.enum = value.enum.slice(0, 128).filter(item => ['string', 'number', 'boolean', 'null'].includes(typeof item))
  if (type === 'object' && isRecord(value.properties)) {
    const properties: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value.properties).slice(0, 128)) {
      if (!hasControl(key) && key.length > 0) properties[key.slice(0, 128)] = sanitizeSchema(item, depth + 1)
    }
    output.properties = properties
  }
  if (type === 'array') output.items = sanitizeSchema(value.items, depth + 1)
  if (Array.isArray(value.oneOf)) output.oneOf = value.oneOf.slice(0, 8).map(item => sanitizeSchema(item, depth + 1))
  return output
}

function safeFinish(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return undefined
  const normalized = value.toUpperCase()
  return ['STOP', 'MAX_TOKENS', 'LENGTH', 'TOOL_CALLS', 'FUNCTION_CALL', 'SAFETY', 'BLOCKLIST', 'ERROR'].includes(normalized) ? normalized : undefined
}

function safeSignature(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SIGNATURE_LENGTH) return undefined
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return undefined
  }
  return value
}

function boundedName(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && !hasControl(value) ? value.slice(0, 128) : 'unnamed_tool'
}

function boundedText(value: unknown, limit: number): string {
  return typeof value === 'string' && !hasControl(value) ? value.slice(0, limit) : ''
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return true
  }
  return false
}

function isFamily(value: unknown): value is AntigravityReplayResponse['family'] {
  return value === 'gemini' || value === 'claude' || value === 'gpt-oss' || value === 'unknown'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
