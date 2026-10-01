/** Dedicated grounded Web Search provider and independently mounted Search row. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { resolveModelWithTier } from '@cortexkit/antigravity-auth-core'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import { createAntigravityAuthService } from './auth-service.ts'
import type { AntigravityAuthService } from './auth-service.ts'
import type { CredentialCoordinator, HostCredential } from './credential-coordinator.ts'
import {
  DEFAULT_PRIVATE_FRAME_BYTES,
  DEFAULT_PRIVATE_IDLE_TIMEOUT_MS,
  DEFAULT_PRIVATE_RESPONSE_BYTES,
  DEFAULT_PRIVATE_TOTAL_TIMEOUT_MS,
  PrivateTransportError,
  createPrivateTransport,
  iteratePrivateSse,
  privateStatusError,
  type PrivateTransport,
} from './private-transport.ts'
import { ANTIGRAVITY_WIRE_ORIGIN } from './wire-identity.ts'
import { classifyPrivateFailure, type PrivateFailureKind } from './private-failure.ts'
import { mountCapabilityLifecycle, type CapabilityLifecycle } from './capability-lifecycle.ts'
import { liveValue, type LiveValue } from './volatile-config.ts'

export const name = 'antigravity-search'
export const inject = ['web', 'antigravityAuth']
export const ANTIGRAVITY_SEARCH_PROVIDER_ID = 'antigravity'
export const ANTIGRAVITY_SEARCH_ENDPOINT = `${ANTIGRAVITY_WIRE_ORIGIN}/v1internal:generateContent` as const
export const ANTIGRAVITY_SEARCH_MODEL = 'antigravity-gemini-3.7-flash'
export const ANTIGRAVITY_SEARCH_SETTINGS_NAMESPACE = 'antigravity-search'

export interface AntigravitySearchSettings {
  enabled: boolean
  model: string
  maxResults: number
}

export interface Config {
  enabled: LiveValue<boolean>
  model: LiveValue<string>
  maxResults: LiveValue<number>
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).volatile(),
  model: z.string().default(ANTIGRAVITY_SEARCH_MODEL).volatile(),
  maxResults: z.number().step(1).min(1).max(50).default(10).volatile(),
}) as unknown as z<Config>

export interface AntigravitySearchProviderOptions {
  readonly auth: Pick<CredentialCoordinator, 'credential'> | { credential(signal?: AbortSignal): Promise<HostCredential | undefined> }
  readonly enabled?: () => boolean
  readonly settings?: () => AntigravitySearchSettings
  readonly transport?: PrivateTransport
  readonly maxResponseBytes?: number
}

export class AntigravitySearchProvider implements WebSearchProvider {
  readonly id = ANTIGRAVITY_SEARCH_PROVIDER_ID
  private readonly enabled: () => boolean
  private readonly transport: PrivateTransport

  constructor(private readonly options: AntigravitySearchProviderOptions) {
    this.enabled = options.enabled ?? (() => options.settings?.().enabled ?? true)
    this.transport = options.transport ?? createPrivateTransport()
  }

  available(): boolean {
    return this.enabled()
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (!this.enabled()) throw new WebError('Antigravity Web Search is disabled by its capability gate', 'ANTIGRAVITY_SEARCH_DISABLED')
    if (signal?.aborted === true) throw new WebError('Antigravity Web Search was cancelled', 'ANTIGRAVITY_SEARCH_CANCELLED')
    if (typeof request.query !== 'string' || request.query.trim().length === 0 || request.query.length > 16_384) {
      throw new WebError('Antigravity Web Search requires a bounded query', 'ANTIGRAVITY_SEARCH_INVALID_QUERY')
    }
    const settings = this.options.settings?.() ?? { enabled: true, model: ANTIGRAVITY_SEARCH_MODEL, maxResults: 10 }
    const configuredMax = boundedInteger(settings.maxResults, 1, 50)
    const requestedMax = request.maxResults === undefined ? configuredMax : boundedInteger(request.maxResults, 1, 50)
    const maxResults = Math.min(configuredMax, requestedMax)
    const credential = await this.options.auth.credential(signal)
    if (credential === undefined) throw new WebError('Antigravity Web Search requires a logged-in account', 'ANTIGRAVITY_SEARCH_AUTH_REQUIRED')
    const response = await this.transport.request({
      url: ANTIGRAVITY_SEARCH_ENDPOINT,
      accessToken: credential.accessToken,
      body: JSON.stringify(buildGroundedSearchPayload(request.query.trim(), credential, settings.model)),
      ...(signal === undefined ? {} : { signal }),
    }).catch(error => { throw toWebError(error) })
    const statusError = privateStatusError(response.status)
    if (statusError !== undefined) {
      await response.body?.cancel().catch(() => {})
      throw toWebError(statusError)
    }
    const sources: WebSearchSource[] = []
    const seen = new Set<string>()
    const content: string[] = []
    let truncated = false
    try {
      for await (const event of iteratePrivateSse(response, {
        ...(signal === undefined ? {} : { signal }),
        idleTimeoutMs: DEFAULT_PRIVATE_IDLE_TIMEOUT_MS,
        totalTimeoutMs: DEFAULT_PRIVATE_TOTAL_TIMEOUT_MS,
        maxBytes: this.options.maxResponseBytes ?? DEFAULT_PRIVATE_RESPONSE_BYTES,
        maxFrameBytes: DEFAULT_PRIVATE_FRAME_BYTES,
      })) {
        if (event.data.trim() === '[DONE]') continue
        const value = parseJson(event.data)
        truncated ||= collectSearchFacts(value, content, sources, seen, maxResults)
      }
    } catch (error) {
      throw toWebError(error)
    }
    if (sources.length === 0) throw new WebError('Antigravity Search returned no validated grounding sources', 'ANTIGRAVITY_SEARCH_NO_SOURCES')
    return {
      ...(content.length === 0 ? {} : { content: content.join('').slice(0, 64 * 1024) }),
      sources,
      truncated,
    }
  }
}

export function buildGroundedSearchPayload(query: string, credential: Pick<HostCredential, 'projectId'>, model = ANTIGRAVITY_SEARCH_MODEL): Record<string, unknown> {
  return {
    project: credential.projectId,
    model: resolveModelWithTier(model, { cli_first: false }).actualModel,
    request: {
      contents: [{ role: 'user', parts: [{ text: query }] }],
      tools: [{ googleSearch: {} }],
      systemInstruction: { parts: [{ text: 'Return a concise grounded answer with only sources supplied by the provider.' }] },
    },
  }
}

/** Mount only the public Web Search seam; no fetch provider is registered. */
export function apply(ctx?: Context, config: Config = { enabled: true, model: ANTIGRAVITY_SEARCH_MODEL, maxResults: 10 }): void {
  if (ctx === undefined) return
  const candidate = ctx as unknown as { web?: { registerSearchProvider: (value: WebSearchProvider) => () => void; searchProviderId?: string | undefined }; get?: (name: string) => unknown }
  if (candidate.web === undefined) return
  const current = (): AntigravitySearchSettings => ({
    enabled: liveValue(config.enabled), model: liveValue(config.model), maxResults: liveValue(config.maxResults),
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
    id: 'search',
    enabled: () => current().enabled,
    register: () => {
      const unregister = candidate.web!.registerSearchProvider(new AntigravitySearchProvider({ auth, settings: () => current() }))
      const previousSearchProviderId = candidate.web!.searchProviderId
      if (!previousSearchProviderId || previousSearchProviderId === 'deepseek-official') {
        candidate.web!.searchProviderId = ANTIGRAVITY_SEARCH_PROVIDER_ID
      }
      return () => {
        if (candidate.web!.searchProviderId === ANTIGRAVITY_SEARCH_PROVIDER_ID) {
          if (previousSearchProviderId !== undefined) {
            candidate.web!.searchProviderId = previousSearchProviderId
          } else {
            delete candidate.web!.searchProviderId
          }
        }
        unregister()
      }
    },
    ownsAuth: auth !== provided,
    label: 'antigravity-search: provider lifecycle',
  })
}

