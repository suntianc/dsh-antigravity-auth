/** Antigravity image generation/editing tools and session-authorized image catalog. */

import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { resolveModelWithTier } from '@cortexkit/antigravity-auth-core'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { HarnessError } from '@deepseek-ai/dsh-llm'
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
import {
  admitBase64Image,
  admitSessionImage,
  admitWorkspaceImage,
  imageHandle,
  IMAGE_HANDLE_PATTERN,
  sessionImageCatalog,
  type MediaAdmissionOptions,
} from './media-admission.ts'
import { ANTIGRAVITY_WIRE_ORIGIN } from './wire-identity.ts'
import { classifyPrivateFailure, type PrivateFailureKind } from './private-failure.ts'
import { mountCapabilityLifecycle, registerCapabilitySet, type CapabilityLifecycle } from './capability-lifecycle.ts'
import { liveValue, type LiveValue } from './volatile-config.ts'

export const name = 'antigravity-image'
export const inject = ['tools', 'attachments', 'fs', 'antigravityAuth']
export const GENERATE_IMAGE_TOOL_NAME = 'generate_image'
export const LIST_IMAGES_TOOL_NAME = 'list_images'
export const ANTIGRAVITY_IMAGE_ENDPOINT = `${ANTIGRAVITY_WIRE_ORIGIN}/v1internal:generateContent` as const
export const ANTIGRAVITY_IMAGE_MODEL = 'antigravity-gemini-3.1-flash-image'
export const ANTIGRAVITY_IMAGE_SETTINGS_NAMESPACE = 'antigravity-image'

export interface Config {
  readonly enabled: LiveValue<boolean>
  readonly model: LiveValue<string>
  readonly n: LiveValue<number>
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).volatile(),
  model: z.string().default(ANTIGRAVITY_IMAGE_MODEL).volatile(),
  n: z.number().step(1).min(1).max(4).default(1).volatile(),
}) as unknown as z<Config>

const MAX_REFERENCES = 5
const MAX_IMAGES = 4
const IMAGE_ORIGINS = ['all', 'generated', 'reference', 'user'] as const
const generateSchema: JsonSchemaNode = {
  type: 'object',
  properties: {
    operation: { type: 'string', enum: ['generate', 'edit'] },
    images: { type: 'array', items: { type: 'object' } },
    references: { type: 'array', items: { type: 'object' } },
    warnings: { type: 'array', items: { type: 'object' } },
  },
  required: ['operation', 'images', 'references', 'warnings'],
  additionalProperties: false,
}
const listSchema: JsonSchemaNode = {
  type: 'object',
  properties: {
    items: { type: 'array', items: { type: 'object' } },
    nextCursor: { type: 'string' },
  },
  required: ['items'],
  additionalProperties: false,
}

type ImageOrigin = (typeof IMAGE_ORIGINS)[number]
type ImageReference = { readonly kind: 'session'; readonly handle: string } | { readonly kind: 'workspace'; readonly path: string }

export interface AntigravityImageSettings {
  readonly enabled: boolean
  readonly model: string
  readonly n: number
}

export interface AntigravityImageToolOptions {
  readonly auth: Pick<CredentialCoordinator, 'credential'> | { credential(signal?: AbortSignal): Promise<HostCredential | undefined> }
  readonly attachments: Pick<AttachmentStore, 'imageLimits' | 'validateImage' | 'saveImage' | 'readImage'>
  readonly fs: Pick<FileSystem, 'resolve' | 'contains' | 'readBytes' | 'lstat' | 'stat'>
  readonly settings?: () => AntigravityImageSettings
  readonly transport?: PrivateTransport
}

export class AntigravityImageError extends HarnessError {}

interface ImageItem {
  readonly handle: `image:${string}`
  readonly attachment: ImageAttachmentRef
  readonly origin: Exclude<ImageOrigin, 'all'>
  readonly seq: number
}

