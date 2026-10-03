/** Host-only, read-only project discovery and safe project normalization. */

import { buildAntigravityLoadCodeAssistMetadata } from '@cortexkit/antigravity-auth-core'
import type { ProjectValidation } from './oauth-flow.ts'
import {
  DEFAULT_PRIVATE_IDLE_TIMEOUT_MS,
  DEFAULT_PRIVATE_RESPONSE_BYTES,
  DEFAULT_PRIVATE_TOTAL_TIMEOUT_MS,
  PrivateTransportError,
  createPrivateTransport,
  privateStatusError,
  readPrivateText,
  type PrivateTransport,
  type PrivateTransportOptions,
} from './private-transport.ts'
import { ANTIGRAVITY_WIRE_ORIGIN } from './wire-identity.ts'
import { classifyPrivateFailure, type PrivateFailureKind } from './private-failure.ts'

export const PROJECT_DISCOVERY_PATH = '/v1internal:loadCodeAssist' as const
export const PROJECT_DISCOVERY_ENDPOINT = `${ANTIGRAVITY_WIRE_ORIGIN}${PROJECT_DISCOVERY_PATH}` as const

const MAX_RESPONSE_BYTES = Math.min(DEFAULT_PRIVATE_RESPONSE_BYTES, 64 * 1024)
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000
const MAX_OPERATION_TIMEOUT_MS = 10 * 60 * 1000
const MAX_PROJECT_ID_LENGTH = 128
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-_]{1,127}$/u

export type ProjectDiscoveryErrorCode =
  | 'authentication'
  | 'forbidden'
  | 'rate-limited'
  | 'offline'
  | 'malformed'
  | 'protocol-drift'
  | 'cancelled'

export class ProjectDiscoveryError extends Error {
  readonly code: ProjectDiscoveryErrorCode

  constructor(code: ProjectDiscoveryErrorCode, message = projectDiscoveryErrorMessage(code)) {
    super(message)
    this.name = 'ProjectDiscoveryError'
    this.code = code
  }
}

export interface ProjectDiscoveryOptions {
  /** Inject a complete deterministic transport for offline tests; identity is never injectable. */
  readonly transport?: PrivateTransport
  readonly transportOptions?: PrivateTransportOptions
  readonly operationTimeoutMs?: number
}

export interface ProjectDiscovery {
  /** Discover only a project returned for the supplied access token. */
  discover(accessToken: string, signal?: AbortSignal): Promise<ProjectValidation | undefined>
}

/** Project Context is the parent-spec name for the discovery seam. */
export type ProjectContext = ProjectDiscovery
export type { ProjectValidation }

/** Create the fixed, read-only loadCodeAssist project probe. */
export function createProjectDiscovery(options: ProjectDiscoveryOptions = {}): ProjectDiscovery {
  const timeoutMs = boundedTimeout(options.operationTimeoutMs)
  const transport = options.transport ?? createPrivateTransport({
    ...(options.transportOptions?.responseHeaderTimeoutMs === undefined ? {} : { responseHeaderTimeoutMs: options.transportOptions.responseHeaderTimeoutMs }),
    ...(options.transportOptions?.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.transportOptions.maxRequestBytes }),
  })

  return {
    discover: async (accessToken, signal) => {
      if (signal?.aborted === true) throw new ProjectDiscoveryError('cancelled')
      const body = JSON.stringify({ metadata: buildAntigravityLoadCodeAssistMetadata() })
      let response: Response
      try {
        response = await transport.request({
          url: PROJECT_DISCOVERY_ENDPOINT,
          accessToken,
          body,
          ...(signal === undefined ? {} : { signal }),
          responseHeaderTimeoutMs: timeoutMs,
        })
      } catch (error) {
        throw mapTransportError(error)
      }
      const statusError = privateStatusError(response.status)
      if (statusError !== undefined) {
        await response.body?.cancel().catch(() => {})
        throw mapTransportError(statusError)
      }
      try {
        const text = await readPrivateText(response, {
          ...(signal === undefined ? {} : { signal }),
          idleTimeoutMs: Math.min(timeoutMs, DEFAULT_PRIVATE_IDLE_TIMEOUT_MS),
          totalTimeoutMs: Math.min(timeoutMs, DEFAULT_PRIVATE_TOTAL_TIMEOUT_MS),
          maxBytes: MAX_RESPONSE_BYTES,
        })
        let value: unknown
        try { value = JSON.parse(text) as unknown } catch { throw new ProjectDiscoveryError('malformed') }
        return parseProjectResponse(value)
      } catch (error) {
        if (error instanceof ProjectDiscoveryError) throw error
        throw mapTransportError(error)
      }
    },
  }
}