function collectSearchFacts(
  value: unknown,
  content: string[],
  sources: WebSearchSource[],
  seen: Set<string>,
  maxResults: number,
): boolean {
  if (!isRecord(value)) return false
  const root = isRecord(value.response) ? value.response : value
  const texts = [findText(root)]
  const metadataValues: unknown[] = [root.groundingMetadata, root.grounding_metadata, value.groundingMetadata]
  if (Array.isArray(root.candidates)) {
    if (root.candidates.length > 512) throw new WebError('Antigravity Search returned too many candidates', 'ANTIGRAVITY_SEARCH_PROTOCOL_DRIFT')
    for (const candidate of root.candidates) {
      if (!isRecord(candidate)) continue
      texts.push(findText(candidate))
      if (isRecord(candidate.content)) texts.push(findText(candidate.content))
      metadataValues.push(candidate.groundingMetadata, candidate.grounding_metadata)
    }
  }
  for (const text of texts) appendBounded(content, text)
  let truncated = false
  for (const rawMetadata of metadataValues) {
    if (!isRecord(rawMetadata)) continue
    const chunks = rawMetadata.groundingChunks ?? rawMetadata.grounding_chunks
    if (!Array.isArray(chunks)) continue
    if (chunks.length > 4096) throw new WebError('Antigravity Search returned too many grounding sources', 'ANTIGRAVITY_SEARCH_PROTOCOL_DRIFT')
    for (const chunk of chunks) {
      if (!isRecord(chunk)) continue
      const web = isRecord(chunk.web) ? chunk.web : isRecord(chunk.webSource) ? chunk.webSource : undefined
      if (web === undefined || typeof web.uri !== 'string' || !isHttpUrl(web.uri)) continue
      const url = web.uri
      if (seen.has(url)) continue
      if (sources.length >= maxResults) {
        truncated = true
        break
      }
      seen.add(url)
      const title = safeSourceText(web.title, 1024)
      const snippet = safeSourceText(web.snippet, 4096)
      sources.push({ url, ...(title === undefined ? {} : { title }), ...(snippet === undefined ? {} : { snippet }) })
    }
  }
  return truncated
}

