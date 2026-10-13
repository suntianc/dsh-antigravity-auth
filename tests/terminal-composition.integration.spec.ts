import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AntigravityAuthService } from '../src/auth-service.ts'
import { apply as applyAuth } from '../src/index.ts'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

// The opener spawns the platform browser launcher through this module; every
// other child_process export stays real.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: spawnMock }
})

const contexts: Context[] = []
const tempDirs: string[] = []

/** A realistic authorization URL: many `&`-separated parameters and percent-encoded values. */
const SYNTHETIC_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
  + '?client_id=1234567890-abcdef.apps.googleusercontent.com'
  + '&redirect_uri=http%3A%2F%2F127.0.0.1%3A51121%2Foauth2callback'
  + '&response_type=code'
  + '&code_challenge=8Jk2Yr4t1sB_9pQ-abcXYZ'
  + '&code_challenge_method=S256'
  + '&state=af0ifjsldkj-state-value'

afterEach(async () => {
  spawnMock.mockReset()
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose()
  }
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/**
 * Mount a real Cordis composition for the intended terminal profile: real
 * SessionStore + CommandRuntime, the plugin applied, and NO WebServer or
 * `connection` service. Commands dispatch through the real command runtime.
 */
async function mountTerminal(): Promise<{ ctx: Context; agent: Agent }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-antigravity-terminal-'))
  tempDirs.push(root)
  const previousDataHome = process.env.XDG_DATA_HOME
  const previousLocalAppData = process.env.LOCALAPPDATA
  const previousAppData = process.env.APPDATA
  process.env.XDG_DATA_HOME = root
  process.env.LOCALAPPDATA = root
  process.env.APPDATA = root
  const ctx = new Context()
  contexts.push(ctx)
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    applyAuth(ctx)
    await new Promise<void>(resolve => setImmediate(resolve))
    const session = ctx.sessions.create(SessionId('antigravity-auth-terminal'))
    const agent = { id: session.id, session } as unknown as Agent
    return { ctx, agent }
  } finally {
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousDataHome
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previousLocalAppData
    if (previousAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = previousAppData
  }
}

/** Install an opener double whose child reports a successful spawn. */
function stubOpenerSpawn(): { child: EventEmitter & { unref: ReturnType<typeof vi.fn> } } {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  spawnMock.mockImplementation(() => {
    queueMicrotask(() => child.emit('spawn'))
    return child
  })
  return { child }
}

describe('antigravity-auth slash command on a terminal composition (no WebServer/connection)', () => {
  it('dispatches status through the real command runtime to the shared auth service', async () => {
    const { ctx, agent } = await mountTerminal()

    const execution = await ctx.commands.execute(agent, '/antigravity-auth status', [], new AbortController().signal)

    expect(execution?.result.kind).toBe('success')
    if (execution?.result.kind === 'success') {
      expect(execution.result.text).toContain('Antigravity auth:')
      expect(execution.result.text).not.toContain('require a local DSH Host')
    }
  })

  it('dispatches cancel through the real command runtime into the shared auth service', async () => {
    const { ctx, agent } = await mountTerminal()

    const execution = await ctx.commands.execute(agent, '/antigravity-auth cancel', [], new AbortController().signal)

    // No authorization is pending on this fresh store, so the shared service
    // reports the idle phase; the text proves the handler reached the service
    // instead of the composition denial gate.
    expect(execution?.result.kind).toBe('error')
    if (execution?.result.kind === 'error') {
      expect(execution.result.text).toContain('could not be cancelled')
      expect(execution.result.text).not.toContain('require a local DSH Host')
    }
  })

  it('hands the login authorization URL to the opener and keeps it out of the session log', async () => {
    const { ctx, agent } = await mountTerminal()
    const service = (ctx as unknown as { get(name: string): AntigravityAuthService }).get('antigravityAuth')
    vi.spyOn(service, 'startLogin').mockResolvedValue({
      started: true,
      phase: 'pending',
      authorizationUrl: SYNTHETIC_AUTHORIZATION_URL,
      expiresAt: '2026-09-07T09:00:00.000Z',
    })
    const { child } = stubOpenerSpawn()

    const execution = await ctx.commands.execute(agent, '/antigravity-auth login', [], new AbortController().signal)

    expect(execution?.result.kind).toBe('success')
    if (execution?.result.kind === 'success') {
      expect(execution.result.text).not.toContain(SYNTHETIC_AUTHORIZATION_URL)
      expect(execution.result.text).not.toContain('state=')
      expect(execution.result.text).not.toContain('code_challenge')
    }
    // The real opener received the complete URL, including every query parameter.
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0]?.[1]?.join(' ')).toContain(SYNTHETIC_AUTHORIZATION_URL)
    expect(child.unref).toHaveBeenCalledTimes(1)

    // CommandRuntime persists the command lifecycle into the session; neither
    // command/run nor command/done may retain the OAuth state or PKCE challenge.
    const logged = JSON.stringify(agent.session.ownEvents())
    expect(logged).toContain('command/done')
    expect(logged).not.toContain(SYNTHETIC_AUTHORIZATION_URL)
    expect(logged).not.toContain('state=')
    expect(logged).not.toContain('code_challenge')
  })
})
