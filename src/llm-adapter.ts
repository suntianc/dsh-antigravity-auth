/** Public DSH LLM adapter for the single Antigravity provider route. */

import { Buffer } from 'node:buffer'
import {
  AgyRequestSessionStore,
  CLAUDE_DESCRIPTION_PROMPT,
  CLAUDE_TOOL_SYSTEM_INSTRUCTION,
  SKIP_THOUGHT_SIGNATURE,
  applyClaudeTransforms,
  applyGeminiTransforms,
  buildAgyAgentRequestMetadata,
  fnv1a64Signed,
  getPublicModelDefinitions,
  getResolverAliasMap,
  orderAgyRequestPayloadInPlace,
  resolveModelWithTier,
} from '@cortexkit/antigravity-auth-core'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  ToolCallId,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  RequestMessage,
  ReplayEnvelope,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { CredentialCoordinator, HostCredential } from './credential-coordinator.ts'
import {
  DEFAULT_PRIVATE_FRAME_BYTES,
  DEFAULT_PRIVATE_IDLE_TIMEOUT_MS,
  DEFAULT_PRIVATE_RESPONSE_BYTES,
  DEFAULT_PRIVATE_RESPONSE_HEADER_TIMEOUT_MS,
  DEFAULT_PRIVATE_TOTAL_TIMEOUT_MS,
  PrivateTransportError,
  createPrivateTransport,
  iteratePrivateSse,
  privateStatusError,
  readPrivateText,
  type PrivateTransport,
} from './private-transport.ts'
import {
  antigravityModelFamily,
  buildFunctionDeclarations,
  compatibleReplayState,
  createReplayState,
  type AntigravityReplayBlock,
} from './replay.ts'
import { ANTIGRAVITY_WIRE_ORIGIN } from './wire-identity.ts'
import { classifyPrivateFailure, type PrivateFailureKind } from './private-failure.ts'
import type { AntigravityModelCatalogState, AntigravityModelCatalogView } from './model-catalog.ts'

export const ANTIGRAVITY_PROVIDER = 'google-antigravity' as const
export const ANTIGRAVITY_STREAM_ENDPOINT = `${ANTIGRAVITY_WIRE_ORIGIN}/v1internal:streamGenerateContent?alt=sse` as const
export const ANTIGRAVITY_GENERATE_ENDPOINT = `${ANTIGRAVITY_WIRE_ORIGIN}/v1internal:generateContent` as const
export const ANTIGRAVITY_AVAILABLE_MODELS_ENDPOINT = `${ANTIGRAVITY_WIRE_ORIGIN}/v1internal:fetchAvailableModels` as const
export const ANTIGRAVITY_LLM_ROUTE = ANTIGRAVITY_PROVIDER
const MODEL_CATALOG_TTL_MS = 30_000
const MAX_MODEL_CATALOG_BYTES = 256 * 1024
const MAX_PROVIDER_ERROR_BYTES = 64 * 1024
const MAX_PROVIDER_ERROR_FRAME_BYTES = 16 * 1024
const MAX_PROVIDER_ERROR_JSON_DEPTH = 8
const MAX_PROVIDER_PARTS = 4096
// A capacity-exhausted 503 clears on its own; two short waits absorb the blip
// without holding a turn open long enough to look hung.
const MAX_CAPACITY_RETRIES = 2
const CAPACITY_RETRY_BASE_DELAY_MS = 1500
const CAPACITY_RETRY_MAX_DELAY_MS = 8000

export interface AntigravityAuthCredentialSource {
  credential(signal?: AbortSignal, options?: { readonly forceRefresh?: boolean }): Promise<HostCredential | undefined>
}

export interface AntigravityAdapterOptions {
  readonly auth: Pick<CredentialCoordinator, 'credential'> | AntigravityAuthCredentialSource
  /** Whole-transport injection is the only private-request test seam. */
  readonly transport?: PrivateTransport
  readonly responseHeaderTimeoutMs?: number
  readonly idleTimeoutMs?: number
  readonly totalTimeoutMs?: number
  readonly maxResponseBytes?: number
  readonly maxFrameBytes?: number
  readonly attachments?: Pick<AttachmentStore, 'readImage'>
}

interface ProviderPartText {
  readonly kind: 'text' | 'reasoning'
  readonly text: string
  readonly signature?: string
}

interface ProviderPartTool {
  readonly kind: 'tool-call'
  readonly name?: string
  readonly id?: string
  readonly arguments: string
  readonly signature?: string
}

type ProviderPart = ProviderPartText | ProviderPartTool

interface ProviderEvent {
  readonly parts: readonly ProviderPart[]
  readonly usage?: TokenUsage
  readonly finish?: string
  readonly error?: { readonly status?: number; readonly code?: string; readonly contextWindowExceeded?: boolean }
}

export interface AntigravityRequestMetadata {
  readonly requestId: string
  readonly sessionId: string
  readonly labels: Record<string, string>
  readonly lastStepIndex: number
}

/** Adapter that owns exactly one provider route and no fallback route. */
export class AntigravityAdapter extends LlmAdapter {
  private readonly transport: PrivateTransport
  private readonly sessions = new AgyRequestSessionStore('dsh-antigravity-auth')
  private readonly options: Required<Pick<AntigravityAdapterOptions, 'idleTimeoutMs' | 'totalTimeoutMs' | 'maxResponseBytes' | 'maxFrameBytes'>> & {
    readonly responseHeaderTimeoutMs: number
  }
  private readonly definitions = getPublicModelDefinitions()
  private catalogProjectId: string | undefined
  private catalogExpiresAt = 0
  private catalogModelIds = new Set<string>()
  private catalogFailureCode: string | undefined
  private catalogView: AntigravityModelCatalogView

  constructor(private readonly adapterOptions: AntigravityAdapterOptions) {
    super()
    this.transport = adapterOptions.transport ?? createPrivateTransport(
      adapterOptions.responseHeaderTimeoutMs === undefined ? {} : { responseHeaderTimeoutMs: adapterOptions.responseHeaderTimeoutMs },
    )
    this.options = {
      responseHeaderTimeoutMs: boundedTimeout(adapterOptions.responseHeaderTimeoutMs, DEFAULT_PRIVATE_RESPONSE_HEADER_TIMEOUT_MS),
      idleTimeoutMs: boundedTimeout(adapterOptions.idleTimeoutMs, DEFAULT_PRIVATE_IDLE_TIMEOUT_MS),
      totalTimeoutMs: boundedTimeout(adapterOptions.totalTimeoutMs, DEFAULT_PRIVATE_TOTAL_TIMEOUT_MS),
      maxResponseBytes: boundedLimit(adapterOptions.maxResponseBytes, DEFAULT_PRIVATE_RESPONSE_BYTES),
      maxFrameBytes: boundedLimit(adapterOptions.maxFrameBytes, DEFAULT_PRIVATE_FRAME_BYTES),
    }
    this.catalogView = createCatalogView(this.definitions, 'snapshot')
  }

  override providerInfo(provider: string): LlmProviderInfo {
    if (provider !== ANTIGRAVITY_PROVIDER && provider !== 'google') throw new LlmError('Unknown Antigravity provider route', 'NO_ADAPTER')
    return { id: provider, name: provider === 'google' ? 'Google' : 'Google Antigravity' }
  }