/** Compatibility name used by the parent capability design. */
export const createProjectContext = createProjectDiscovery

/** Normalize the only project field that may cross into the credential store. */
export function normalizeProjectId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  let normalized = value.trim()
  if (normalized.startsWith('projects/')) {
    normalized = normalized.slice('projects/'.length).trim()
  }
  if (normalized.length === 0 || normalized.length > MAX_PROJECT_ID_LENGTH) return undefined
  return PROJECT_ID_PATTERN.test(normalized) ? normalized : undefined
}

function parseProjectResponse(value: unknown): ProjectValidation | undefined {
  if (!isRecord(value)) throw new ProjectDiscoveryError('malformed')
  if (!Object.prototype.hasOwnProperty.call(value, 'cloudaicompanionProject')) return undefined

  const candidate = value.cloudaicompanionProject
  if (candidate === null || candidate === undefined) return undefined
  if (typeof candidate === 'string') {
    if (candidate.trim().length === 0) return undefined
    return projectFromValue(candidate)
  }
  if (!isRecord(candidate)) throw new ProjectDiscoveryError('protocol-drift')
  if (!Object.prototype.hasOwnProperty.call(candidate, 'id')) return undefined
  if (candidate.id === null || candidate.id === undefined) throw new ProjectDiscoveryError('protocol-drift')
  return projectFromValue(candidate.id)
}

function projectFromValue(value: unknown): ProjectValidation {
  const projectId = normalizeProjectId(value)
  if (projectId === undefined) throw new ProjectDiscoveryError('protocol-drift')
  return { projectId }
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_OPERATION_TIMEOUT_MS
  return Math.min(Math.floor(value), MAX_OPERATION_TIMEOUT_MS)
}

const PROJECT_FAILURE_CODES: Readonly<Record<PrivateFailureKind, ProjectDiscoveryErrorCode>> = {
  authentication: 'authentication',
  forbidden: 'forbidden',
  'rate-limited': 'rate-limited',
  cancelled: 'cancelled',
  timeout: 'offline',
  'attribution-rejected': 'protocol-drift',
  'protocol-drift': 'protocol-drift',
  'response-limit': 'protocol-drift',
  'request-limit': 'protocol-drift',
  upstream: 'offline',
  network: 'offline',
  failed: 'offline',
}

function mapTransportError(error: unknown): ProjectDiscoveryError {
  if (error instanceof ProjectDiscoveryError) return error
  if (error instanceof PrivateTransportError) return new ProjectDiscoveryError(PROJECT_FAILURE_CODES[classifyPrivateFailure(error)])
  return new ProjectDiscoveryError('offline')
}

function projectDiscoveryErrorMessage(code: ProjectDiscoveryErrorCode): string {
  if (code === 'authentication') return 'The Antigravity project probe requires authentication'
  if (code === 'forbidden') return 'The Antigravity project probe was forbidden'
  if (code === 'rate-limited') return 'The Antigravity project probe is rate-limited'
  if (code === 'offline') return 'The Antigravity project probe is offline'
  if (code === 'malformed') return 'The Antigravity project response was malformed'
  if (code === 'protocol-drift') return 'The Antigravity project protocol changed'
  return 'The Antigravity project probe was cancelled'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