function appendBounded(output: string[], value: string | undefined): void {
  if (value === undefined || value.length === 0) return
  const used = output.reduce((total, item) => total + item.length, 0)
  if (used < 64 * 1024) output.push(value.slice(0, 64 * 1024 - used))
}

function findText(value: Record<string, unknown>): string | undefined {
  const parts = Array.isArray(value.parts) ? value.parts : isRecord(value.content) && Array.isArray(value.content.parts) ? value.content.parts : []
  const output: string[] = []
  let length = 0
  for (const part of parts) {
    if (!isRecord(part) || typeof part.text !== 'string' || hasControl(part.text)) continue
    const text = part.text.slice(0, 64 * 1024 - length)
    output.push(text)
    length += text.length
    if (length >= 64 * 1024) break
  }
  return output.length === 0 ? undefined : output.join('')
}

function safeSourceText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !hasControl(value) ? value : undefined
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return true
  }
  return false
}

function parseJson(value: string): unknown {
  const normalized = value.trim().replace(/^\)\]\}'(?:\r?\n)?/u, '')
  try { return JSON.parse(normalized) as unknown } catch { throw new WebError('Antigravity Search returned malformed provider data', 'ANTIGRAVITY_SEARCH_PROTOCOL_DRIFT') }
}

const SEARCH_FAILURE_CODES: Readonly<Record<PrivateFailureKind, string>> = {
  authentication: 'ANTIGRAVITY_SEARCH_AUTH_REQUIRED',
  forbidden: 'ANTIGRAVITY_SEARCH_FORBIDDEN',
  'rate-limited': 'ANTIGRAVITY_SEARCH_RATE_LIMITED',
  cancelled: 'ANTIGRAVITY_SEARCH_CANCELLED',
  timeout: 'ANTIGRAVITY_SEARCH_TIMEOUT',
  'attribution-rejected': 'ANTIGRAVITY_SEARCH_PROTOCOL_DRIFT',
  'protocol-drift': 'ANTIGRAVITY_SEARCH_PROTOCOL_DRIFT',
  'response-limit': 'ANTIGRAVITY_SEARCH_PROTOCOL_DRIFT',
  'request-limit': 'ANTIGRAVITY_SEARCH_PROTOCOL_DRIFT',
  upstream: 'ANTIGRAVITY_SEARCH_FAILED',
  network: 'ANTIGRAVITY_SEARCH_FAILED',
  failed: 'ANTIGRAVITY_SEARCH_FAILED',
}

function toWebError(error: unknown): WebError {
  if (error instanceof WebError) return error
  if (error instanceof PrivateTransportError) {
    return new WebError('The Antigravity Search request failed safely', SEARCH_FAILURE_CODES[classifyPrivateFailure(error)])
  }
  return new WebError('The Antigravity Search request failed safely', 'ANTIGRAVITY_SEARCH_FAILED')
}

function isAuthService(value: unknown): value is AntigravityAuthService {
  return isRecord(value) && typeof value.credential === 'function' && typeof value.status === 'function'
}

function isHttpUrl(value: string): boolean {
  if (value.length === 0 || value.length > 8192 || value.trim() !== value || hasControl(value)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username.length === 0 && url.password.length === 0
  } catch { return false }
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new WebError('Antigravity Search result limit is invalid', 'ANTIGRAVITY_SEARCH_INVALID_QUERY')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