  override providerRetryPolicy(provider: string = ANTIGRAVITY_PROVIDER): ReturnType<typeof resolveRetryPolicy> {
    // Generation dispatch is never retried by this adapter; a normal runtime
    // retry policy must not dispatch the same metered request a second time.
    return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, provider)
  }

  /** Forget account-bound availability when Gate 0 or the credential is replaced. */
  invalidateModelCatalog(): void {
    this.catalogProjectId = undefined
    this.catalogExpiresAt = 0
    this.catalogModelIds = new Set<string>()
    this.catalogFailureCode = undefined
    this.catalogView = createCatalogView(this.definitions, 'snapshot')
  }

  /** Return the pinned catalog without performing credential or network work. */
  catalogSnapshot(): AntigravityModelCatalogView {
    return cloneCatalogView(createCatalogView(this.definitions, 'snapshot'))
  }

  /** Refresh the advisory catalog and collapse failures into browser-safe state. */
  async modelCatalog(signal?: AbortSignal, forceRefresh = false): Promise<AntigravityModelCatalogView> {
    try {
      const available = await this.readLiveModelIds(signal, forceRefresh)
      this.catalogView = createCatalogView(this.definitions, 'live-available', available, new Date().toISOString())
    } catch (error) {
      const state = error instanceof LlmError && error.code === 'PROTOCOL_DRIFT' ? 'protocol-drift' : 'refresh-failed'
      this.catalogView = createCatalogView(this.definitions, state, undefined, new Date().toISOString())
    }
    return cloneCatalogView(this.catalogView)
  }

  override async listModels(provider: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    this.providerInfo(provider)
    const snapshot = this.pinnedTextModelInfos(provider)
    let available: ReadonlySet<string>
    try {
      available = await this.readLiveModelIds(signal)
      this.catalogView = createCatalogView(this.definitions, 'live-available', available, new Date().toISOString())
    } catch (error) {
      const state = error instanceof LlmError && error.code === 'PROTOCOL_DRIFT' ? 'protocol-drift' : 'refresh-failed'
      this.catalogView = createCatalogView(this.definitions, state, undefined, new Date().toISOString())
      if (!canFallBackToPinnedTextSnapshot(error)) throw error
      // DSH drops the whole provider group when a transient discovery failure escapes.
      // The local snapshot remains advisory; Settings still reports the live failure state.
      return snapshot
    }
    return snapshot.filter(model => available.has(model.id))
  }

  private pinnedTextModelInfos(provider: string = ANTIGRAVITY_PROVIDER): readonly LlmModelInfo[] {
    return Object.values(this.definitions)
      .filter(definition => !definition.modalities.output.includes('image'))
      .map(definition => ({
        provider,
        id: definition.id,
        name: cleanModelDisplayName(definition.name),
        inputModalities: definition.modalities.input.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image'),
      }))
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    this.providerInfo(provider)
    if (typeof model !== 'string' || model.trim().length === 0 || model.length > 256) {
      throw new LlmError('The Antigravity model id is invalid', 'INVALID_MODEL')
    }
    const definition = this.definitions[model]
    if (definition === undefined || definition.modalities.output.includes('image')) {
      throw new LlmError('The Antigravity model is not in the audited text model snapshot', 'INVALID_MODEL')
    }
    const reasoning = getModelReasoningEfforts(model)
    return {
      provider,
      id: definition.id,
      name: cleanModelDisplayName(definition.name),
      inputModalities: definition.modalities.input.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image'),
      context: { contextWindow: definition.limit.context },
      defaultMaxTokens: definition.limit.output,
      ...(reasoning === undefined ? {} : { reasoning }),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== ANTIGRAVITY_PROVIDER && options.provider !== 'google') {
      throw new LlmError('The Antigravity adapter received an unknown provider route', 'NO_ADAPTER')
    }
    const signal = options.signal
    const requestedDefinition = this.definitions[options.model]
    if (requestedDefinition === undefined || requestedDefinition.modalities.output.includes('image')) throw new LlmError('The Antigravity model is not in the audited text model snapshot', 'INVALID_MODEL')
    if (isAborted(signal)) {
      yield finishChunk('aborted', 'CANCELLED')
      return
    }
    const hasEmitted = { value: false }
    let replayed = false
    let capacityAttempt = 0
    for (;;) {
      const credential = await this.readCredential(signal, replayed)
      if (credential === undefined) {
        throw new LlmError('Antigravity login is required before model use', 'AUTH')
      }
      const sessionKey = requestSessionKey(options)
      const requestScope = this.sessions.beginRequest(sessionKey)
      let payload: Record<string, unknown>
      try {
        payload = await buildAntigravityGeneratePayloadForAdapter(options, credential, requestScope.session, requestScope.timestamp, this.adapterOptions.attachments)
      } catch (error) {
        if (error instanceof LlmError) throw error
        throw new LlmError('The Antigravity image input could not be admitted safely', 'UNSUPPORTED_MODALITY')
      }
      let response: Response
      try {
        response = await this.transport.request({
          url: ANTIGRAVITY_STREAM_ENDPOINT,
          accessToken: credential.accessToken,
          body: JSON.stringify(payload),
          ...(signal === undefined ? {} : { signal }),
          responseHeaderTimeoutMs: this.options.responseHeaderTimeoutMs,
        })
      } catch (error) {
        throw toLlmError(error)
      }
      const statusError = privateStatusError(response.status)
      if (statusError !== undefined) {
        if (statusError.code === 'authentication' && !replayed && !hasEmitted.value && !isAborted(signal)) {
          await cancelResponse(response)
          replayed = true
          continue
        }
        if (response.status === 400 && await responseReportsContextWindowExceeded(response, {
          ...(signal === undefined ? {} : { signal }),
          idleTimeoutMs: this.options.idleTimeoutMs,
          totalTimeoutMs: this.options.totalTimeoutMs,
          maxResponseBytes: this.options.maxResponseBytes,
          maxFrameBytes: this.options.maxFrameBytes,
        })) {
          throw contextWindowExceededError(response.status)
        }
        // A "no capacity available" 503 is a capacity blip on one model tier,
        // not a bad request: wait out the cooldown instead of failing the turn.
        // The status must be pinned to 503 first: a 429 that happens to carry the
        // same capacity marker is still a rate-limit verdict, and the existing
        // contract is that 429 is reported to the caller without a resend.
        if (response.status === 503
          && capacityAttempt < MAX_CAPACITY_RETRIES
          && !hasEmitted.value
          && !isAborted(signal)
          && await responseReportsModelCapacityExhausted(response, this.options)) {
          capacityAttempt += 1
          await cancelResponse(response)
          await sleep(backoffDelayMs(capacityAttempt), signal)
          if (isAborted(signal)) {
            yield finishChunk('aborted', 'CANCELLED')
            return
          }
          continue
        }
        await cancelResponse(response)
        throw toLlmError(statusError)
      }
      try {
        yield* this.streamResponse(response, options, hasEmitted)
        this.sessions.completeExecution(sessionKey)
        return
      } catch (error) {
        const privateError = error instanceof PrivateTransportError ? error : undefined
        if (privateError?.code === 'authentication' && !replayed && !hasEmitted.value && !isAborted(signal)) {
          replayed = true
          continue
        }
        throw toLlmError(error)
      }
    }
  }

  private async *streamResponse(
    response: Response,
    options: GenerateOptions,
    hasEmitted: { value: boolean },
  ): AsyncGenerator<StreamChunk> {
    const states: BlockState[] = []
    let current: BlockState | undefined
    let usage: TokenUsage | undefined
    let finish: string | undefined
    let eventError: ProviderEvent['error']
    let pendingSignature: string | undefined
    for await (const sse of iteratePrivateSse(response, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      idleTimeoutMs: this.options.idleTimeoutMs,
      totalTimeoutMs: this.options.totalTimeoutMs,
      maxBytes: this.options.maxResponseBytes,
      maxFrameBytes: this.options.maxFrameBytes,
    })) {
      if (sse.data.trim() === '[DONE]') continue
      const event = parseProviderEvent(sse.data)
      if (event.error !== undefined) {
        eventError = event.error
        if (event.error.status === 401 || isAuthenticationCode(event.error.code)) throw new PrivateTransportError('authentication', 'The private endpoint requires authentication', { status: event.error.status ?? 401 })
        break
      }
      if (event.usage !== undefined) usage = event.usage
      if (event.finish !== undefined) finish = event.finish
      for (const part of event.parts) {
        // A part with no observable content must never announce a block. An
        // emitted `block-start` that is never closed both violates the stream
        // grammar and desynchronizes the replay envelope from the emitted
        // blocks, which makes DSH drop the whole turn's replay metadata. The
        // part's provider-issued signature is still validation-bearing, so it
        // is carried onto the next block that does open.
        if (part.kind !== 'tool-call' && part.text.length === 0) {
          if (part.signature !== undefined) pendingSignature = part.signature
          continue
        }
        if (current === undefined || !sameBlock(current, part)) {
          if (current !== undefined) {
            yield endBlock(current)
          }
          current = beginBlock(states, part)
          if (current.signature === undefined && pendingSignature !== undefined) current.signature = pendingSignature
          pendingSignature = undefined
          yield { type: 'block-start', index: current.index, blockType: current.kind }
        }
        if (part.kind === 'tool-call') {
          if (part.name !== undefined) current.name = assembleFunctionName(current.name, part.name)
          current.text += part.arguments
          hasEmitted.value ||= part.arguments.length > 0 || part.name !== undefined
          yield {
            type: 'tool-call-delta',
            index: current.index,
            id: current.id,
            ...(part.name === undefined ? {} : { name: part.name }),
            argumentsDelta: part.arguments,
          }
          if (part.signature !== undefined) current.signature = part.signature
        } else if (part.kind === 'reasoning') {
          current.text += part.text
          hasEmitted.value ||= part.text.length > 0
          if (part.signature !== undefined) current.signature = part.signature
          if (part.text.length > 0) yield { type: 'reasoning-delta', index: current.index, text: part.text }
        } else {
          current.text += part.text
          hasEmitted.value ||= part.text.length > 0
          if (part.text.length > 0) yield { type: 'text-delta', index: current.index, text: part.text }
        }
      }
    }
    // Every block that announced itself above is closed here, so the emitted
    // stream and the replay envelope below always describe the same block list.
    if (current !== undefined) yield endBlock(current)
    if (usage !== undefined) yield { type: 'usage', usage }
    if (eventError !== undefined) {
      yield finishChunk(
        'error',
        eventError.contextWindowExceeded === true ? CONTEXT_WINDOW_EXCEEDED_CODE : safeProviderErrorCode(eventError.code),
        safeProviderStatus(eventError.status),
      )
      return
    }
    if (isAborted(options.signal)) {
      yield finishChunk('aborted', 'CANCELLED')
      return
    }
    if (states.length === 0) {
      yield finishChunk('error', 'EMPTY_RESPONSE')
      return
    }
    // The provider can deliver the signature that validates a replayed tool call
    // in a trailing content-free frame, i.e. after the call itself. Seed the
    // backfill with that pending signature so it is never dropped on the floor.
    let lastReasoningSignature: string | undefined = pendingSignature
    for (const state of states) {
      if (state.kind === 'reasoning' && state.signature !== undefined) {
        lastReasoningSignature = state.signature
      } else if (state.kind === 'tool-call') {
        if (state.signature === undefined && lastReasoningSignature !== undefined) {
          state.signature = lastReasoningSignature
        }
      }
    }
    const replayBlocks: AntigravityReplayBlock[] = states.map(state => ({
      kind: state.kind,
      ...(state.signature === undefined ? {} : { signature: state.signature }),
    }))
    const replayState = createReplayState(options.model, antigravityModelFamily(options.model), finish, replayBlocks, options.provider)
    yield finishChunk(mapFinishReason(finish), finish ?? 'STOP', undefined, replayState)
  }

  private async readLiveModelIds(
    signal: AbortSignal | undefined,
    bypassCache = false,
    forceCredentialRefresh = false,
  ): Promise<ReadonlySet<string>> {
    const credential = await this.readCredential(signal, forceCredentialRefresh)
    if (credential === undefined) throw new LlmError('Antigravity login is required before model discovery', 'AUTH')
    if (!bypassCache && this.catalogProjectId === credential.projectId && Date.now() < this.catalogExpiresAt) {
      if (this.catalogFailureCode !== undefined) throw new LlmError('The Antigravity live model catalog refresh remains unavailable', this.catalogFailureCode)
      return this.catalogModelIds
    }
    let response: Response
    const body = credential.projectId ? { project: credential.projectId } : {}
    try {
      response = await this.transport.request({
        url: ANTIGRAVITY_AVAILABLE_MODELS_ENDPOINT,
        accessToken: credential.accessToken,
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
        responseHeaderTimeoutMs: this.options.responseHeaderTimeoutMs,
      })
    } catch (error) {
      const failure = toModelCatalogError(error, signal, 'provider')
      this.rememberCatalogFailure(credential.projectId, failure)
      throw failure
    }
    if (response.status === 403 && credential.projectId) {
      try {
        const retryResponse = await this.transport.request({
          url: ANTIGRAVITY_AVAILABLE_MODELS_ENDPOINT,
          accessToken: credential.accessToken,
          body: JSON.stringify({}),
          ...(signal === undefined ? {} : { signal }),
          responseHeaderTimeoutMs: this.options.responseHeaderTimeoutMs,
        })
        if (retryResponse.ok) {
          await cancelResponse(response)
          response = retryResponse
        } else {
          await cancelResponse(retryResponse)
        }
      } catch (error) {
        const failure = toModelCatalogError(error, signal, 'provider')
        if (failure.code === 'CANCELLED' || failure.code === 'GATE_0_ATTRIBUTION') {
          await cancelResponse(response)
          this.rememberCatalogFailure(credential.projectId, failure)
          throw failure
        }
        // Keep the original project-scoped 403 as the authoritative failure.
      }
    }
    const statusError = privateStatusError(response.status)
    if (statusError !== undefined) {
      await cancelResponse(response)
      if (statusError.code === 'authentication' && !forceCredentialRefresh && !isAborted(signal)) {
        this.catalogExpiresAt = 0
        return this.readLiveModelIds(signal, true, true)
      }
      const failure = toLlmError(statusError)
      this.rememberCatalogFailure(credential.projectId, failure)
      throw failure
    }
    let value: unknown
    try {
      value = JSON.parse(await readPrivateText(response, {
        ...(signal === undefined ? {} : { signal }),
        idleTimeoutMs: this.options.idleTimeoutMs,
        totalTimeoutMs: this.options.totalTimeoutMs,
        maxBytes: Math.min(this.options.maxResponseBytes, MAX_MODEL_CATALOG_BYTES),
      })) as unknown
    } catch (error) {
      const failure = toModelCatalogError(error, signal, 'protocol')
      this.rememberCatalogFailure(credential.projectId, failure)
      throw failure
    }
    let ids: Set<string>
    try { ids = parseLiveModelIds(value, this.definitions) } catch (error) {
      const failure = error instanceof LlmError
        ? error
        : new LlmError('The Antigravity live model catalog did not match the audited schema', 'PROTOCOL_DRIFT')
      this.rememberCatalogFailure(credential.projectId, failure)
      throw failure
    }
    this.catalogProjectId = credential.projectId
    this.catalogModelIds = ids
    this.catalogFailureCode = undefined
    this.catalogExpiresAt = Date.now() + MODEL_CATALOG_TTL_MS
    return ids
  }

  private rememberCatalogFailure(projectId: string, failure: LlmError): void {
    if (failure.code === 'AUTH' || failure.code === 'CANCELLED') return
    this.catalogProjectId = projectId
    this.catalogModelIds = new Set<string>()
    this.catalogFailureCode = failure.code
    this.catalogExpiresAt = Date.now() + MODEL_CATALOG_TTL_MS
  }

  private async readCredential(signal: AbortSignal | undefined, forceRefresh: boolean): Promise<HostCredential | undefined> {
    try {
      return await this.adapterOptions.auth.credential(signal, forceRefresh ? { forceRefresh: true } : undefined)
    } catch (error) {
      throw toLlmError(error)
    }
  }
}

