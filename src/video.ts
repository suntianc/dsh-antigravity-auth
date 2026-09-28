/** Gated workspace-video understanding proof of concept. */

import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { resolveModelWithTier } from '@cortexkit/antigravity-auth-core'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createAntigravityAuthService } from './auth-service.ts'
import type { AntigravityAuthService } from './auth-service.ts'
import type { CredentialCoordinator, HostCredential } from './credential-coordinator.ts'
import {
  DEFAULT_PRIVATE_RESPONSE_BYTES,
  PrivateTransportError,
  createPrivateTransport,
  privateStatusError,
  readPrivateText,
  type PrivateTransport,
} from './private-transport.ts'
import { admitWorkspaceVideo } from './media-admission.ts'
import { ANTIGRAVITY_WIRE_ORIGIN } from './wire-identity.ts'
import { classifyPrivateFailure, type PrivateFailureKind } from './private-failure.ts'
import { mountCapabilityLifecycle, type CapabilityLifecycle } from './capability-lifecycle.ts'
import { liveValue, type LiveValue } from './volatile-config.ts'

export const name = 'antigravity-video'
export const inject = ['tools', 'fs', 'antigravityAuth']
export const ANALYZE_VIDEO_TOOL_NAME = 'analyze_video'
export const UNDERSTAND_VIDEO_TOOL_NAME = ANALYZE_VIDEO_TOOL_NAME
export const ANTIGRAVITY_VIDEO_ENDPOINT = `${ANTIGRAVITY_WIRE_ORIGIN}/v1internal:generateContent` as const
export const ANTIGRAVITY_VIDEO_MODEL = 'antigravity-gemini-3.7-flash'
export const ANTIGRAVITY_VIDEO_SETTINGS_NAMESPACE = 'antigravity-video'

export interface AntigravityVideoSettings {
  readonly enabled: boolean
  readonly model: string
  readonly maxBytes?: number
}

export interface Config {
  readonly enabled: LiveValue<boolean>
  readonly model: LiveValue<string>
  readonly maxBytes?: LiveValue<number>
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).volatile(),
  model: z.string().default(ANTIGRAVITY_VIDEO_MODEL).volatile(),
  maxBytes: z.number().step(1).min(1).max(32 * 1024 * 1024).default(32 * 1024 * 1024).volatile(),
}) as unknown as z<Config>

export interface AntigravityVideoToolOptions {
  readonly auth: Pick<CredentialCoordinator, 'credential'> | { credential(signal?: AbortSignal): Promise<HostCredential | undefined> }
  readonly fs: Pick<FileSystem, 'resolve' | 'contains' | 'readBytes' | 'lstat' | 'stat'>
  readonly settings?: () => AntigravityVideoSettings
  readonly transport?: PrivateTransport
}

export class AntigravityVideoError extends HarnessError {}

export interface VideoAnalysisResult {
  readonly text: string
  readonly usage?: TokenUsage
}

export function createAntigravityVideoTools(options: AntigravityVideoToolOptions): readonly ToolDefinition[] {
  const fixedOptions: AntigravityVideoToolOptions = {
    ...options,
    transport: options.transport ?? createPrivateTransport({ maxRequestBytes: 48 * 1024 * 1024 }),
  }
  return [{
    name: ANALYZE_VIDEO_TOOL_NAME,
    description: 'Analyze an explicit MP4 file inside the active workspace with the gated Antigravity video POC.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 4096 },
        prompt: { type: 'string', minLength: 1, maxLength: 16_384 },
        model: { type: 'string', maxLength: 256 },
      },
      required: ['path', 'prompt'],
      additionalProperties: false,
    },
    output: {
      schema: videoSchema,
      render: (_args, value) => [{ type: 'text', text: (value as unknown as VideoAnalysisResult).text }],
      presentationMeta: (_args, value) => value,
    },
    execute: async (args, exec) => executeVideo(fixedOptions, args, exec),
    isConcurrencySafe: () => false,
  }]
}