interface GenerateResult {
  readonly operation: 'generate' | 'edit'
  readonly images: readonly ImageItem[]
  readonly references: readonly ImageItem[]
  readonly warnings: readonly { readonly index: number; readonly code: string }[]
}

interface ListResult {
  readonly items: readonly ImageItem[]
  readonly nextCursor?: string
}

export function createAntigravityImageTools(options: AntigravityImageToolOptions): readonly ToolDefinition[] {
  const fixedOptions: AntigravityImageToolOptions = { ...options, transport: options.transport ?? createPrivateTransport() }
  return [createGenerateTool(fixedOptions), createListTool(fixedOptions)]
}

function createGenerateTool(options: AntigravityImageToolOptions): ToolDefinition {
  return {
    name: GENERATE_IMAGE_TOOL_NAME,
    description: 'Generate or edit bounded Antigravity images and return durable session image handles.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 16_384 },
        references: {
          type: 'array',
          maxItems: MAX_REFERENCES,
          items: { oneOf: [
            { type: 'object', properties: { kind: { const: 'session' }, handle: { type: 'string' } }, required: ['kind', 'handle'], additionalProperties: false },
            { type: 'object', properties: { kind: { const: 'workspace' }, path: { type: 'string' } }, required: ['kind', 'path'], additionalProperties: false },
          ] },
        },
        model: { type: 'string' },
        n: { type: 'integer', minimum: 1, maximum: MAX_IMAGES },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: generateSchema,
      render: (_args, value) => renderGenerate(value as unknown as GenerateResult),
      presentationMeta: (_args, value) => value,
    },
    execute: async (args, exec) => executeGenerate(options, args, exec),
    isConcurrencySafe: () => false,
  }
}

function createListTool(options: AntigravityImageToolOptions): ToolDefinition {
  return {
    name: LIST_IMAGES_TOOL_NAME,
    description: 'List durable image handles authorized by the current session with bounded pagination.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 20 },
        cursor: { type: 'string' },
        origin: { type: 'string', enum: [...IMAGE_ORIGINS] },
      },
      additionalProperties: false,
    },
    output: {
      schema: listSchema,
      render: (_args, value) => renderList(value as unknown as ListResult),
      presentationMeta: (_args, value) => value,
    },
    execute: async (args, exec) => executeList(options, args, exec),
    isConcurrencySafe: () => true,
  }
}