function cleanModelDisplayName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/u, '').trim()
}

function getModelReasoningEfforts(modelId: string): { efforts: readonly { id: ReturnType<typeof ReasoningEffortId>; name: string }[]; defaultEffort: ReturnType<typeof ReasoningEffortId> } | undefined {
  const lower = modelId.toLowerCase()
  if (lower.includes('flash') && !lower.includes('image')) {
    return {
      efforts: [
        { id: ReasoningEffortId('low'), name: 'Low' },
        { id: ReasoningEffortId('medium'), name: 'Medium' },
        { id: ReasoningEffortId('high'), name: 'High' },
      ],
      defaultEffort: ReasoningEffortId(lower.includes('gemini-3.8-flash') ? 'medium' : 'high'),
    }
  }
  if (lower.includes('pro')) {
    return {
      efforts: [
        { id: ReasoningEffortId('low'), name: 'Low' },
        { id: ReasoningEffortId('high'), name: 'High' },
      ],
      defaultEffort: ReasoningEffortId('high'),
    }
  }
  return undefined
}

function createCatalogView(
  definitions: ReturnType<typeof getPublicModelDefinitions>,
  state: AntigravityModelCatalogState,
  available?: ReadonlySet<string>,
  checkedAt?: string,
): AntigravityModelCatalogView {
  const models = Object.values(definitions)
    .filter(definition => !definition.modalities.output.includes('image'))
    .map(definition => ({
      id: definition.id,
      name: cleanModelDisplayName(definition.name),
      state: state === 'live-available'
        ? available?.has(definition.id) === true ? 'live-available' as const : 'unavailable' as const
        : 'snapshot' as const,
    }))
  return { state, models, ...(checkedAt === undefined ? {} : { checkedAt }) }
}

function cloneCatalogView(value: AntigravityModelCatalogView): AntigravityModelCatalogView {
  return {
    state: value.state,
    models: value.models.map(model => ({ ...model })),
    ...(value.checkedAt === undefined ? {} : { checkedAt: value.checkedAt }),
  }
}