async function executeVideo(options: AntigravityVideoToolOptions, rawArgs: unknown, exec: ToolRunContext): Promise<VideoAnalysisResult> {
  const settings = options.settings?.() ?? { enabled: true, model: ANTIGRAVITY_VIDEO_MODEL }
  if (!settings.enabled) throw new AntigravityVideoError('Antigravity Video is disabled by its capability gate', 'VIDEO_DISABLED')
  const args = parseArgs(rawArgs, settings)
  const agent = requireAgent(exec)
  const credential = await options.auth.credential(exec.signal)
  if (credential === undefined) throw new AntigravityVideoError('Antigravity Video requires a logged-in account', 'VIDEO_AUTH_REQUIRED')
  const cwd = workspaceCwd(agent)
  const admitted = await admitWorkspaceVideo({ fs: options.fs, ...(settings.maxBytes === undefined ? {} : { maxVideoBytes: settings.maxBytes }) }, cwd, args.path, exec.signal)
  const transport = options.transport
  if (transport === undefined) throw new AntigravityVideoError('The Antigravity Video transport is unavailable', 'VIDEO_FAILED')
  let response: Response
  try {
    response = await transport.request({
      url: ANTIGRAVITY_VIDEO_ENDPOINT,
      accessToken: credential.accessToken,
      body: JSON.stringify(buildVideoPayload(args.prompt, args.model, credential, admitted.data)),
      signal: exec.signal,
    })
  } catch (error) { throw toVideoError(error) }
  const statusError = privateStatusError(response.status)
  if (statusError !== undefined) {
    await response.body?.cancel().catch(() => {})
    throw toVideoError(statusError)
  }
  let value: unknown
  try { value = JSON.parse(await readPrivateText(response, { signal: exec.signal, maxBytes: DEFAULT_PRIVATE_RESPONSE_BYTES })) as unknown } catch (error) { throw toVideoError(error) }
  const text = extractText(value)
  if (text === undefined) throw new AntigravityVideoError('Antigravity Video returned no text understanding', 'VIDEO_RESPONSE_EMPTY')
  const usage = extractUsage(value)
  return { text, ...(usage === undefined ? {} : { usage }) }
}

export function buildVideoPayload(
  prompt: string,
  model: string,
  credential: Pick<HostCredential, 'projectId'>,
  data: Uint8Array,
): Record<string, unknown> {
  const project = credential.projectId === 'inductive-dreamer-qrkws' || !credential.projectId ? undefined : credential.projectId
  const resolved = resolveModelWithTier(model, { cli_first: false })
  const wireModel = resolved.actualModel.startsWith('gemini-3.7-flash') ? 'gemini-3-flash' : resolved.actualModel
  return {
    ...(project === undefined ? {} : { project }),
    model: wireModel,
    request: {
      contents: [{ role: 'user', parts: [
        { text: prompt },
        { inlineData: { mimeType: 'video/mp4', data: Buffer.from(data).toString('base64') } },
      ] }],
    },
  }
}

export function apply(ctx?: Context, config: Config = { enabled: true, model: ANTIGRAVITY_VIDEO_MODEL, maxBytes: 32 * 1024 * 1024 }): void {
  if (ctx === undefined) return
  const candidate = ctx as unknown as {
    tools?: { register: (definition: ToolDefinition) => () => void }
    fs?: AntigravityVideoToolOptions['fs']
    get?: (name: string) => unknown
  }
  if (candidate.tools === undefined || candidate.fs === undefined) return
  const current = (): AntigravityVideoSettings => ({
    enabled: liveValue(config.enabled), model: liveValue(config.model),
    ...(config.maxBytes === undefined ? {} : { maxBytes: liveValue(config.maxBytes) }),
  })
  let lifecycle: CapabilityLifecycle | undefined
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
  })
  ctx.on('loader/volatile-update', () => { lifecycle?.sync() })
  const provided = candidate.get?.('antigravityAuth')
  const auth = isAuthService(provided) ? provided : createAntigravityAuthService()
  lifecycle = mountCapabilityLifecycle({
    ctx,
    auth,
    id: 'video',
    enabled: () => current().enabled,
    register: () => {
      const disposers = createAntigravityVideoTools({ auth, fs: candidate.fs!, settings: () => current() }).map(tool => candidate.tools!.register(tool))
      return () => { for (const dispose of disposers.reverse()) dispose() }
    },
    ownsAuth: auth !== provided,
    label: 'antigravity-video: tool lifecycle',
  })
}

function isAuthService(value: unknown): value is AntigravityAuthService {
  return isRecord(value) && typeof value.credential === 'function' && typeof value.status === 'function'
}

function extractText(value: unknown): string | undefined {
  const output: string[] = []
  let outputLength = 0
  const visit = (item: unknown, depth = 0): void => {
    if (depth > 32 || outputLength >= 64 * 1024) return
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return }
    if (!isRecord(item)) return
    if (Array.isArray(item.parts)) {
      for (const part of item.parts) {
        if (!isRecord(part) || typeof part.text !== 'string' || hasControl(part.text)) continue
        const text = part.text.slice(0, 64 * 1024 - outputLength)
        output.push(text)
        outputLength += text.length
      }
    }
    if (isRecord(item.response)) visit(item.response, depth + 1)
    if (isRecord(item.content)) visit(item.content, depth + 1)
    if (Array.isArray(item.candidates)) visit(item.candidates, depth + 1)
    if (isRecord(item.serverContent)) visit(item.serverContent, depth + 1)
    if (isRecord(item.modelTurn)) visit(item.modelTurn, depth + 1)
  }
  visit(value)
  const text = output.join('').trim()
  return text.length === 0 ? undefined : text.slice(0, 64 * 1024)
}