async function executeGenerate(options: AntigravityImageToolOptions, rawArgs: unknown, exec: ToolRunContext): Promise<GenerateResult> {
  const settings = options.settings?.() ?? { enabled: true, model: ANTIGRAVITY_IMAGE_MODEL, n: 1 }
  if (!settings.enabled) throw new AntigravityImageError('Antigravity Image is disabled by its capability gate', 'IMAGE_DISABLED')
  const args = parseGenerateArgs(rawArgs, settings)
  const credential = await requireCredential(options.auth, exec.signal)
  const agent = requireAgent(exec)
  const cwd = workspaceCwd(agent)
  const admission: MediaAdmissionOptions = { attachments: options.attachments, fs: options.fs }
  const references: ImageItem[] = []
  const referenceParts: Record<string, unknown>[] = []
  for (const [index, reference] of args.references.entries()) {
    const admitted = reference.kind === 'session'
      ? await admitSessionImage(admission, agent, reference.handle, exec.signal)
      : await admitWorkspaceImage(admission, cwd, reference.path, exec.signal)
    const stored = admitted.stored ?? { ref: await options.attachments.saveImage(admitted.input), data: admitted.input.data }
    const item: ImageItem = { handle: imageHandle(stored.ref), attachment: stored.ref, origin: 'reference', seq: index }
    references.push(item)
    referenceParts.push({ inlineData: { mimeType: stored.ref.mediaType, data: Buffer.from(stored.data).toString('base64') } })
  }
  const transport = options.transport
  if (transport === undefined) throw new AntigravityImageError('The Antigravity Image transport is unavailable', 'IMAGE_FAILED')
  const body = buildImagePayload(args.prompt, args.model, credential, referenceParts)
  const images: ImageItem[] = []
  const warnings: Array<{ index: number; code: string }> = []
  let firstFailure: AntigravityImageError | undefined
  for (let index = 0; index < args.n; index += 1) {
    let response: Response
    try {
      response = await transport.request({ url: ANTIGRAVITY_IMAGE_ENDPOINT, accessToken: credential.accessToken, body: JSON.stringify(body), signal: exec.signal })
    } catch (error) {
      const failure = toImageError(error)
      if (failure.code === 'IMAGE_CANCELLED') throw failure
      firstFailure ??= failure
      warnings.push({ index, code: imageRequestWarning(failure.code) })
      continue
    }
    const statusError = privateStatusError(response.status)
    if (statusError !== undefined) {
      await response.body?.cancel().catch(() => {})
      const failure = toImageError(statusError)
      firstFailure ??= failure
      warnings.push({ index, code: imageRequestWarning(failure.code) })
      continue
    }
    let envelope: unknown
    try { envelope = JSON.parse(await readPrivateText(response, { signal: exec.signal, maxBytes: DEFAULT_PRIVATE_RESPONSE_BYTES })) as unknown } catch (error) {
      const failure = toImageError(error)
      if (failure.code === 'IMAGE_CANCELLED') throw failure
      firstFailure ??= failure
      warnings.push({ index, code: 'IMAGE_RESPONSE_INVALID' })
      continue
    }
    const candidate = collectInlineData(envelope)[0]
    if (candidate === undefined) {
      firstFailure ??= new AntigravityImageError('Antigravity Image returned no admitted inlineData', 'IMAGE_RESPONSE_EMPTY')
      warnings.push({ index, code: 'IMAGE_RESPONSE_EMPTY' })
      continue
    }
    try {
      const admitted = await admitBase64Image(options, candidate.data, 'inline', `generated-${String(index + 1)}`, exec.signal)
      if (candidate.mediaType !== undefined && normalizeImageMime(candidate.mediaType) !== admitted.input.mediaType) {
        throw new AntigravityImageError('The declared image MIME did not match the admitted magic bytes', 'IMAGE_MIME_MISMATCH')
      }
      const attachment = await options.attachments.saveImage(admitted.input)
      images.push({ handle: imageHandle(attachment), attachment, origin: 'generated', seq: index })
    } catch (error) {
      if (exec.signal?.aborted === true) throw new AntigravityImageError('Antigravity Image generation was cancelled', 'IMAGE_CANCELLED')
      if (error instanceof AntigravityImageError && error.code === 'MEDIA_CANCELLED') throw new AntigravityImageError('Antigravity Image generation was cancelled', 'IMAGE_CANCELLED')
      const failure = error instanceof AntigravityImageError && error.code === 'IMAGE_MIME_MISMATCH'
        ? error
        : new AntigravityImageError('The generated image failed media admission', 'IMAGE_ADMISSION_FAILED')
      firstFailure ??= failure
      warnings.push({ index, code: failure.code })
    }
  }
  if (images.length === 0) {
    if (firstFailure !== undefined) throw firstFailure
    throw new AntigravityImageError('No generated image passed media admission', 'IMAGE_RESPONSE_INVALID')
  }
  return { operation: references.length === 0 ? 'generate' : 'edit', images, references, warnings }
}