function parseLiveModelIds(
  value: unknown,
  definitions: ReturnType<typeof getPublicModelDefinitions>,
): Set<string> {
  const root = isRecord(value) && isRecord(value.response) ? value.response : value
  if (!isRecord(root) || !isRecord(root.models)) throw new LlmError('The Antigravity live model catalog did not match the audited schema', 'PROTOCOL_DRIFT')
  const entries = Object.entries(root.models)
  if (entries.length > 512) throw new LlmError('The Antigravity live model catalog exceeded the model limit', 'PROTOCOL_DRIFT')
  const aliases = getResolverAliasMap()
  const live = new Set<string>()
  for (const [id, rawEntry] of entries) {
    if (!safeModelId(id) || !isRecord(rawEntry)) throw new LlmError('The Antigravity live model catalog did not match the audited schema', 'PROTOCOL_DRIFT')
    const cleanId = cleanModelId(id)
    live.add(canonicalWireModel(cleanId, aliases))
    live.add(cleanId)
    live.add(id)
    if (cleanId === 'gemini-3-flash' || cleanId === 'gemini-3-flash-agent' || cleanId === 'gemini-3.7-flash-tiered' || cleanId.startsWith('gemini-3-flash') || cleanId.startsWith('gemini-3.7-flash')) {
      live.add('gemini-3.7-flash')
      live.add('gemini-3.7-flash-medium')
      live.add('gemini-3.7-flash-low')
      live.add('gemini-3.7-flash-high')
    }
    if (cleanId === 'gemini-3.8-flash-tiered' || cleanId.startsWith('gemini-3.8-flash')) {
      live.add('gemini-3.8-flash')
      live.add('gemini-3.8-flash-medium')
      live.add('gemini-3.8-flash-low')
      live.add('gemini-3.8-flash-high')
    }
    if (rawEntry.modelName !== undefined && typeof rawEntry.modelName === 'string') {
      if (!safeModelId(rawEntry.modelName)) throw new LlmError('The Antigravity live model catalog did not match the audited schema', 'PROTOCOL_DRIFT')
      const cleanName = cleanModelId(rawEntry.modelName)
      live.add(canonicalWireModel(cleanName, aliases))
      live.add(cleanName)
    }
    if (rawEntry.displayName !== undefined && (typeof rawEntry.displayName !== 'string' || rawEntry.displayName.length > 512 || containsControl(rawEntry.displayName))) {
      throw new LlmError('The Antigravity live model catalog did not match the audited schema', 'PROTOCOL_DRIFT')
    }
  }
  const available = new Set<string>()
  for (const definition of Object.values(definitions)) {
    const resolved = resolveModelWithTier(definition.id).actualModel
    const cleanResolved = cleanModelId(resolved)
    const canonical = canonicalWireModel(cleanResolved, aliases)
    if (
      live.has(canonical)
      || live.has(cleanResolved)
      || live.has(resolved)
      || live.has(definition.id)
      || (definition.id === 'antigravity-gemini-3.7-flash' && (
        live.has('gemini-3-flash')
        || live.has('gemini-3-flash-agent')
        || live.has('gemini-3.7-flash-tiered')
        || live.has('gemini-3.7-flash')
        || live.has('gemini-3.7-flash-medium')
      ))
    ) {
      available.add(definition.id)
    }
  }
  return available
}

function cleanModelId(value: string): string {
  return value.replace(/^(?:publishers\/[^/]+\/)?models\//, '')
}

function canonicalWireModel(value: string, aliases: Readonly<Record<string, string>>): string {
  return aliases[value] ?? value
}

function safeModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !containsControl(value)
}

function containsControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

interface BlockState {
  readonly index: number
  readonly kind: 'text' | 'reasoning' | 'tool-call'
  readonly id: ReturnType<typeof ToolCallId>
  name?: string
  text: string
  signature?: string
}

function beginBlock(states: BlockState[], part: ProviderPart): BlockState {
  const index = states.length
  const block: BlockState = part.kind === 'tool-call'
    ? {
        index,
        kind: 'tool-call',
        id: ToolCallId(part.id ?? `antigravity-call-${String(index)}`),
        ...(part.name === undefined ? {} : { name: part.name }),
        text: '',
        ...(part.signature === undefined ? {} : { signature: part.signature }),
      }
    : {
        index,
        kind: part.kind,
        id: ToolCallId(`antigravity-block-${String(index)}`),
        text: '',
        ...(part.signature === undefined ? {} : { signature: part.signature }),
      }
  states.push(block)
  return block
}

function sameBlock(state: BlockState, part: ProviderPart): boolean {
  if (state.kind !== part.kind) return false
  return part.kind !== 'tool-call' || (part.id === undefined || part.id === String(state.id))
}

function assembleFunctionName(current: string | undefined, fragment: string): string {
  if (fragment.length === 0 || fragment.length > 256 || containsControl(fragment)) {
    throw new PrivateTransportError('protocol-drift', 'The private tool-call name was invalid')
  }
  if (current === undefined || current.length === 0) return fragment
  if (fragment === current) return current
  if (fragment.startsWith(current)) return fragment
  const combined = `${current}${fragment}`
  if (combined.length > 256) throw new PrivateTransportError('protocol-drift', 'The private tool-call name exceeded the byte limit')
  return combined
}

function endBlock(state: BlockState): StreamChunk {
  if (state.kind === 'text') return { type: 'block-end', index: state.index, block: { type: 'text', text: state.text } }
  if (state.kind === 'reasoning') return { type: 'block-end', index: state.index, block: { type: 'reasoning', text: state.text.trimEnd() } }
  let parsed: unknown
  try {
    parsed = JSON.parse(state.text) as unknown
  } catch {
    throw new PrivateTransportError('protocol-drift', 'The private tool-call arguments were incomplete JSON')
  }
  if (!isRecord(parsed)) throw new PrivateTransportError('protocol-drift', 'The private tool-call arguments were not an object')
  const args = state.text
  if (state.name === undefined || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/u.test(state.name)) {
    throw new PrivateTransportError('protocol-drift', 'The private tool-call name was missing or invalid')
  }
  return {
    type: 'block-end',
    index: state.index,
    block: {
      type: 'tool-call',
      id: state.id,
      name: state.name,
      arguments: args,
    },
  }
}

export function buildAntigravityGeneratePayload(options: GenerateOptions, credential: HostCredential): Record<string, unknown> {
  const toolNames = new Map<string, string>()
  const contents = options.messages
    .filter(message => message.role !== 'system')
    .map(message => mapMessage(message, options.model, toolNames, options.provider))
  return buildPayloadFromContents(options, credential, contents)
}

async function buildAntigravityGeneratePayloadForAdapter(
  options: GenerateOptions,
  credential: HostCredential,
  session: Parameters<typeof buildAgyAgentRequestMetadata>[0],
  timestamp: number,
  attachments: Pick<AttachmentStore, 'readImage'> | undefined,
): Promise<Record<string, unknown>> {
  const contents: Record<string, unknown>[] = []
  const toolNames = new Map<string, string>()
  for (const message of options.messages) {
    if (message.role === 'system') continue
    contents.push(await mapMessageWithAttachments(message, options.model, toolNames, attachments, options.signal, options.provider))
  }
  const payload = buildPayloadFromContents(options, credential, contents)
  const metadata = buildAgyAgentRequestMetadata(session, payload.request as Record<string, unknown>, resolveWireModel(options.model, options.reasoningEffort), timestamp)
  const request = payload.request as Record<string, unknown>
  request.labels = metadata.labels
  request.sessionId = metadata.sessionId
  orderAgyRequestPayloadInPlace(request)
  return {
    ...(payload.project === undefined ? {} : { project: payload.project }),
    requestId: metadata.requestId,
    request,
    model: payload.model,
    userAgent: 'antigravity',
    requestType: 'agent',
  }
}

function groupClaudeFunctionResponses(
  contents: readonly Record<string, unknown>[],
  model: string,
): readonly Record<string, unknown>[] {
  if (antigravityModelFamily(model) !== 'claude') return contents
  const grouped: Record<string, unknown>[] = []
  let pendingResponses: Record<string, unknown>[] = []
  const flushResponses = (): void => {
    if (pendingResponses.length === 0) return
    grouped.push({ role: 'user', parts: pendingResponses })
    pendingResponses = []
  }
  for (const content of contents) {
    const rawParts = Array.isArray(content.parts) ? content.parts : []
    const responseParts = rawParts.filter(part => isRecord(part) && isRecord(part.functionResponse)) as Record<string, unknown>[]
    const responseOnly = content.role === 'user' && rawParts.length > 0 && responseParts.length === rawParts.length
    if (responseOnly) {
      pendingResponses.push(...responseParts)
      continue
    }
    flushResponses()
    grouped.push(content)
  }
  flushResponses()
  return grouped
}