function extractUsage(value: unknown): TokenUsage | undefined {
  const visit = (item: unknown, depth = 0): TokenUsage | undefined => {
    if (depth > 32) return undefined
    if (Array.isArray(item)) {
      for (const child of item) {
        const result = visit(child, depth + 1)
        if (result !== undefined) return result
      }
      return undefined
    }
    if (!isRecord(item)) return undefined
    const raw = isRecord(item.usageMetadata) ? item.usageMetadata : isRecord(item.usage_metadata) ? item.usage_metadata : isRecord(item.usage) ? item.usage : undefined
    if (raw !== undefined) {
      const input = safeCount(raw.promptTokenCount ?? raw.inputTokenCount)
      const output = safeCount(raw.candidatesTokenCount ?? raw.outputTokenCount)
      const cached = safeCount(raw.cachedContentTokenCount ?? raw.cacheReadTokens)
      const reasoning = safeCount(raw.thoughtsTokenCount ?? raw.reasoningTokenCount)
      if (input !== undefined || output !== undefined || cached !== undefined || reasoning !== undefined) {
        return { inputTokens: input ?? 0, outputTokens: output ?? 0, ...(cached === undefined ? {} : { cacheReadTokens: cached }), ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }) }
      }
    }
    for (const key of ['response', 'candidates', 'serverContent']) {
      const result = visit(item[key], depth + 1)
      if (result !== undefined) return result
    }
    return undefined
  }
  return visit(value)
}

function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function parseArgs(value: unknown, settings: AntigravityVideoSettings): { path: string; prompt: string; model: string } {
  if (!isRecord(value) || hasExtra(value, ['path', 'prompt', 'model']) || typeof value.path !== 'string' || typeof value.prompt !== 'string' || value.path.length === 0 || value.path.length > 4096 || value.prompt.trim().length === 0 || value.prompt.length > 16_384) {
    throw new AntigravityVideoError('analyze_video expects a closed path and prompt object', 'INVALID_ARGS')
  }
  const model = value.model === undefined ? settings.model : value.model
  if (typeof model !== 'string' || model.trim().length === 0 || model.length > 256) throw new AntigravityVideoError('The video model is invalid', 'INVALID_ARGS')
  return { path: value.path, prompt: value.prompt.trim().slice(0, 16_384), model: model.trim() }
}

function requireAgent(exec: ToolRunContext): Agent {
  if (exec.agent === undefined) throw new AntigravityVideoError('Video analysis requires an active workspace', 'VIDEO_WORKSPACE_REQUIRED')
  workspaceCwd(exec.agent)
  return exec.agent
}

function workspaceCwd(agent: Agent): string {
  const cwd = agent.session.header.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) throw new AntigravityVideoError('Video analysis requires an active workspace', 'VIDEO_WORKSPACE_REQUIRED')
  return cwd
}

const VIDEO_FAILURE_CODES: Readonly<Record<PrivateFailureKind, string>> = {
  authentication: 'VIDEO_AUTH_REQUIRED',
  forbidden: 'VIDEO_FORBIDDEN',
  'rate-limited': 'VIDEO_RATE_LIMITED',
  cancelled: 'VIDEO_CANCELLED',
  timeout: 'VIDEO_TIMEOUT',
  'attribution-rejected': 'VIDEO_PROTOCOL_DRIFT',
  'protocol-drift': 'VIDEO_PROTOCOL_DRIFT',
  'response-limit': 'VIDEO_PROTOCOL_DRIFT',
  'request-limit': 'VIDEO_PROTOCOL_DRIFT',
  upstream: 'VIDEO_FAILED',
  network: 'VIDEO_FAILED',
  failed: 'VIDEO_FAILED',
}

function toVideoError(error: unknown): AntigravityVideoError {
  if (error instanceof AntigravityVideoError) return error
  if (error instanceof PrivateTransportError) {
    return new AntigravityVideoError('The Antigravity Video request failed safely', VIDEO_FAILURE_CODES[classifyPrivateFailure(error)])
  }
  return new AntigravityVideoError('The Antigravity Video request failed safely', 'VIDEO_FAILED')
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return true
  }
  return false
}

function hasExtra(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).some(key => !allowed.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const videoSchema: JsonSchemaNode = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    usage: {
      type: 'object',
      properties: {
        inputTokens: { type: 'integer' },
        outputTokens: { type: 'integer' },
        cacheReadTokens: { type: 'integer' },
        reasoningTokens: { type: 'integer' },
      },
      required: ['inputTokens', 'outputTokens'],
      additionalProperties: false,
    },
  },
  required: ['text'],
  additionalProperties: false,
}
