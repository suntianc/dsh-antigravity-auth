import { describe, expect, it, vi } from 'vitest'
import {
  PROJECT_DISCOVERY_ENDPOINT,
  ProjectDiscoveryError,
  createProjectDiscovery,
  normalizeProjectId,
} from '../src/project-context.ts'
import { PrivateTransportError } from '../src/private-transport.ts'
import type { PrivateTransport, PrivateTransportRequest } from '../src/private-transport.ts'

function response(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

function transportWith(
  dispatch: (input: PrivateTransportRequest) => Response | Promise<Response>,
): PrivateTransport & { request: ReturnType<typeof vi.fn> } {
  return { request: vi.fn(dispatch) } as unknown as PrivateTransport & { request: ReturnType<typeof vi.fn> }
}

describe('read-only Antigravity project discovery', () => {
  it('uses the fixed loadCodeAssist request and stores only a normalized project id', async () => {
    const transport = transportWith(async () => response({
      cloudaicompanionProject: { id: ' project-123 ' },
      currentTier: { id: 'private-tier' },
      rawProviderField: 'must-not-cross-the-boundary',
    }))
    const discovery = createProjectDiscovery({ transport })

    await expect(discovery.discover('access-secret')).resolves.toEqual({ projectId: 'project-123' })
    expect(transport.request).toHaveBeenCalledOnce()
    const request = transport.request.mock.calls[0]?.[0] as PrivateTransportRequest
    expect(request.url).toBe(PROJECT_DISCOVERY_ENDPOINT)
    expect(JSON.parse(String(request.body))).toEqual({ metadata: { ideType: 'ANTIGRAVITY' } })
    expect(String(request.body)).not.toContain('onboardUser')
    expect(String(request.body)).not.toContain('rising-fact-p41fc')
  })

  it('returns project-unavailable for an otherwise valid response without a project', async () => {
    const discovery = createProjectDiscovery({ transport: transportWith(async () => response({ currentTier: { id: 'free' } })) })
    await expect(discovery.discover('access-secret')).resolves.toBeUndefined()
  })

  it.each([
    [401, 'authentication'],
    [403, 'forbidden'],
    [429, 'rate-limited'],
    [500, 'offline'],
    [504, 'offline'],
    [404, 'protocol-drift'],
  ] as const)('maps HTTP %s to the safe project state %s', async (status, code) => {
    const transport = transportWith(async () => new Response('provider-secret-body', { status }))
    const discovery = createProjectDiscovery({ transport })

    await expect(discovery.discover('access-secret')).rejects.toMatchObject({ code })
    await expect(discovery.discover('access-secret')).rejects.not.toThrow(/provider-secret-body|access-secret/u)
  })

  it('distinguishes malformed JSON from protocol drift without exposing the response', async () => {
    const malformed = createProjectDiscovery({ transport: transportWith(async () => new Response('not-json')) })
    await expect(malformed.discover('access-secret')).rejects.toMatchObject({ code: 'malformed' })

    const drift = createProjectDiscovery({
      transport: transportWith(async () => response({ cloudaicompanionProject: { id: 42, secret: 'provider-secret' } })),
    })
    await expect(drift.discover('access-secret')).rejects.toMatchObject({ code: 'protocol-drift' })
    await expect(drift.discover('access-secret')).rejects.not.toThrow(/provider-secret|access-secret/u)
  })

  it('fails closed when the fixed raw identity is rejected', async () => {
    const transport = transportWith(async () => {
      throw new PrivateTransportError('attribution-rejected', 'rejected', { accepted: false })
    })
    const discovery = createProjectDiscovery({ transport })

    const operation = discovery.discover('access-secret')
    await expect(operation).rejects.toBeInstanceOf(ProjectDiscoveryError)
    await expect(operation).rejects.toMatchObject({ code: 'protocol-drift' })
    expect(transport.request).toHaveBeenCalledOnce()
  })

  describe('normalizeProjectId and prefix stripping', () => {
    it('strips projects/ prefix correctly', () => {
      expect(normalizeProjectId('projects/my-gen-ai-project-123')).toBe('my-gen-ai-project-123')
      expect(normalizeProjectId('  projects/another-project_456  ')).toBe('another-project_456')
    })

    it('accepts alphanumeric, underscores, and dashes', () => {
      expect(normalizeProjectId('project-123')).toBe('project-123')
      expect(normalizeProjectId('a_b-c_123')).toBe('a_b-c_123')
      expect(normalizeProjectId('0abc-def')).toBe('0abc-def')
    })

    it('enforces length constraints up to 128 characters and rejects longer values', () => {
      const valid128 = 'a' + 'b'.repeat(127)
      expect(normalizeProjectId(valid128)).toBe(valid128)

      const invalid129 = 'a' + 'b'.repeat(128)
      expect(normalizeProjectId(invalid129)).toBeUndefined()
    })

    it('rejects invalid inputs such as uppercase, special characters, whitespace or non-string', () => {
      expect(normalizeProjectId('Project-Uppercase')).toBeUndefined()
      expect(normalizeProjectId('invalid@chars!')).toBeUndefined()
      expect(normalizeProjectId('has space')).toBeUndefined()
      expect(normalizeProjectId('')).toBeUndefined()
      expect(normalizeProjectId('   ')).toBeUndefined()
      expect(normalizeProjectId('projects/')).toBeUndefined()
      expect(normalizeProjectId('-startsWithDash')).toBeUndefined()
      expect(normalizeProjectId(null)).toBeUndefined()
      expect(normalizeProjectId(12345)).toBeUndefined()
      expect(normalizeProjectId({})).toBeUndefined()
    })

    it('discovery strips projects/ prefix in response', async () => {
      const transport = transportWith(async () => response({
        cloudaicompanionProject: { id: 'projects/enterprise-ai-987' },
      }))
      const discovery = createProjectDiscovery({ transport })
      await expect(discovery.discover('access-secret')).resolves.toEqual({ projectId: 'enterprise-ai-987' })
    })
  })
})