function buildPayloadFromContents(
  options: GenerateOptions,
  credential: HostCredential,
  contents: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const wireModel = resolveWireModel(options.model, options.reasoningEffort)
  const usesCapturedGemini38ThinkingBudget = /^gemini-3\.8-flash-(?:low|medium|high)$/u.test(wireModel)
  const requestContents = groupClaudeFunctionResponses(contents, options.model)
  const request: Record<string, unknown> = { contents: requestContents }
  // V3 AgentLoop stores instructions in system messages. One-shot callers may
  // still provide a separate preface; preserve both in their original order.
  const systemParts = [
    ...(options.system?.trim() ? [{ text: options.system }] : []),
    ...options.messages.flatMap(message => message.role === 'system'
      ? message.content.flatMap(block => block.type === 'text' && block.text.trim() ? [{ text: block.text }] : [])
      : []),
  ]
  if (systemParts.length > 0) request.systemInstruction = { parts: systemParts }
  const generationConfig: Record<string, unknown> = {}
  if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = boundedInteger(options.maxTokens, 1, 1_000_000, 'maxTokens')
  else if (usesCapturedGemini38ThinkingBudget) generationConfig.maxOutputTokens = 65536
  if (options.temperature !== undefined) generationConfig.temperature = boundedNumber(options.temperature, -100, 100, 'temperature')
  if (options.stop !== undefined) generationConfig.stopSequences = options.stop.slice(0, 16).map(item => item.slice(0, 256))
  if (options.reasoningEffort !== undefined) generationConfig.thinkingConfig = { thinkingLevel: String(options.reasoningEffort) }
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig
  if (options.tools !== undefined && options.tools.length > 0) {
    const declarations = buildFunctionDeclarations(options.tools)
    if (declarations.length > 0) request.tools = [{ functionDeclarations: declarations }]
  }
  const resolved = resolveModelWithTier(usesCapturedGemini38ThinkingBudget ? wireModel : options.model, { cli_first: false })
  const requestedEffort = normalizeReasoningEffort(options.reasoningEffort)
  const thinkingLevel = requestedEffort ?? resolved.thinkingLevel
  if (wireModel.toLowerCase().includes('claude')) {
    applyClaudeToolHardening(request)
    applyClaudeTransforms(request, {
      model: wireModel,
      ...(resolved.thinkingBudget === undefined ? {} : { tierThinkingBudget: resolved.thinkingBudget }),
      ...(options.reasoningEffort === undefined && resolved.thinkingBudget === undefined ? {} : { normalizedThinking: { includeThoughts: true, ...(resolved.thinkingBudget === undefined ? {} : { thinkingBudget: resolved.thinkingBudget }) } }),
      cleanJSONSchema: value => isRecord(value) ? value : { type: 'object', properties: {} },
    })
  } else {
    applyGeminiTransforms(request, {
      model: wireModel,
      ...(thinkingLevel === undefined || usesCapturedGemini38ThinkingBudget ? {} : { tierThinkingLevel: thinkingLevel as 'low' | 'medium' | 'high' }),
      ...(resolved.thinkingBudget === undefined ? {} : { tierThinkingBudget: resolved.thinkingBudget }),
      ...(options.reasoningEffort === undefined && resolved.thinkingBudget === undefined ? {} : { normalizedThinking: { includeThoughts: true, ...(resolved.thinkingBudget === undefined ? {} : { thinkingBudget: resolved.thinkingBudget }) } }),
    })
    if (usesCapturedGemini38ThinkingBudget) {
      const transformedConfig = request.generationConfig
      if (!isRecord(transformedConfig) || typeof resolved.thinkingBudget !== 'number') {
        throw new LlmError('The Gemini 3.8 captured thinking configuration could not be resolved', 'PROTOCOL_DRIFT')
      }
      transformedConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: resolved.thinkingBudget }
    }
  }
  const project = credential.projectId === 'inductive-dreamer-qrkws' || !credential.projectId ? undefined : credential.projectId
  return { ...(project === undefined ? {} : { project }), model: wireModel, request }
}

function applyClaudeToolHardening(request: Record<string, unknown>): void {
  if (!Array.isArray(request.tools) || request.tools.length === 0) return
  request.tools = request.tools.map(tool => {
    if (!isRecord(tool) || !Array.isArray(tool.functionDeclarations)) return tool
    return {
      ...tool,
      functionDeclarations: tool.functionDeclarations.map(declaration => hardenClaudeToolDeclaration(declaration)),
    }
  })
  const instructionPart = { text: CLAUDE_TOOL_SYSTEM_INSTRUCTION }
  const existing = request.systemInstruction
  if (isRecord(existing) && Array.isArray(existing.parts)) {
    if (existing.parts.some(part => isRecord(part) && typeof part.text === 'string' && part.text.includes('CRITICAL TOOL USAGE INSTRUCTIONS'))) return
    request.systemInstruction = { ...existing, parts: [...existing.parts, instructionPart] }
  } else if (typeof existing === 'string') {
    request.systemInstruction = { role: 'user', parts: [{ text: existing }, instructionPart] }
  } else {
    request.systemInstruction = { role: 'user', parts: [instructionPart] }
  }
}

function hardenClaudeToolDeclaration(value: unknown): unknown {
  if (!isRecord(value)) return value
  const description = typeof value.description === 'string' ? value.description : ''
  if (description.includes('STRICT PARAMETERS:')) return value
  const schema = isRecord(value.parameters) ? value.parameters : undefined
  const properties = schema !== undefined && isRecord(schema.properties) ? schema.properties : undefined
  if (properties === undefined || Object.keys(properties).length === 0) return value
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter(item => typeof item === 'string') : [])
  const parameters = Object.entries(properties).map(([name, property]) => {
    const requiredHint = required.has(name) ? ', REQUIRED' : ''
    return `${name} (${claudeToolTypeHint(property)}${requiredHint})`
  })
  return {
    ...value,
    description: description + CLAUDE_DESCRIPTION_PROMPT.replace('{params}', parameters.join(', ')),
  }
}

function claudeToolTypeHint(value: unknown): string {
  if (!isRecord(value)) return 'unknown'
  if (Array.isArray(value.enum)) {
    return value.enum.length <= 5
      ? `string ENUM[${value.enum.map(item => JSON.stringify(item)).join(', ')}]`
      : `string ENUM[${value.enum.length} options]`
  }
  const type = typeof value.type === 'string' ? value.type : 'unknown'
  if (type === 'array') {
    if (!isRecord(value.items)) return 'ARRAY'
    const itemType = typeof value.items.type === 'string' ? value.items.type : 'unknown'
    if (itemType !== 'object') return `ARRAY_OF_${itemType.toUpperCase()}`
    if (!isRecord(value.items.properties)) return 'ARRAY_OF_OBJECTS'
    const nestedRequired = new Set(Array.isArray(value.items.required) ? value.items.required.filter(item => typeof item === 'string') : [])
    const nested = Object.entries(value.items.properties).map(([name, property]) => {
      const nestedType = isRecord(property) && typeof property.type === 'string' ? property.type : 'unknown'
      return `${name}: ${nestedType}${nestedRequired.has(name) ? ' REQUIRED' : ''}`
    })
    return `ARRAY_OF_OBJECTS[${nested.join(', ')}]`
  }
  if (type === 'object' && isRecord(value.properties)) {
    const nestedRequired = new Set(Array.isArray(value.required) ? value.required.filter(item => typeof item === 'string') : [])
    const nested = Object.entries(value.properties).map(([name, property]) => {
      const nestedType = isRecord(property) && typeof property.type === 'string' ? property.type : 'unknown'
      return `${name}: ${nestedType}${nestedRequired.has(name) ? ' REQUIRED' : ''}`
    })
    return `object{${nested.join(', ')}}`
  }
  return type
}

function findMessageReasoningSignature(
  message: RequestMessage,
  replayBlocks: readonly AntigravityReplayBlock[],
): string | undefined {
  const fromReplay = replayBlocks.find(b => b.kind === 'reasoning' && b.signature !== undefined)?.signature
  if (fromReplay !== undefined) return fromReplay
  for (const block of message.content) {
    if (block.type === 'reasoning') {
      const sig = (block as unknown as { signature?: string; thoughtSignature?: string }).signature
        ?? (block as unknown as { signature?: string; thoughtSignature?: string }).thoughtSignature
      if (typeof sig === 'string' && sig.length > 0) return sig
    }
  }
  return undefined
}

function mapMessage(message: RequestMessage, model: string, toolNames: Map<string, string>, provider: string = ANTIGRAVITY_PROVIDER): Record<string, unknown> {
  if (message.role === 'tool') return mapToolResult(message, model, toolNames)
  const parts: Record<string, unknown>[] = []
  const replay = message.role === 'assistant' ? compatibleReplayState(message, provider, model, contentKinds(message)) : undefined
  const replayBlocks = replay?.blocks ?? []
  const messageReasoningSignature = findMessageReasoningSignature(message, replayBlocks)
  const isClaude = antigravityModelFamily(model) === 'claude'
  const isGemini = antigravityModelFamily(model) === 'gemini'
  let replayIndex = 0
  let sawClaudeFunctionCall = false
  for (const block of message.content) {
    const replayKind = block.type === 'text' || block.type === 'reasoning' || block.type === 'tool-call' ? block.type : undefined
    const replayBlock = replayKind === undefined ? undefined : replayBlocks[replayIndex++]
    const replaySignature = replayBlock !== undefined && replayBlock.kind === replayKind ? replayBlock.signature : undefined
    const blockSignature = (block as unknown as { signature?: string; thoughtSignature?: string }).signature
      ?? (block as unknown as { signature?: string; thoughtSignature?: string }).thoughtSignature
      ?? replaySignature
    if (block.type === 'text') {
      if (block.text.length === 0 && message.content.length > 1) continue
      parts.push({ text: block.text, ...(blockSignature === undefined ? {} : { thoughtSignature: blockSignature }) })
    } else if (block.type === 'reasoning') {
      if (isClaude && blockSignature === undefined) continue
      parts.push({ text: block.text, thought: true, ...(blockSignature === undefined ? {} : { thoughtSignature: blockSignature }) })
    } else if (block.type === 'tool-call') {
      const callId = rememberToolName(toolNames, block.id, block.name, isGemini)
      const signature = isClaude
        ? sawClaudeFunctionCall ? undefined : blockSignature ?? SKIP_THOUGHT_SIGNATURE
        : blockSignature ?? messageReasoningSignature ?? SKIP_THOUGHT_SIGNATURE
      sawClaudeFunctionCall ||= isClaude
      parts.push({
        functionCall: {
          ...(isClaude ? { id: callId } : {}),
          name: block.name,
          args: parseJsonObject(block.arguments),
        },
        ...(signature === undefined ? {} : { thoughtSignature: signature }),
      })
    } else if (block.type === 'image') {
      throw new LlmError('Antigravity text requests do not accept unresolved image blocks', 'UNSUPPORTED_MODALITY')
    }
  }
  return {
    role: message.role === 'assistant' ? 'model' : 'user',
    parts,
  }
}