async function executeList(options: AntigravityImageToolOptions, rawArgs: unknown, exec: ToolRunContext): Promise<ListResult> {
  const settings = options.settings?.() ?? { enabled: true, model: ANTIGRAVITY_IMAGE_MODEL, n: 1 }
  if (!settings.enabled) throw new AntigravityImageError('Antigravity Image is disabled by its capability gate', 'IMAGE_DISABLED')
  await requireCredential(options.auth, exec.signal)
  const agent = requireAgent(exec)
  const args = parseListArgs(rawArgs)
  let items = collectImages(agent)
  if (args.origin !== 'all') items = items.filter(item => item.origin === args.origin)
  if (args.cursor !== undefined) items = afterCursor(items, args.cursor, args.origin)
  const selected = items.slice(0, args.limit)
  return {
    items: selected,
    ...(items.length > selected.length && selected.length > 0 ? { nextCursor: encodeCursor(selected[selected.length - 1]!, args.origin) } : {}),
  }
}

function buildImagePayload(
  prompt: string,
  model: string,
  credential: Pick<HostCredential, 'projectId'>,
  referenceParts: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const resolved = resolveModelWithTier(model, { cli_first: false })
  if (resolved.isImageModel !== true) throw new AntigravityImageError('The selected Antigravity model is not an image model', 'INVALID_ARGS')
  const project = credential.projectId === 'inductive-dreamer-qrkws' || !credential.projectId ? undefined : credential.projectId
  return {
    ...(project === undefined ? {} : { project }),
    model: resolved.actualModel,
    request: {
      contents: [{ role: 'user', parts: [{ text: prompt }, ...referenceParts] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    },
  }
}

function normalizeImageMime(value: string): string | undefined {
  const normalized = value.trim().toLowerCase()
  return normalized === 'image/png' || normalized === 'image/jpeg' || normalized === 'image/webp' || normalized === 'image/gif'
    ? normalized
    : undefined
}

function collectInlineData(value: unknown): Array<{ readonly data: string; readonly mediaType?: string }> {
  const output: Array<{ data: string; mediaType?: string }> = []
  const visit = (item: unknown, depth = 0): void => {
    if (output.length >= MAX_IMAGES || depth > 32) return
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return }
    if (!isRecord(item)) return
    const inline = isRecord(item.inlineData) ? item.inlineData : isRecord(item.inline_data) ? item.inline_data : undefined
    if (inline !== undefined && typeof inline.data === 'string') {
      const mediaType = inline.mimeType ?? inline.mime_type
      output.push({ data: inline.data, ...(typeof mediaType === 'string' ? { mediaType } : {}) })
      return
    }
    for (const child of Object.values(item)) visit(child, depth + 1)
  }
  visit(value)
  return output
}

function collectImages(agent: Agent): ImageItem[] {
  return sessionImageCatalog(agent)
    .map(entry => ({ handle: entry.handle, attachment: entry.attachment, origin: entry.origin, seq: entry.sequence }))
    .sort((left, right) => right.seq - left.seq || String(right.attachment.attachmentId).localeCompare(String(left.attachment.attachmentId)))
}

function renderGenerate(value: GenerateResult): ContentBlock[] {
  return [
    { type: 'text', text: `Created ${String(value.images.length)} durable image(s): ${value.images.map(item => item.handle).join(', ')}.` },
    ...value.references.map(item => ({ type: 'image' as const, attachment: item.attachment })),
    ...value.images.map(item => ({ type: 'image' as const, attachment: item.attachment })),
  ]
}

function renderList(value: ListResult): ContentBlock[] {
  return [
    { type: 'text', text: value.items.length === 0 ? 'No authorized session images matched.' : value.items.map(item => `${item.handle} (${item.origin})`).join(', ') },
    ...value.items.map(item => ({ type: 'image' as const, attachment: item.attachment })),
  ]
}

/** Mount tools when a ToolRuntime is available; the tool bodies recheck the credential gate. */
export function apply(ctx?: Context, config: Config = { enabled: true, model: ANTIGRAVITY_IMAGE_MODEL, n: 1 }): void {
  if (ctx === undefined) return
  const candidate = ctx as unknown as {
    tools?: { register: (definition: ToolDefinition) => () => void }
    attachments?: AntigravityImageToolOptions['attachments']
    fs?: AntigravityImageToolOptions['fs']
    get?: (name: string) => unknown
  }
  if (candidate.tools === undefined || candidate.attachments === undefined || candidate.fs === undefined) return
  const current = (): AntigravityImageSettings => ({
    enabled: liveValue(config.enabled), model: liveValue(config.model), n: liveValue(config.n),
  })
  let lifecycle: CapabilityLifecycle | undefined
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
  })
  ctx.on('loader/volatile-update', () => { lifecycle?.sync() })
  const provided = candidate.get?.('antigravityAuth')
  const auth = isAuthService(provided) ? provided : createAntigravityAuthService()
  const options: AntigravityImageToolOptions = { auth, attachments: candidate.attachments!, fs: candidate.fs!, settings: () => current() }
  lifecycle = mountCapabilityLifecycle({
    ctx,
    auth,
    id: 'image',
    enabled: () => current().enabled,
    register: () => registerCapabilitySet(
      createAntigravityImageTools(options),
      tool => candidate.tools!.register(tool),
    ),
    ownsAuth: auth !== provided,
    label: 'antigravity-image: tool lifecycle',
  })
}

