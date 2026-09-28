import { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyAuth } from '../src/index.ts'
import { apply as applyImage } from '../src/image.ts'
import { apply as applySearch } from '../src/search.ts'
import { apply as applyVideo } from '../src/video.ts'
import { createAuthStore, defaultAuthStorePath } from '../src/auth-store.ts'
import { createFileCapabilityGates } from '../src/capability-gates.ts'
import type { AntigravityAuthService } from '../src/auth-service.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function gateStatus(id: 'search' | 'image' | 'video', state: 'available' | 'poc-pending' | 'protocol-drift') {
  return {
    plugin: 'dsh-antigravity-auth',
    mode: 'private-single-account',
    riskAcknowledged: true,
    login: { phase: 'success', configured: true, projectAvailable: true },
    capabilities: [{ id, state, reasonCode: state === 'available' ? 'capability-ready' : state === 'protocol-drift' ? 'protocol-drift' : 'gate-not-run' }],
  }
}

describe('bootstrap lifecycle boundary', () => {
  it('mounts the Host row without OAuth, private transport, timers, or listeners', () => {
    const dispose = vi.fn()
    const handle = vi.fn((_route: ConnectionFetchRoute) => dispose)
    const inject = vi.fn((_dependencies: readonly string[], callback: (ctx: unknown) => unknown) => callback({
      connection: { fetch: { register: handle } },
      commands: { register: () => () => {} },
      get: (service: string) => service === 'webServer' ? { host: '127.0.0.1' } : undefined,
    }))
    const fetch = vi.fn()
    globalThis.fetch = fetch as typeof globalThis.fetch
    const setTimeout = vi.spyOn(globalThis, 'setTimeout')

    applyAuth({ inject } as never)

    expect(fetch).not.toHaveBeenCalled()
    expect(setTimeout).not.toHaveBeenCalled()
    expect(handle).toHaveBeenCalledTimes(9)
    expect(handle.mock.calls[0]).toHaveLength(1)
    expect(handle.mock.calls[0]?.[0].path).toBe('/api/antigravity-auth/status')

    const registration = handle.mock.results[0]?.value as (() => void) | undefined
    registration?.()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('registers only a value-free denial handler on an all-interface Web bind', async () => {
    const dispose = vi.fn()
    const handle = vi.fn((route: ConnectionFetchRoute) => {
      expect(typeof route.fetch).toBe('function')
      return dispose
    })
    const warn = vi.fn()
    const inject = vi.fn((_dependencies: readonly string[], callback: (ctx: unknown) => unknown) => callback({
      connection: { fetch: { register: handle } },
      commands: { register: () => () => {} },
      get: (service: string) => service === 'webServer' ? { host: '0.0.0.0' } : undefined,
      logger: { warn },
    }))

    applyAuth({ inject } as never)

    expect(handle).toHaveBeenCalledTimes(9)
    const route = handle.mock.calls[0]![0]
    const response = await route.fetch(new Request('http://dsh.test' + route.path, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'denied', method: 'antigravity-auth/status', payload: { forbidden: 'value' } }),
    }))
    const body = await response.json() as { result: unknown }
    expect(body.result).toEqual({
      ok: false,
      error: {
        code: 'loopback-required',
        message: 'Antigravity account controls require a loopback-bound DSH Host',
        details: {},
      },
    })
    expect(warn).toHaveBeenCalledOnce()
  })

  it('releases the actual Host RPC registration when a Cordis context is disposed', async () => {
    const dispose = vi.fn()
    const handle = vi.fn((_route: ConnectionFetchRoute) => dispose)
    const ctx = new Context()
    const unprovide = ctx.provide('connection', { fetch: { register: handle } })
    try {
      applyAuth(ctx)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(handle).toHaveBeenCalledTimes(9)
    } finally {
      await ctx.fiber.dispose()
      await unprovide()
    }
    expect(dispose).toHaveBeenCalledTimes(9)
  })

  it('registers the public LLM adapter only while authenticated Gate 0/L evidence passes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-antigravity-lifecycle-'))
    const previousDataHome = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = root
    try {
      const authPath = defaultAuthStorePath()
      const record = await createAuthStore(authPath).commit({ refreshToken: 'refresh', projectId: 'project' })
      const subject = record.lineage!
      const gates = createFileCapabilityGates(join(root, 'dsh-antigravity-auth', 'gates.json'))
      await gates.recordGate0(subject, 'passed')
      await gates.recordLlmFamily(subject, 'gemini', 'passed')
      await gates.recordLlmFamily(subject, 'claude', 'passed')
      await gates.recordLlmFamily(subject, 'gpt-oss', 'passed')

      let provided: AntigravityAuthService | undefined
      let cleanup: (() => Promise<void>) | undefined
      const disposeAdapter = vi.fn()
      const registerAdapter = vi.fn(() => disposeAdapter)
      const runtime = {
        connection: { fetch: { register: vi.fn(() => vi.fn()) } },
        commands: { register: vi.fn(() => vi.fn()) },
        llm: { registerAdapter, listProviders: vi.fn(() => []) },
        provide: vi.fn((_name: string, service: AntigravityAuthService) => { provided = service; return vi.fn(async () => {}) }),
        get: vi.fn((service: string) => service === 'webServer' ? { host: '127.0.0.1' } : undefined),
        inject: vi.fn((_dependencies: readonly string[], callback: (ctx: unknown) => unknown) => callback(runtime)),
        effect: vi.fn((setup: () => () => Promise<void>) => { cleanup = setup() }),
      }

      applyAuth(runtime as never)
      await vi.waitFor(() => expect(registerAdapter).toHaveBeenCalledOnce())

      await provided?.recordLlmFamilyGate('claude', 'protocol-drift')
      await vi.waitFor(() => expect(disposeAdapter).toHaveBeenCalledOnce())
      await cleanup?.()
    } finally {
      if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previousDataHome
      await rm(root, { recursive: true, force: true })
    }
  })

  it('registers the public WebRuntime provider only after Gate S passes and removes it on drift', async () => {
    let statusListener: (() => void) | undefined
    const disposeProvider = vi.fn()
    const registerSearchProvider = vi.fn(() => disposeProvider)
    const auth = {
      credential: vi.fn(),
      status: vi.fn(async () => gateStatus('search', 'poc-pending')),
      watchStatus: vi.fn((listener: () => void) => { statusListener = listener; return vi.fn() }),
      dispose: vi.fn(),
    }
    let cleanup: (() => Promise<void>) | undefined
    const ctx = {
      web: { registerSearchProvider },
      get: vi.fn(() => auth),
      inject: vi.fn(),
      on: vi.fn(() => vi.fn()),
      effect: vi.fn((setup: () => () => Promise<void>) => { cleanup = setup() }),
    }

    applySearch(ctx as never, { enabled: true, model: 'antigravity-gemini-3.7-flash', maxResults: 10 })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(registerSearchProvider).not.toHaveBeenCalled()

    auth.status.mockResolvedValue(gateStatus('search', 'available'))
    statusListener?.()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(registerSearchProvider).toHaveBeenCalledOnce()

    auth.status.mockResolvedValue(gateStatus('search', 'protocol-drift'))
    statusListener?.()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(disposeProvider).toHaveBeenCalledOnce()
    await cleanup?.()
  })

  it('ignores a stale available status that resolves after a newer pending gate read', async () => {
    let statusListener: (() => void) | undefined
    const pending: Array<(value: ReturnType<typeof gateStatus>) => void> = []
    const registerSearchProvider = vi.fn(() => vi.fn())
    const auth = {
      credential: vi.fn(),
      status: vi.fn(() => new Promise<ReturnType<typeof gateStatus>>(resolve => { pending.push(resolve) })),
      watchStatus: vi.fn((listener: () => void) => { statusListener = listener; return vi.fn() }),
      dispose: vi.fn(),
    }
    const ctx = {
      web: { registerSearchProvider },
      get: vi.fn(() => auth),
      inject: vi.fn(),
      on: vi.fn(() => vi.fn()),
      effect: vi.fn((setup: () => () => Promise<void>) => setup()),
    }

    applySearch(ctx as never, { enabled: true, model: 'antigravity-gemini-3.7-flash', maxResults: 10 })
    statusListener?.()
    pending[1]?.(gateStatus('search', 'poc-pending'))
    await new Promise<void>(resolve => setImmediate(resolve))
    pending[0]?.(gateStatus('search', 'available'))
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(registerSearchProvider).not.toHaveBeenCalled()
  })

  it('rolls back partial image ToolRuntime registration when the second tool cannot register', async () => {
    const disposeFirst = vi.fn()
    const register = vi.fn()
      .mockReturnValueOnce(disposeFirst)
      .mockImplementationOnce(() => { throw new Error('registration failed') })
    const auth = {
      credential: vi.fn(),
      status: vi.fn(async () => gateStatus('image', 'available')),
      watchStatus: vi.fn(() => vi.fn()),
      dispose: vi.fn(),
    }
    const ctx = {
      tools: { register },
      attachments: {},
      fs: {},
      get: vi.fn(() => auth),
      inject: vi.fn(),
      on: vi.fn(() => vi.fn()),
      effect: vi.fn((setup: () => () => Promise<void>) => setup()),
    }

    applyImage(ctx as never, { enabled: true, model: 'antigravity-gemini-3.1-flash-image', n: 1 })
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(register).toHaveBeenCalledTimes(2)
    expect(disposeFirst).toHaveBeenCalledOnce()
  })

  it('keeps ToolRuntime video absent while Gate V is pending', async () => {
    const register = vi.fn(() => vi.fn())
    const auth = {
      credential: vi.fn(),
      status: vi.fn(async () => gateStatus('video', 'poc-pending')),
      watchStatus: vi.fn(() => vi.fn()),
      dispose: vi.fn(),
    }
    const ctx = {
      tools: { register },
      fs: {},
      get: vi.fn(() => auth),
      inject: vi.fn(),
      on: vi.fn(() => vi.fn()),
      effect: vi.fn((setup: () => () => Promise<void>) => setup()),
    }

    applyVideo(ctx as never, { enabled: true, model: 'antigravity-gemini-3.7-flash', maxBytes: 1024 })
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(register).not.toHaveBeenCalled()
  })

  it('keeps each later capability row independently mountable and inert', () => {
    const fetch = vi.fn()
    globalThis.fetch = fetch as typeof globalThis.fetch

    expect(() => applySearch()).not.toThrow()
    expect(() => applyImage()).not.toThrow()
    expect(() => applyVideo()).not.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('denies account operations through the slash command on a public Web bind', async () => {
    let registered: CommandDefinition | undefined
    const handle = vi.fn(() => vi.fn())
    const warn = vi.fn()
    const inject = vi.fn((_dependencies: readonly string[], callback: (ctx: unknown) => unknown) => callback({
      connection: { fetch: { register: handle } },
      commands: { register: (definition: unknown) => { registered = definition as CommandDefinition; return () => {} } },
      get: (service: string) => service === 'webServer' ? { host: '0.0.0.0' } : undefined,
      logger: { warn },
    }))

    applyAuth({ inject } as never)
    expect(registered).toBeDefined()
    expect(warn).toHaveBeenCalledOnce()

    await expect(registered!.handler({ rawInput: 'logout' } as never)).resolves.toEqual({
      kind: 'error',
      text: 'Antigravity account commands require a local DSH Host (no WebServer or 127.0.0.1-bound)',
    })
  })

  it('allows the slash command on an explicit loopback bind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-antigravity-loopback-'))
    const previousDataHome = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = root
    try {
      let registered: CommandDefinition | undefined
      const handle = vi.fn(() => vi.fn())
      const warn = vi.fn()
      const inject = vi.fn((_dependencies: readonly string[], callback: (ctx: unknown) => unknown) => callback({
        connection: { fetch: { register: handle } },
        commands: { register: (definition: unknown) => { registered = definition as CommandDefinition; return () => {} } },
        get: (service: string) => service === 'webServer' ? { host: '127.0.0.1' } : undefined,
        logger: { warn },
      }))

      applyAuth({ inject } as never)
      expect(registered).toBeDefined()
      expect(warn).not.toHaveBeenCalled()

      const result = await registered!.handler({ rawInput: 'status' } as never)
      expect(result.kind).toBe('success')
      if (result.kind === 'success') {
        expect(result.text?.startsWith('Antigravity auth:')).toBe(true)
        expect(result.text).not.toContain('require a local DSH Host')
      }
    } finally {
      if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previousDataHome
      await rm(root, { recursive: true, force: true })
    }
  })

  it('allows the slash command on a terminal composition without a WebServer service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-antigravity-terminal-'))
    const previousDataHome = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = root
    const ctx = new Context()
    try {
      let registered: CommandDefinition | undefined
      ctx.provide('connection', { fetch: { register: vi.fn(() => vi.fn()) } })
      ctx.provide('commands', {
        register: (definition: unknown) => { registered = definition as CommandDefinition; return () => {} },
      })
      applyAuth(ctx)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(registered).toBeDefined()

      const result = await registered!.handler({ rawInput: 'status' } as never)
      expect(result.kind).toBe('success')
      if (result.kind === 'success') {
        expect(result.text?.startsWith('Antigravity auth:')).toBe(true)
        expect(result.text).not.toContain('require a local DSH Host')
      }
    } finally {
      if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previousDataHome
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('allows the slash command on a terminal composition without WebServer or connection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-antigravity-terminal-'))
    const previousDataHome = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = root
    const ctx = new Context()
    try {
      let registered: CommandDefinition | undefined
      ctx.provide('commands', {
        register: (definition: unknown) => { registered = definition as CommandDefinition; return () => {} },
      })
      applyAuth(ctx)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(registered).toBeDefined()

      const result = await registered!.handler({ rawInput: 'status' } as never)
      expect(result.kind).toBe('success')
      if (result.kind === 'success') {
        expect(result.text?.startsWith('Antigravity auth:')).toBe(true)
        expect(result.text).not.toContain('require a local DSH Host')
      }
    } finally {
      if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previousDataHome
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