async function mapMessageWithAttachments(
  message: RequestMessage,
  model: string,
  toolNames: Map<string, string>,
  attachments: Pick<AttachmentStore, 'readImage'> | undefined,
  signal: AbortSignal | undefined,
  provider: string = ANTIGRAVITY_PROVIDER,
): Promise<Record<string, unknown>> {
  if (message.role === 'tool' || !message.content.some(block => block.type === 'image')) return mapMessage(message, model, toolNames, provider)
  if (attachments === undefined) throw new LlmError('Antigravity image input requires the Host AttachmentStore', 'UNSUPPORTED_MODALITY')
  const replay = message.role === 'assistant' ? compatibleReplayState(message, provider, model, contentKinds(message)) : undefined
  const replayBlocks = replay?.blocks ?? []
  const messageReasoningSignature = findMessageReasoningSignature(message, replayBlocks)
  const parts: Record<string, unknown>[] = []
  const isClaude = antigravityModelFamily(model) === 'claude'
  const isGemini = antigravityModelFamily(model) === 'gemini'
  let replayIndex = 0
  let sawClaudeFunctionCall = false
  for (const block of message.content) {
    const replayKind = block.type === 'text' || block.type === 'reasoning' || block.type === 'tool-call' ? block.type : undefined
    const replayBlock = replayKind === undefined ? undefined : replayBlocks[replayIndex++]
    const replaySignature = replayBlock !== undefined && replayBlock.kind === replayKind ? replayBlock.signature : undefined
    const blockSignature = (block as unknown as { signature?: string; thoughtSignature?: string }).signature
      ?? (block as unknown as { signature?: string; thoughtSignature?: string }).thoughtSignature
      ?? replaySignature
    if (block.type === 'image') {
      const stored = await attachments.readImage(block.attachment, signal)
      parts.push({ inlineData: { mimeType: stored.ref.mediaType, data: Buffer.from(stored.data).toString('base64') } })
    } else if (block.type === 'text') {
      if (block.text.length === 0 && message.content.length > 1) continue
      parts.push({ text: block.text, ...(blockSignature === undefined ? {} : { thoughtSignature: blockSignature }) })
    } else if (block.type === 'reasoning') {
      if (isClaude && blockSignature === undefined) continue
      parts.push({ text: block.text, thought: true, ...(blockSignature === undefined ? {} : { thoughtSignature: blockSignature }) })
    } else if (block.type === 'tool-call') {
      const callId = rememberToolName(toolNames, block.id, block.name, isGemini)
      const signature = isClaude
        ? sawClaudeFunctionCall ? undefined : blockSignature ?? SKIP_THOUGHT_SIGNATURE
        : blockSignature ?? messageReasoningSignature ?? SKIP_THOUGHT_SIGNATURE
      sawClaudeFunctionCall ||= isClaude
      parts.push({
        functionCall: {
          ...(isClaude ? { id: callId } : {}),
          name: block.name,
          args: parseJsonObject(block.arguments),
        },
        ...(signature === undefined ? {} : { thoughtSignature: signature }),
      })
    }
  }
  return { role: message.role === 'assistant' ? 'model' : 'user', parts }
}

function mapToolResult(message: Extract<Message, { role: 'tool' }>, model: string, toolNames: Map<string, string>): Record<string, unknown> {
  const callId = requireToolCallId(message.toolCallId)
  const isClaude = antigravityModelFamily(model) === 'claude'
  const name = requireToolName(toolNames, callId, antigravityModelFamily(model) === 'gemini')
  return { role: 'user', parts: [{ functionResponse: {
    ...(isClaude ? { id: callId } : {}), name, response: { content: blocksToText(message.content) },
  } }] }
}

function rememberToolName(toolNames: Map<string, string>, callId: unknown, name: string, isGemini: boolean): string {
  if (name.length === 0 || name.length > 256 || containsControl(name)) throw new LlmError('The tool call name is invalid', 'INVALID_ARGS')
  const id = requireToolCallId(callId)
  const existing = toolNames.get(id)
  if (isGemini && existing !== undefined) throw new LlmError('A tool call id was reused before its prior result', 'INVALID_ARGS')
  if (existing !== undefined && existing !== name) throw new LlmError('A tool call id was reused with a different name', 'INVALID_ARGS')
  toolNames.set(id, name)
  return id
}

function requireToolName(toolNames: Map<string, string>, callId: unknown, isGemini: boolean): string {
  const id = requireToolCallId(callId)
  const name = toolNames.get(id)
  if (name === undefined) throw new LlmError('A tool result did not match a prior tool call', 'INVALID_ARGS')
  // Gemini omits IDs on the wire and may reuse them in later calls. Retain only
  // outstanding bindings, so completed calls can reuse an ID without allowing
  // ambiguous concurrent calls or orphan results. Other families keep their
  // existing history-wide name validation (Claude also sends IDs on the wire).
  if (isGemini) toolNames.delete(id)
  return name
}

function requireToolCallId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || containsControl(value)) {
    throw new LlmError('The tool call id is invalid', 'INVALID_ARGS')
  }
  return value
}

function normalizeReasoningEffort(value: GenerateOptions['reasoningEffort']): string | undefined {
  if (value === undefined) return undefined
  const normalized = String(value).toLowerCase()
  return ['minimal', 'low', 'medium', 'high'].includes(normalized) ? normalized : undefined
}

function resolveWireModel(model: string, reasoningEffort?: GenerateOptions['reasoningEffort']): string {
  if (model === 'antigravity-gemini-3.7-flash' || model === 'gemini-3.7-flash') {
    return 'gemini-3-flash'
  }
  const effort = normalizeReasoningEffort(reasoningEffort)
  const routeModel = effort !== undefined && (model === 'antigravity-gemini-3.8-flash' || model === 'gemini-3.8-flash')
    ? `${model}-${effort}`
    : model
  const resolved = resolveModelWithTier(routeModel, { cli_first: false })
  if (resolved.actualModel.startsWith('gemini-3.7-flash')) {
    return 'gemini-3-flash'
  }
  return resolved.actualModel
}

function requestSessionKey(options: GenerateOptions): string {
  return options.sessionId === undefined ? 'default' : `session:${fnv1a64Signed(String(options.sessionId))}`
}

function contentKinds(message: RequestMessage): Array<'text' | 'reasoning' | 'tool-call'> {
  return message.content.flatMap(block => block.type === 'text' || block.type === 'reasoning' || block.type === 'tool-call' ? [block.type] : [])
}

function parseProviderEvent(data: string): ProviderEvent {
  const normalized = data.trim().replace(/^\)\]\}'(?:\r?\n)?/u, '')
  let value: unknown
  try { value = JSON.parse(normalized) as unknown } catch {
    throw new PrivateTransportError('invalid-response', 'The private response contained invalid JSON')
  }
  if (!isRecord(value)) throw new PrivateTransportError('protocol-drift', 'The private response event was not an object')
  if (isRecord(value.error)) return { parts: [], error: errorDetails(value.error) }
  const root = isRecord(value.response) ? value.response : value
  if (isRecord(root.error)) return { parts: [], error: errorDetails(root.error) }
  const partsValue = findParts(root)
  // Gemini attaches the thinking signature to the response or candidate rather
  // than to each part. Capture it once here and hand it to the parts that need
  // validation, otherwise a replayed functionCall reaches the endpoint unsigned
  // and the provider rejects the whole request with HTTP 400.
  const responseSignature = responseLevelSignature(root, value, partsValue)
  const parts: ProviderPart[] = []
  for (const part of partsValue) {
    const parsed = parsePart(part)
    if (parsed === undefined) continue
    if (parsed.kind === 'tool-call' && parsed.signature === undefined && responseSignature !== undefined) {
      parts.push({ ...parsed, signature: responseSignature })
      continue
    }
    parts.push(parsed)
  }
  const usage = parseUsage(root.usageMetadata ?? value.usageMetadata)
  const finish = findFinish(root)
  return {
    parts,
    ...(usage === undefined ? {} : { usage }),
    ...(finish === undefined ? {} : { finish }),
  }
}