async function requireCredential(auth: AntigravityImageToolOptions['auth'], signal?: AbortSignal): Promise<HostCredential> {
  const credential = await auth.credential(signal)
  if (credential === undefined) throw new AntigravityImageError('Antigravity Image requires a logged-in account', 'IMAGE_AUTH_REQUIRED')
  return credential
}

function requireAgent(exec: ToolRunContext): Agent {
  if (exec.agent === undefined) throw new AntigravityImageError('Antigravity Image requires an active session', 'IMAGE_AGENT_REQUIRED')
  workspaceCwd(exec.agent)
  return exec.agent
}

function workspaceCwd(agent: Agent): string {
  const cwd = agent.session.header.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) throw new AntigravityImageError('Antigravity Image requires an active workspace', 'IMAGE_WORKSPACE_REQUIRED')
  return cwd
}

function parseGenerateArgs(value: unknown, settings: AntigravityImageSettings): { prompt: string; references: ImageReference[]; model: string; n: number } {
  if (!isRecord(value) || hasExtra(value, ['prompt', 'references', 'model', 'n']) || typeof value.prompt !== 'string' || value.prompt.trim().length === 0 || value.prompt.length > 16_384) {
    throw new AntigravityImageError('generate_image expects a closed prompt object', 'INVALID_ARGS')
  }
  const refs = value.references === undefined ? [] : parseReferences(value.references)
  const model = nonBlank(value.model ?? settings.model)
  const n = integer(value.n ?? settings.n, 1, MAX_IMAGES)
  return { prompt: value.prompt.trim().slice(0, 16_384), references: refs, model, n }
}

function parseReferences(value: unknown): ImageReference[] {
  if (!Array.isArray(value) || value.length > MAX_REFERENCES) throw new AntigravityImageError('references exceed the bounded limit', 'INVALID_ARGS')
  return value.map(item => {
    if (!isRecord(item) || hasExtra(item, ['kind', 'handle', 'path']) || typeof item.kind !== 'string') throw new AntigravityImageError('reference is invalid', 'INVALID_ARGS')
    if (item.kind === 'session' && typeof item.handle === 'string' && IMAGE_HANDLE_PATTERN.test(item.handle)) return { kind: 'session', handle: item.handle }
    if (item.kind === 'workspace' && typeof item.path === 'string' && item.path.length > 0) return { kind: 'workspace', path: item.path }
    throw new AntigravityImageError('reference is invalid', 'INVALID_ARGS')
  })
}

