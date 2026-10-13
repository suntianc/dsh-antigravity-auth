import { describe, expect, it, vi } from 'vitest'
import {
  createAntigravityAuthRpcClient,
  parseModelCatalogResult,
  parseStatusResult,
  parseUsageResult,
} from '../src/rpc-contract.ts'
import type { AntigravityAuthConnectionRpc } from '../src/rpc-contract.ts'
import { handleAntigravityAuthRpc } from '../src/rpc.ts'
import { createMemoryAuthStore } from '../src/auth-store.ts'
import { createBootstrapStatusService } from '../src/bootstrap-service.ts'
import { createStatusView } from '../src/status.ts'

const signal = new AbortController().signal

async function request(endpoint: string, payload: unknown) {
  return handleAntigravityAuthRpc(createBootstrapStatusService(), endpoint, payload, signal)
}

function loginFixture() {
  return {
    started: true as const,
    phase: 'pending' as const,
    authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${'a'.repeat(43)}`,
    expiresAt: '2026-08-21T00:00:00.000Z',
  }
}

describe('Antigravity login RPC', () => {
  it('returns value-free plugin, login, and gate status', async () => {
    const result = await request('status', {})

    expect(result).toEqual({
      ok: true,
      value: {
        status: {
          pluginId: 'dsh-antigravity-auth',
          phase: 'bootstrap',
          privateSelfUse: true,
          singleAccount: true,
          riskAcknowledgementRequired: true,
          riskAcknowledged: false,
          login: { phase: 'idle', configured: false, projectAvailable: false },
          credential: { state: 'logged-out', configured: false },
          revoke: { state: 'idle' },
          capabilities: [
            { id: 'auth-llm', state: 'disabled', reasonCode: 'unauthenticated' },
            { id: 'search', state: 'disabled', reasonCode: 'unauthenticated' },
            { id: 'image', state: 'disabled', reasonCode: 'unauthenticated' },
            { id: 'video', state: 'disabled', reasonCode: 'unauthenticated' },
          ],
        },
      },
    })
    expect(JSON.stringify(result)).not.toMatch(/token|secret|cookie/i)
  })

  it('keeps model discovery snapshot-only until Gate 0/L passes, then allows one bounded refresh', async () => {
    const service = createBootstrapStatusService()
    const snapshot = {
      state: 'snapshot' as const,
      models: [{ id: 'antigravity-gemini-3.7-flash', name: 'Gemini 3.7 Flash', state: 'snapshot' as const }],
    }
    const live = {
      state: 'live-available' as const,
      checkedAt: '2030-01-01T00:00:00.000Z',
      models: [{ id: 'antigravity-gemini-3.7-flash', name: 'Gemini 3.7 Flash', state: 'live-available' as const }],
    }
    const catalog = { catalogSnapshot: vi.fn(() => snapshot), modelCatalog: vi.fn(async () => live) }

    await expect(handleAntigravityAuthRpc(service, 'models', { force: true }, signal, catalog)).resolves.toEqual({ ok: true, value: snapshot })
    expect(catalog.modelCatalog).not.toHaveBeenCalled()

    vi.spyOn(service, 'status').mockResolvedValue(createStatusView(
      true,
      { phase: 'success', configured: true, projectAvailable: true },
      undefined,
      undefined,
      {
        gate0: { outcome: 'passed', checkedAt: '2030-01-01T00:00:00.000Z' },
        llmFamilies: {
          gemini: { outcome: 'passed', checkedAt: '2030-01-01T00:00:00.000Z' },
          claude: { outcome: 'passed', checkedAt: '2030-01-01T00:00:00.000Z' },
          'gpt-oss': { outcome: 'passed', checkedAt: '2030-01-01T00:00:00.000Z' },
        },
      },
    ))
    await expect(handleAntigravityAuthRpc(service, 'models', { force: true }, signal, catalog)).resolves.toEqual({ ok: true, value: live })
    expect(catalog.modelCatalog).toHaveBeenCalledWith(signal, true)
    await service.dispose()
  })

  it('requires a risk acknowledgement before login can begin', async () => {
    const service = createBootstrapStatusService()
    const result = await handleAntigravityAuthRpc(service, 'login', {}, signal)

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'risk-acknowledgement-required' },
    })
    await service.dispose()
  })

  it('returns an authorization URL only after acknowledgement and supports cancellation', async () => {
    const listener = { close: vi.fn(async () => {}) }
    const service = createBootstrapStatusService({
      flowOptions: { listenerFactory: { listen: vi.fn(async () => listener) } },
    })

    expect(await handleAntigravityAuthRpc(service, 'acknowledge-risk', { acknowledge: true }, signal)).toEqual({
      ok: true,
      value: { acknowledged: true },
    })
    const login = await handleAntigravityAuthRpc(service, 'login', {}, signal)
    expect(login).toMatchObject({ ok: true, value: { started: true, phase: 'pending' } })
    expect(JSON.stringify(login)).not.toMatch(/verifier|client_secret|token/i)
    expect(await handleAntigravityAuthRpc(service, 'cancel', {}, signal)).toEqual({
      ok: true,
      value: { phase: 'cancelled', errorCode: 'cancelled' },
    })
    expect(listener.close).toHaveBeenCalledOnce()
    await service.dispose()
  })

  it('supports an injectable opener during login and safely ignores opener rejection without throwing', async () => {
    const listener = { close: vi.fn(async () => {}) }
    const service = createBootstrapStatusService({
      flowOptions: { listenerFactory: { listen: vi.fn(async () => listener) } },
    })
    await handleAntigravityAuthRpc(service, 'acknowledge-risk', { acknowledge: true }, signal)

    const opener = vi.fn(() => false)
    const login = await handleAntigravityAuthRpc(service, 'login', {}, signal, undefined, opener)
    expect(login).toMatchObject({ ok: true, value: { started: true, phase: 'pending' } })
    expect(opener).toHaveBeenCalledOnce()
    const calledUrl = opener.mock.calls[0]?.[0]
    expect(typeof calledUrl).toBe('string')
    expect(calledUrl).toContain('accounts.google.com')

    // Opener throwing does not break login response
    const failingOpener = vi.fn(() => { throw new Error('opener error') })
    await handleAntigravityAuthRpc(service, 'cancel', {}, signal)
    const login2 = await handleAntigravityAuthRpc(service, 'login', {}, signal, undefined, failingOpener)
    expect(login2).toMatchObject({ ok: true, value: { started: true, phase: 'pending' } })

    await service.dispose()
  })

  it('keeps local logout separate from confirmed grant revocation', async () => {
    const localStore = createMemoryAuthStore()
    await localStore.commit({ refreshToken: 'local-refresh', projectId: 'project-id' })
    const localRevoke = vi.fn(async () => {})
    const localService = createBootstrapStatusService({ store: localStore, credentialOptions: { revokeGrant: localRevoke } })
    await expect(handleAntigravityAuthRpc(localService, 'logout', {}, signal)).resolves.toEqual({ ok: true, value: { state: 'logged-out' } })
    await expect(localStore.read()).resolves.toBeUndefined()
    expect(localRevoke).not.toHaveBeenCalled()
    await localService.dispose()

    const revokeStore = createMemoryAuthStore()
    await revokeStore.commit({ refreshToken: 'grant-refresh', projectId: 'project-id' })
    const revoke = vi.fn(async () => {})
    const revokeService = createBootstrapStatusService({ store: revokeStore, credentialOptions: { revokeGrant: revoke } })
    await expect(handleAntigravityAuthRpc(revokeService, 'revoke', { confirmed: false }, signal)).resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
    await expect(handleAntigravityAuthRpc(revokeService, 'revoke', { confirmed: true }, signal)).resolves.toEqual({ ok: true, value: { state: 'revoked' } })
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ token: 'grant-refresh', signal: expect.any(AbortSignal) }))
    await expect(revokeStore.read()).resolves.toBeUndefined()
    await revokeService.dispose()
  })

  it('rejects malformed payloads and unknown endpoints without evaluating the service', async () => {
    const service = createBootstrapStatusService()
    const status = vi.spyOn(service, 'status')
    for (const [endpoint, payload] of [
      ['status', { extra: true }],
      ['acknowledge-risk', { acknowledge: true, extra: true }],
      ['login', { callbackUrl: 'forbidden-value' }],
      ['cancel', { extra: true }],
      ['models', { force: 'yes' }],
      ['complete-callback', { callbackUrl: '' }],
      ['logout', { extra: true }],
      ['revoke', { confirmed: false }],
      ['private', {}],
    ] as const) {
      const result = await handleAntigravityAuthRpc(service, endpoint, payload, signal)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('bad-request')
    }
    expect(status).not.toHaveBeenCalled()
    await service.dispose()
  })

  it.each([
    'project-unavailable',
    'project-authentication-failed',
    'project-forbidden',
    'project-rate-limited',
    'project-offline',
    'project-malformed',
    'project-protocol-drift',
  ] as const)('disables every private capability for project discovery state %s', errorCode => {
    const status = createStatusView(false, {
      phase: 'failed',
      configured: false,
      projectAvailable: false,
      errorCode,
    })
    expect(status.capabilities).toHaveLength(4)
    expect(status.capabilities.every(capability => (
      capability.state === 'disabled' && capability.reasonCode === 'project-unavailable'
    ))).toBe(true)
    expect(parseStatusResult({ status })).toMatchObject({ capabilities: status.capabilities })
  })

  it('does not infer live capability gates from project discovery alone', () => {
    const login = { phase: 'success' as const, configured: true, projectAvailable: true }
    const pending = createStatusView(true, login)
    expect(pending.capabilities.every(capability => capability.state === 'poc-pending')).toBe(true)
    const gate0Failed = createStatusView(true, login, undefined, undefined, {
      gate0: { outcome: 'failed', checkedAt: '2030-01-01T00:00:00.000Z' },
    })
    expect(gate0Failed.capabilities.every(capability => capability.reasonCode === 'gate-0-failed')).toBe(true)

    const passed = createStatusView(true, login, undefined, undefined, {
      gate0: { outcome: 'passed', checkedAt: '2030-01-01T00:00:00.000Z' },
      llmFamilies: {
        gemini: { outcome: 'passed', checkedAt: '2030-01-01T00:00:00.000Z' },
        claude: { outcome: 'passed', checkedAt: '2030-01-01T00:00:00.000Z' },
        'gpt-oss': { outcome: 'passed', checkedAt: '2030-01-01T00:00:00.000Z' },
      },
      capabilities: {
        search: { outcome: 'rate-limited', checkedAt: '2030-01-01T00:00:00.000Z' },
        image: { outcome: 'protocol-drift', checkedAt: '2030-01-01T00:00:00.000Z' },
        video: { outcome: 'cancelled', checkedAt: '2030-01-01T00:00:00.000Z' },
      },
    })
    expect(passed.capabilities).toEqual([
      { id: 'auth-llm', state: 'available', reasonCode: 'capability-ready' },
      { id: 'search', state: 'disabled', reasonCode: 'rate-limited' },
      { id: 'image', state: 'protocol-drift', reasonCode: 'protocol-drift' },
      { id: 'video', state: 'disabled', reasonCode: 'cancelled' },
    ])
  })

  it('validates closed advisory model-catalog states without private response fields', () => {
    const valid = {
      state: 'live-available',
      checkedAt: '2030-01-01T00:00:00.000Z',
      models: [
        { id: 'antigravity-gemini-3.7-flash', name: 'Gemini 3.7 Flash', state: 'live-available' },
        { id: 'antigravity-claude-sonnet', name: 'Claude Sonnet', state: 'unavailable' },
      ],
    }
    expect(parseModelCatalogResult(valid)).toEqual(valid)
    expect(parseModelCatalogResult({ ...valid, privateBody: 'forbidden-value' })).toBeUndefined()
    expect(parseModelCatalogResult({ ...valid, models: [{ ...valid.models[0], state: 'snapshot' }] })).toBeUndefined()
    expect(parseModelCatalogResult({ state: 'refresh-failed', models: [{ ...valid.models[0], state: 'snapshot' }] })).toEqual({
      state: 'refresh-failed',
      models: [{ ...valid.models[0], state: 'snapshot' }],
    })
  })

  it('validates the browser response as a closed, value-safe quota schema', () => {
    const valid = {
      state: 'available',
      checkedAt: '2030-01-01T00:00:00.000Z',
      groups: [{ group: 'gemini', modelCount: 2, windows: [{ window: '5h', remainingFraction: 0.5, resetTime: '2030-01-02T00:00:00.000Z' }] }],
    }
    expect(parseUsageResult(valid)).toEqual(valid)
    expect(parseUsageResult({ ...valid, leaked: 'value' })).toBeUndefined()
    expect(parseUsageResult({ state: 'available' })).toBeUndefined()
    expect(parseUsageResult({ state: 'available', groups: [{ group: 'gemini', modelCount: 2, windows: [{ window: '5h', remainingFraction: 2, resetTime: '2030-01-02T00:00:00.000Z' }] }] })).toBeUndefined()
  })

  it('validates the browser response as a closed, value-free status schema', () => {
    const valid = {
      status: {
        ...createStatusView(
          false,
          { phase: 'idle', configured: false, projectAvailable: false },
          { state: 're-login-required', configured: true, errorCode: 'invalid-grant' },
          { state: 'failed', errorCode: 'storage' },
        ),
      },
    }
    expect(parseStatusResult(valid)).toMatchObject({ pluginId: 'dsh-antigravity-auth' })
    expect(parseStatusResult({ ...valid, leaked: 'value' })).toBeUndefined()
    expect(parseStatusResult({ ...valid, status: { ...valid.status, login: { ...valid.status.login, authorizationUrl: 'http://evil.test' } } })).toBeUndefined()
    expect(parseStatusResult({ ...valid, status: { ...valid.status, credential: { state: 'logged-in', configured: true, expiresAt: 'access-token' } } })).toBeUndefined()
    expect(parseStatusResult({ ...valid, status: { ...valid.status, revoke: { state: 'failed', errorCode: 'invalid-grant' } } })).toBeUndefined()
  })

  it('keeps callback URLs Host-only and forwards only fixed browser operations', async () => {
    const status = createStatusView(false, { phase: 'idle', configured: false, projectAvailable: false })
    const rpc = {
      call: vi.fn()
        .mockResolvedValueOnce({ ok: true, value: { status } })
        .mockResolvedValueOnce({ ok: true, value: { acknowledged: true } })
        .mockResolvedValueOnce({ ok: true, value: loginFixture() })
        .mockResolvedValueOnce({ ok: true, value: { phase: 'cancelled', errorCode: 'cancelled' } })
        .mockResolvedValueOnce({ ok: true, value: { state: 'logged-out' } })
        .mockResolvedValueOnce({ ok: true, value: { state: 'revoked' } })
        .mockResolvedValueOnce({ ok: true, value: { state: 'snapshot', models: [{ id: 'model', name: 'Model', state: 'snapshot' }] } }),
    }
    const client = createAntigravityAuthRpcClient(rpc)

    await client.status()
    await client.acknowledgeRisk()
    await client.login()
    await client.cancelLogin()
    await client.logout()
    await client.revoke()
    await client.models(undefined, true)

    expect(client).not.toHaveProperty('completeCallback')
    expect(rpc.call.mock.calls.map(call => call.slice(0, 3))).toEqual([
      ['/api', 'antigravity-auth/status', {}],
      ['/api', 'antigravity-auth/acknowledge-risk', { acknowledge: true }],
      ['/api', 'antigravity-auth/login', {}],
      ['/api', 'antigravity-auth/cancel', {}],
      ['/api', 'antigravity-auth/logout', {}],
      ['/api', 'antigravity-auth/revoke', { confirmed: true }],
      ['/api', 'antigravity-auth/models', { force: true }],
    ])
  })

  it('rejects callback URLs at the browser RPC boundary', async () => {
    const service = createBootstrapStatusService()
    const completeCallback = vi.spyOn(service, 'completeCallback')
    const result = await handleAntigravityAuthRpc(service, 'complete-callback', {
      callbackUrl: 'forbidden-value',
    }, signal)

    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(completeCallback).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('rejects authorization URLs carrying callback codes or unknown query fields', async () => {
    const rpc = {
      call: vi.fn(async () => ({
        ok: true as const,
        value: {
          ...loginFixture(),
          authorizationUrl: `${loginFixture().authorizationUrl}&code=forbidden-value`,
        },
      })),
    } as unknown as AntigravityAuthConnectionRpc

    const result = await createAntigravityAuthRpcClient(rpc).login()

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: 'antigravity-auth: invalid login response from Host',
        details: {},
      },
    })
    expect(JSON.stringify(result)).not.toContain('forbidden-value')
  })

  it('sanitizes and validates Host error replies before exposing them to the browser', async () => {
    const rpc = {
      call: vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          error: {
            code: 'internal',
            message: 'forbidden host detail',
            details: { callbackUrl: 'forbidden-value' },
          },
        })
        .mockResolvedValueOnce({
          ok: false,
          error: {
            code: 'internal',
            message: 'forbidden host detail',
            details: {},
          },
        })
        .mockRejectedValueOnce(new Error('forbidden host detail')),
    } as unknown as AntigravityAuthConnectionRpc
    const client = createAntigravityAuthRpcClient(rpc)

    const malformed = await client.status()
    const sanitized = await client.status()
    const rejected = await client.status()

    expect(malformed).toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: 'antigravity-auth: invalid status response from Host',
        details: {},
      },
    })
    expect(sanitized).toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: 'antigravity-auth: operation failed',
        details: {},
      },
    })
    expect(rejected).toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: 'antigravity-auth: invalid status response from Host',
        details: {},
      },
    })
    expect(JSON.stringify([malformed, sanitized, rejected])).not.toMatch(/secret|callbackUrl|access-token/i)
  })
})