/** First provider-issued signature carried by the response envelope itself. */
function responseLevelSignature(
  root: Record<string, unknown>,
  envelope: Record<string, unknown>,
  parts: readonly unknown[],
): string | undefined {
  const direct = signatureOf(root) ?? signatureOf(envelope)
  if (direct !== undefined) return direct
  if (Array.isArray(root.candidates)) {
    for (const candidate of root.candidates) {
      if (!isRecord(candidate)) continue
      const candidateSignature = signatureOf(candidate)
        ?? (isRecord(candidate.content) ? signatureOf(candidate.content) : undefined)
        ?? (isRecord(candidate.metadata) && isRecord(candidate.metadata.google) ? signatureOf(candidate.metadata.google) : undefined)
      if (candidateSignature !== undefined) return candidateSignature
    }
  }
  if (isRecord(root.metadata) && isRecord(root.metadata.google)) {
    const nested = signatureOf(root.metadata.google)
    if (nested !== undefined) return nested
  }
  for (const part of parts) {
    if (!isRecord(part)) continue
    const partSignature = signatureOf(part) ?? (isRecord(part.metadata) && isRecord(part.metadata.google) ? signatureOf(part.metadata.google) : undefined)
    if (partSignature !== undefined) return partSignature
  }
  return undefined
}

function findParts(value: Record<string, unknown>): unknown[] {
  if (Array.isArray(value.parts)) return boundedParts(value.parts)
  if (isRecord(value.content) && Array.isArray(value.content.parts)) return boundedParts(value.content.parts)
  if (isRecord(value.modelTurn) && Array.isArray(value.modelTurn.parts)) return boundedParts(value.modelTurn.parts)
  if (Array.isArray(value.candidates)) {
    const output: unknown[] = []
    for (const candidate of value.candidates) {
      if (!isRecord(candidate)) continue
      const content = isRecord(candidate.content) ? candidate.content : candidate
      if (Array.isArray(content.parts)) {
        if (output.length + content.parts.length > MAX_PROVIDER_PARTS) throw new PrivateTransportError('protocol-drift', 'The private response contained too many parts')
        output.push(...content.parts)
      }
    }
    return output
  }
  if (isRecord(value.serverContent) && isRecord(value.serverContent.modelTurn) && Array.isArray(value.serverContent.modelTurn.parts)) {
    return boundedParts(value.serverContent.modelTurn.parts)
  }
  return []
}

function boundedParts(value: unknown[]): unknown[] {
  if (value.length > MAX_PROVIDER_PARTS) throw new PrivateTransportError('protocol-drift', 'The private response contained too many parts')
  return value
}

function parsePart(value: unknown): ProviderPart | undefined {
  if (!isRecord(value)) throw new PrivateTransportError('protocol-drift', 'The private response part was malformed')
  const functionCall = isRecord(value.functionCall) ? value.functionCall : isRecord(value.function_call) ? value.function_call : undefined
  if (functionCall !== undefined) {
    const name = stringValue(functionCall.name)
    const id = stringValue(functionCall.id)
    const signature = signatureOf(value) ?? signatureOf(functionCall)
    const args = typeof functionCall.args === 'string' ? functionCall.args : JSON.stringify(functionCall.args ?? {})
    return {
      kind: 'tool-call',
      ...(name === undefined ? {} : { name }),
      ...(id === undefined ? {} : { id }),
      arguments: args,
      ...(signature === undefined ? {} : { signature }),
    }
  }
  if (typeof value.text === 'string' || signatureOf(value) !== undefined) {
    const kind = value.thought === true || value.reasoning === true || value.thinking === true ? 'reasoning' as const : 'text' as const
    const signature = signatureOf(value)
    const text = typeof value.text === 'string' ? value.text : ''
    if (kind === 'text' && text.length === 0 && signature === undefined) {
      return undefined
    }
    return { kind, text, ...(signature === undefined ? {} : { signature }) }
  }
  if (value.inlineData !== undefined || value.inline_data !== undefined) {
    throw new PrivateTransportError('protocol-drift', 'The text model returned unsupported media output')
  }
  throw new PrivateTransportError('protocol-drift', 'The private response contained an unknown part type')
}

function errorDetails(value: Record<string, unknown>): NonNullable<ProviderEvent['error']> {
  const status = numberValue(value.status)
  const code = stringValue(value.code)
  const contextWindowExceeded = providerErrorReportsContextWindowExceeded(value, 0)
  return {
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
    ...(contextWindowExceeded ? { contextWindowExceeded: true } : {}),
  }
}

interface ProviderErrorReadOptions {
  readonly signal?: AbortSignal
  readonly idleTimeoutMs: number
  readonly totalTimeoutMs: number
  readonly maxResponseBytes: number
  readonly maxFrameBytes: number
}

async function responseReportsContextWindowExceeded(
  response: Response,
  options: ProviderErrorReadOptions,
): Promise<boolean> {
  try {
    for await (const event of iteratePrivateSse(response, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      idleTimeoutMs: options.idleTimeoutMs,
      totalTimeoutMs: options.totalTimeoutMs,
      maxBytes: Math.min(MAX_PROVIDER_ERROR_BYTES, options.maxResponseBytes),
      maxFrameBytes: Math.min(MAX_PROVIDER_ERROR_FRAME_BYTES, options.maxFrameBytes),
    })) {
      const payload = event.data.replace(/^\)\]\}'(?:\r?\n)?/u, '')
      if (providerErrorEnvelopeReportsContextWindowExceeded(payload, 0)) return true
    }
    return false
  } catch (error) {
    if (error instanceof PrivateTransportError && error.code === 'cancelled') throw toLlmError(error)
    if (isAborted(options.signal)) throw new LlmError('The Antigravity request was cancelled', 'CANCELLED')
    return false
  }
}

/**
 * Detect the provider's capacity-exhaustion verdict on an HTTP 503 body.
 *
 * The endpoint reports `MODEL_CAPACITY_EXHAUSTED` ("No capacity available for
 * model X on the server") as HTTP 503. That is a momentary capacity blip on one
 * model tier rather than a defect in the request, so the caller can wait and
 * resend instead of failing the turn.
 *
 * This probe only inspects the body; the caller is responsible for pinning the
 * status to 503 first. A 429 carrying the same marker is a rate-limit verdict
 * and must not be resent.
 * @param response - the private endpoint response, still unread.
 * @param options - bounded read limits shared with the context-window probe.
 * @returns whether the body declares capacity exhaustion.
 */
async function responseReportsModelCapacityExhausted(
  response: Response,
  options: ProviderErrorReadOptions,
): Promise<boolean> {
  try {
    for await (const event of iteratePrivateSse(response, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      idleTimeoutMs: options.idleTimeoutMs,
      totalTimeoutMs: options.totalTimeoutMs,
      maxBytes: Math.min(MAX_PROVIDER_ERROR_BYTES, options.maxResponseBytes),
      maxFrameBytes: Math.min(MAX_PROVIDER_ERROR_FRAME_BYTES, options.maxFrameBytes),
    })) {
      if (event.data.includes('MODEL_CAPACITY_EXHAUSTED') || event.data.includes('No capacity available')) return true
    }
    return false
  } catch (error) {
    if (error instanceof PrivateTransportError && error.code === 'cancelled') throw toLlmError(error)
    if (isAborted(options.signal)) throw new LlmError('The Antigravity request was cancelled', 'CANCELLED')
    return false
  }
}

/** Bounded exponential backoff between capacity retries. */
function backoffDelayMs(attempt: number): number {
  const base = CAPACITY_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1)
  const jitter = Math.floor(Math.random() * 250)
  return Math.min(base + jitter, CAPACITY_RETRY_MAX_DELAY_MS)
}