function parseListArgs(value: unknown): { limit: number; cursor?: string; origin: ImageOrigin } {
  if (!isRecord(value) || hasExtra(value, ['limit', 'cursor', 'origin'])) throw new AntigravityImageError('list_images expects a closed object', 'INVALID_ARGS')
  const limit = value.limit === undefined ? 5 : integer(value.limit, 1, 20)
  const cursor = value.cursor === undefined ? undefined : nonBlank(value.cursor)
  const origin = value.origin === undefined ? 'all' : enumValue(value.origin, IMAGE_ORIGINS)
  return { limit, ...(cursor === undefined ? {} : { cursor }), origin }
}

function afterCursor(items: ImageItem[], cursor: string, origin: ImageOrigin): ImageItem[] {
  let value: unknown
  try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown } catch { throw new AntigravityImageError('The image cursor is invalid', 'IMAGE_CURSOR_INVALID') }
  if (!isRecord(value) || Object.keys(value).length !== 3 || hasExtra(value, ['id', 'seq', 'origin']) || typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 256 || !Number.isSafeInteger(value.seq) || value.origin !== origin) throw new AntigravityImageError('The image cursor is invalid', 'IMAGE_CURSOR_INVALID')
  const index = items.findIndex(item => item.seq === value.seq && String(item.attachment.attachmentId) === value.id)
  if (index < 0) throw new AntigravityImageError('The image cursor is stale', 'IMAGE_CURSOR_INVALID')
  return items.slice(index + 1)
}

function encodeCursor(item: ImageItem, origin: ImageOrigin): string {
  return Buffer.from(JSON.stringify({ id: String(item.attachment.attachmentId), seq: item.seq, origin })).toString('base64url')
}

function isAuthService(value: unknown): value is AntigravityAuthService {
  return isRecord(value) && typeof value.credential === 'function' && typeof value.status === 'function'
}

function imageRequestWarning(code: string): string {
  if (code === 'IMAGE_AUTH_REQUIRED') return 'IMAGE_REQUEST_UNAUTHENTICATED'
  if (code === 'IMAGE_RATE_LIMITED') return 'IMAGE_REQUEST_RATE_LIMITED'
  if (code === 'IMAGE_TIMEOUT') return 'IMAGE_REQUEST_TIMEOUT'
  if (code === 'IMAGE_PROTOCOL_DRIFT') return 'IMAGE_REQUEST_PROTOCOL_DRIFT'
  return 'IMAGE_REQUEST_FAILED'
}

const IMAGE_FAILURE_CODES: Readonly<Record<PrivateFailureKind, string>> = {
  authentication: 'IMAGE_AUTH_REQUIRED',
  forbidden: 'IMAGE_FORBIDDEN',
  'rate-limited': 'IMAGE_RATE_LIMITED',
  cancelled: 'IMAGE_CANCELLED',
  timeout: 'IMAGE_TIMEOUT',
  'attribution-rejected': 'IMAGE_PROTOCOL_DRIFT',
  'protocol-drift': 'IMAGE_PROTOCOL_DRIFT',
  'response-limit': 'IMAGE_PROTOCOL_DRIFT',
  'request-limit': 'IMAGE_PROTOCOL_DRIFT',
  upstream: 'IMAGE_FAILED',
  network: 'IMAGE_FAILED',
  failed: 'IMAGE_FAILED',
}

function toImageError(error: unknown): AntigravityImageError {
  if (error instanceof AntigravityImageError) return error
  if (error instanceof PrivateTransportError) {
    return new AntigravityImageError('The Antigravity Image request failed safely', IMAGE_FAILURE_CODES[classifyPrivateFailure(error)])
  }
  return new AntigravityImageError('The Antigravity Image request failed safely', 'IMAGE_FAILED')
}

function hasExtra(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).some(key => !allowed.includes(key))
}

function nonBlank(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) throw new AntigravityImageError('The image option is invalid', 'INVALID_ARGS')
  return value.trim()
}

function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new AntigravityImageError('The image option is invalid', 'INVALID_ARGS')
  return value as number
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new AntigravityImageError('The image option is invalid', 'INVALID_ARGS')
  return value as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