/** Abort-aware sleep so a cancelled turn never waits out a cooldown. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return new Promise(resolve => { setTimeout(resolve, ms) })
  return new Promise(resolve => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = (): void => { clearTimeout(timer); resolve() }
    if (signal.aborted) { clearTimeout(timer); resolve(); return }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function providerErrorReportsContextWindowExceeded(value: Record<string, unknown>, depth: number): boolean {
  if (depth > MAX_PROVIDER_ERROR_JSON_DEPTH) return false
  if (typeof value.message === 'string') {
    if (isExactContextWindowExceededMessage(value.message)) return true
    if (providerErrorEnvelopeReportsContextWindowExceeded(value.message, depth + 1)) return true
  }
  return isRecord(value.error) && providerErrorReportsContextWindowExceeded(value.error, depth + 1)
}

function providerErrorEnvelopeReportsContextWindowExceeded(value: string, depth: number): boolean {
  if (depth > MAX_PROVIDER_ERROR_JSON_DEPTH || value.length === 0 || value.length > MAX_PROVIDER_ERROR_BYTES) return false
  const json = value.trim()
  if (!json.startsWith('{') || !jsonDepthIsBounded(json, MAX_PROVIDER_ERROR_JSON_DEPTH)) return false
  try {
    const parsed = JSON.parse(json) as unknown
    return isRecord(parsed) && isRecord(parsed.error)
      ? providerErrorReportsContextWindowExceeded(parsed.error, depth + 1)
      : false
  } catch {
    return false
  }
}

function isExactContextWindowExceededMessage(value: string): boolean {
  const match = /^prompt is too long: ([0-9]{1,16}) tokens > ([0-9]{1,16}) maximum$/u.exec(value)
  const actual = match?.[1]
  const maximum = match?.[2]
  return actual !== undefined && maximum !== undefined && BigInt(actual) > BigInt(maximum)
}

function jsonDepthIsBounded(value: string, maxDepth: number): boolean {
  let depth = 0
  let inString = false
  let escaped = false
  for (const character of value) {
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === '{' || character === '[') {
      depth += 1
      if (depth > maxDepth) return false
    } else if (character === '}' || character === ']') {
      depth -= 1
      if (depth < 0) return false
    }
  }
  return depth === 0 && !inString && !escaped
}

function contextWindowExceededError(status?: number): LlmError {
  const message = 'The Antigravity request exceeded the model context window'
  return status === undefined
    ? new LlmError(message, CONTEXT_WINDOW_EXCEEDED_CODE)
    : new LlmError(message, CONTEXT_WINDOW_EXCEEDED_CODE, { status })
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const input = numberValue(value.promptTokenCount ?? value.inputTokenCount)
  const output = numberValue(value.candidatesTokenCount ?? value.outputTokenCount)
  const reasoning = numberValue(value.thoughtsTokenCount ?? value.reasoningTokenCount)
  const cached = numberValue(value.cachedContentTokenCount ?? value.cacheReadTokens)
  if (input === undefined && output === undefined && reasoning === undefined && cached === undefined) return undefined
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

function findFinish(value: Record<string, unknown>): string | undefined {
  const candidate = value.finishReason ?? value.finish_reason
  if (typeof candidate === 'string') return candidate
  if (isRecord(value.serverContent) && typeof value.serverContent.finishReason === 'string') return value.serverContent.finishReason
  if (Array.isArray(value.candidates)) {
    for (const item of value.candidates) if (isRecord(item) && typeof item.finishReason === 'string') return item.finishReason
  }
  return undefined
}

function signatureOf(value: Record<string, unknown>): string | undefined {
  const direct = stringValue(value.thoughtSignature ?? value.thought_signature ?? value.signature)
  if (direct !== undefined) return direct
  const metadata = isRecord(value.metadata) ? value.metadata : undefined
  const google = metadata !== undefined && isRecord(metadata.google) ? metadata.google : undefined
  return google === undefined ? undefined : stringValue(google.thoughtSignature ?? google.thought_signature ?? google.signature)
}

function parseJsonObject(value: string): Record<string, unknown> {
  if (typeof value !== 'string' || value.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    if (isRecord(parsed)) return parsed
  } catch {
    // A turn interrupted mid-stream can persist a truncated arguments fragment.
    // Repair the common missing-brace case before falling back, because one
    // malformed historical call must not make the whole session unusable: the
    // fragment is replayed on every later request, so throwing here locks the
    // session permanently.
    const repaired = repairTruncatedJsonObject(value)
    if (repaired !== undefined) return repaired
  }
  return {}
}

/** Recover a truncated JSON object body; undefined when it is not safely repairable. */
function repairTruncatedJsonObject(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{')) return undefined
  let inString = false
  let escaped = false
  for (const character of trimmed) {
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
  }
  // An unterminated string cannot be closed without guessing its content.
  if (inString || escaped) return undefined
  const suffix = closingSuffix(trimmed)
  if (suffix.length === 0) return undefined
  try {
    const parsed = JSON.parse(`${trimmed}${suffix}`) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Structural closing characters needed to balance a truncated JSON object body. */
function closingSuffix(value: string): string {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const character of value) {
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') stack.push('}')
    else if (character === '[') stack.push(']')
    else if (character === '}' || character === ']') stack.pop()
  }
  return stack.reverse().join('')
}

function blocksToText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').slice(0, 64 * 1024)
}

function isAuthenticationCode(value: string | undefined): boolean {
  const normalized = value?.toUpperCase()
  return normalized === 'UNAUTHENTICATED' || normalized === 'AUTHENTICATION' || normalized === 'INVALID_GRANT' || normalized === 'UNAUTHENTICATED_REQUEST'
}

function mapFinishReason(value: string | undefined): FinishReason['kind'] {
  const normalized = value?.toUpperCase()
  if (normalized === 'MAX_TOKENS' || normalized === 'LENGTH') return 'max-tokens'
  if (normalized === 'SAFETY' || normalized === 'BLOCKLIST' || normalized === 'ERROR') return 'error'
  if (normalized === 'TOOL_CALLS' || normalized === 'FUNCTION_CALL') return 'tool-calls'
  return 'stop'
}

function finishChunk(
  kind: FinishReason['kind'],
  code: string,
  status?: number,
  replayState?: ReplayEnvelope,
): StreamChunk {
  const reason: FinishReason = kind === 'aborted'
    ? { kind: 'aborted', failure: { code, message: 'The Antigravity request was cancelled' } }
    : kind === 'error'
      ? { kind: 'error', failure: { code, message: 'The Antigravity provider request failed', ...(status === undefined ? {} : { status }) } }
      : kind === 'max-tokens'
        ? { kind: 'max-tokens' }
        : kind === 'tool-calls'
          ? { kind: 'tool-calls' }
          : { kind: 'stop' }
  return { type: 'finish', reason, ...(replayState === undefined ? {} : { replayState }) }
}

const LLM_FAILURE_CODES: Readonly<Record<PrivateFailureKind, string>> = {
  authentication: 'AUTH',
  forbidden: 'FORBIDDEN',
  'rate-limited': 'RATE_LIMIT',
  cancelled: 'CANCELLED',
  timeout: 'TIMEOUT',
  'attribution-rejected': 'GATE_0_ATTRIBUTION',
  'protocol-drift': 'PROTOCOL_DRIFT',
  'response-limit': 'RESPONSE_LIMIT',
  'request-limit': 'REQUEST_LIMIT',
  upstream: 'UPSTREAM',
  network: 'NETWORK',
  failed: 'PROVIDER_ERROR',
}

function canFallBackToPinnedTextSnapshot(error: unknown): boolean {
  if (!(error instanceof LlmError)) return false
  return error.code === 'RATE_LIMIT'
    || error.code === 'TIMEOUT'
    || error.code === 'PROTOCOL_DRIFT'
    || error.code === 'RESPONSE_LIMIT'
    || error.code === 'UPSTREAM'
    || error.code === 'NETWORK'
}

function toModelCatalogError(
  error: unknown,
  signal: AbortSignal | undefined,
  fallback: 'provider' | 'protocol',
): LlmError {
  if (isAborted(signal)) return new LlmError('The Antigravity live model catalog request was cancelled', 'CANCELLED')
  if (error instanceof LlmError) return error
  if (error instanceof PrivateTransportError || fallback === 'provider') return toLlmError(error)
  return new LlmError('The Antigravity live model catalog did not match the audited schema', 'PROTOCOL_DRIFT')
}

const LLM_FAILURE_MESSAGES: Readonly<Record<PrivateFailureKind, string>> = {
  authentication: 'The Antigravity private request failed: authentication required',
  forbidden: 'The Antigravity private request failed: this account is forbidden',
  'rate-limited': 'Antigravity rate limit reached (Google returned 429 Resource Exhausted); please wait for your quota window to refresh',
  cancelled: 'The Antigravity private request was cancelled',
  timeout: 'The Antigravity private request timed out',
  'attribution-rejected': 'The Antigravity private request failed: identity attribution was rejected',
  'protocol-drift': 'The Antigravity private request was rejected (protocol drift)',
  'response-limit': 'The Antigravity private response exceeded the byte limit',
  'request-limit': 'The Antigravity private request exceeded the byte limit',
  upstream: 'The Antigravity private endpoint is unavailable',
  network: 'The Antigravity private request could not be reached',
  failed: 'The Antigravity private request failed safely',
}

function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  if (error instanceof PrivateTransportError) {
    const kind = classifyPrivateFailure(error)
    const code = LLM_FAILURE_CODES[kind]
    const base = LLM_FAILURE_MESSAGES[kind]
    const message = error.status === undefined ? base : `${base} (HTTP ${String(error.status)})`
    return error.status === undefined
      ? new LlmError(message, code)
      : new LlmError(message, code, { status: error.status })
  }
  return new LlmError('The Antigravity provider request failed safely', 'PROVIDER_ERROR')
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : Math.min(Math.floor(value), 10 * 60 * 1000)
}

function boundedLimit(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : Math.min(Math.floor(value), fallback)
}

function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new LlmError(`The Antigravity ${field} option is invalid`, 'INVALID_OPTIONS')
  return value
}

function boundedNumber(value: number, min: number, max: number, field: string): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new LlmError(`The Antigravity ${field} option is invalid`, 'INVALID_OPTIONS')
  return value
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 16 * 1024 && !containsControl(value) ? value : undefined
}

function safeProviderErrorCode(value: string | undefined): string {
  const normalized = value?.toUpperCase()
  return normalized === 'SAFETY' || normalized === 'BLOCKED' || normalized === 'RESOURCE_EXHAUSTED' || normalized === 'INVALID_ARGUMENT'
    ? normalized
    : 'UPSTREAM_ERROR'
}

function safeProviderStatus(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined
}

async function cancelResponse(response: Response): Promise<void> {
  try { await response.body?.cancel() } catch { /* best effort before a bounded replay */ }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
