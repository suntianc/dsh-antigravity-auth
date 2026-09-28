// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AntigravityAuthSettings } from '../src/client/AntigravityAuthSettings.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { AntigravityAuthRpcClient } from '../src/rpc-contract.ts'
import type { AntigravitySearchSettings } from '../src/search.ts'
import { createStatusView } from '../src/status.ts'
import type { LoginStatusView } from '../src/status.ts'
import type { CredentialStatusView, RevokeStatusView } from '../src/credential-coordinator.ts'

function rpcFixture(
  login: LoginStatusView = { phase: 'idle', configured: false, projectAvailable: false },
  riskAcknowledged = false,
  credential?: CredentialStatusView,
  revoke?: RevokeStatusView,
): AntigravityAuthRpcClient {
  const status = createStatusView(riskAcknowledged, login, credential, revoke)
  return {
    status: vi.fn().mockResolvedValue({ ok: true, value: { status } }),
    acknowledgeRisk: vi.fn().mockResolvedValue({ ok: true, value: { acknowledged: true } }),
    login: vi.fn().mockResolvedValue({ ok: true, value: {
      started: true,
      phase: 'pending',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=abcdefghijklmnopqrstuvwxyz123456',
      expiresAt: '2026-08-21T00:00:00.000Z',
    } }),
    cancelLogin: vi.fn().mockResolvedValue({ ok: true, value: { phase: 'cancelled', errorCode: 'cancelled' } }),
    logout: vi.fn().mockResolvedValue({ ok: true, value: { state: 'logged-out' } }),
    revoke: vi.fn().mockResolvedValue({ ok: true, value: { state: 'revoked' } }),
    models: vi.fn().mockResolvedValue({ ok: true, value: {
      state: 'snapshot',
      models: [{ id: 'antigravity-gemini-3.7-flash', name: 'Gemini 3.7 Flash', state: 'snapshot' }],
    } }),
    usage: vi.fn().mockResolvedValue({ ok: true, value: { state: 'unknown' } }),
  }
}

class ReceiverBoundSettingsScope<T> implements ConfigForm<T> {
  private readonly listeners = new Set<() => void>()
  private readonly snapshot: ConfigFormSnapshot<T>

  constructor(value: T) {
    this.snapshot = {
      status: 'ready',
      value,
      base: value,
      user: undefined,
      revision: 1,
      writable: true,
      mode: 'host',
    }
  }

  getSnapshot(): ConfigFormSnapshot<T> {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async mutate(): Promise<boolean> { return true }
  async set(): Promise<boolean> { return true }
  async unset(): Promise<boolean> { return true }
}

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('Antigravity bootstrap settings', () => {
  it('renders settings shell without secret controls and starts login directly', async () => {
    const rpc = rpcFixture()
    const unsubscribe = vi.fn()
    const { unmount } = render(
      <AntigravityAuthSettings rpc={rpc} t={key => en[key]} subscribe={() => unsubscribe} />,
    )

    expect(await screen.findByRole('heading', { name: en.title })).toBeTruthy()
    expect(screen.queryByLabelText(/token|client secret|endpoint/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /add|switch|rotate/i })).toBeNull()
    expect(screen.getByRole('button', { name: en.login })).toHaveProperty('disabled', false)

    fireEvent.click(screen.getByRole('button', { name: en.login }))
    await waitFor(() => expect(rpc.login).toHaveBeenCalledOnce())
    expect(screen.getByRole('link', { name: en.openAuthorization }).getAttribute('target')).toBe('_blank')
    expect(screen.getByRole('button', { name: en.cancelLogin })).toBeTruthy()

    unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('preserves the receiver when React subscribes to a Host SettingsScope', async () => {
    const searchScope = new ReceiverBoundSettingsScope<AntigravitySearchSettings>({
      enabled: false,
      model: 'antigravity-gemini-3.7-flash',
      maxResults: 10,
    })

    render(
      <AntigravityAuthSettings
        rpc={rpcFixture()}
        t={key => en[key]}
        subscribe={() => () => {}}
        searchScope={searchScope}
      />,
    )

    expect(await screen.findByRole('heading', { name: en.title })).toBeTruthy()
  })

  it('renders Host-only logout controls', async () => {
    const rpc = rpcFixture(
      { phase: 'success', configured: true, projectAvailable: true, maskedEmail: 'a***@example.com' },
      true,
      { state: 'logged-in', configured: true },
      { state: 'idle' },
    )
    render(<AntigravityAuthSettings rpc={rpc} t={key => en[key]} subscribe={() => () => {}} />)

    expect(await screen.findByRole('button', { name: en.logout })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.logout }))
    await waitFor(() => expect(rpc.logout).toHaveBeenCalledOnce())
  })

  it('shows quota dashboard with groups and windows', async () => {
    const rpc = rpcFixture(
      { phase: 'success', configured: true, projectAvailable: true },
      true,
      { state: 'logged-in', configured: true },
      { state: 'idle' },
    )
    vi.mocked(rpc.usage!).mockResolvedValue({
      ok: true,
      value: {
        state: 'available',
        groups: [
          {
            group: 'gemini',
            modelCount: 2,
            windows: [
              { window: '5h', remainingFraction: 0.85, resetTime: '2030-01-01T00:00:00.000Z' },
              { window: 'weekly', remainingFraction: 0.95, resetTime: '2030-01-07T00:00:00.000Z' },
            ],
          },
        ],
      },
    })

    render(<AntigravityAuthSettings rpc={rpc} t={key => en[key]} subscribe={() => () => {}} />)

    expect(await screen.findByRole('heading', { name: en.authCardTitle })).toBeTruthy()
    expect(await screen.findByText('GEMINI MODELS')).toBeTruthy()
    expect(screen.getByText('85.00%')).toBeTruthy()
  })

  describe.each([
    { language: 'English', copy: en, dayUnit: 'd', resetPrefix: 'Refreshes in ', resetSuffix: '' },
    { language: 'Chinese', copy: zh, dayUnit: '天', resetPrefix: '', resetSuffix: ' 后刷新' },
  ])('$language quota reset countdown', ({ copy, dayUnit, resetPrefix, resetSuffix }) => {
    it.each([
      { minutes: 94 * 60 + 43, expected: `3${dayUnit} 22h 43m` },
      { minutes: 48 * 60, expected: `2${dayUnit} 0h 0m` },
      { minutes: 24 * 60, expected: `1${dayUnit} 0h 0m` },
      { minutes: 24 * 60 - 1, expected: '23h 59m' },
      { minutes: 60, expected: '1h 0m' },
      { minutes: 43, expected: '43m' },
      { minutes: 0.5, expected: '0m' },
      { minutes: 0, expected: '0m' },
      { minutes: -1, expected: '0m' },
    ])('renders $minutes remaining minutes as $expected', async ({ minutes, expected }) => {
      const now = Date.parse('2026-09-10T00:00:00.000Z')
      vi.spyOn(Date, 'now').mockReturnValue(now)
      const rpc = rpcFixture(
        { phase: 'success', configured: true, projectAvailable: true },
        true,
        { state: 'logged-in', configured: true },
      )
      vi.mocked(rpc.usage!).mockResolvedValue({
        ok: true,
        value: {
          state: 'available',
          groups: [{
            group: 'gemini',
            modelCount: 2,
            windows: [
              { window: 'weekly', remainingFraction: 0.22, resetTime: new Date(now + minutes * 60_000).toISOString() },
              { window: '5h', remainingFraction: 0.85, resetTime: new Date(now + 5 * 60 * 60_000).toISOString() },
            ],
          }],
        },
      })

      render(<AntigravityAuthSettings rpc={rpc} t={key => copy[key]} subscribe={() => () => {}} />)

      expect(await screen.findByText(`22% ${copy.remaining} · ${resetPrefix}${expected}${resetSuffix}`)).toBeTruthy()
      expect(screen.getByText(`85% ${copy.remaining} · ${resetPrefix}5h 0m${resetSuffix}`)).toBeTruthy()
    })
  })

  it('renders the same status shell with Chinese copy', async () => {
    const rpc = rpcFixture()
    render(<AntigravityAuthSettings rpc={rpc} t={key => zh[key]} subscribe={() => () => {}} />)

    expect(await screen.findByRole('heading', { name: zh.title })).toBeTruthy()
  })

  it('translates descriptions, status, and capability controls when the language changes', async () => {
    const rpc = rpcFixture(
      { phase: 'success', configured: true, projectAvailable: true },
      true,
      { state: 'logged-in', configured: true },
    )
    const subscribe = () => () => {}
    const { container, rerender } = render(
      <AntigravityAuthSettings rpc={rpc} t={key => en[key]} subscribe={subscribe} />,
    )

    expect(await screen.findByRole('status', { name: 'Ready' })).toBeTruthy()
    expect(screen.getByText(en.intro)).toBeTruthy()
    for (const key of ['authCardIntro', 'searchCardIntro', 'imageCardIntro', 'videoCardIntro'] as const) {
      expect(screen.getByText(en[key])).toBeTruthy()
    }
    for (const key of ['toggleSearch', 'toggleImage', 'toggleVideo'] as const) {
      expect(screen.getByRole('checkbox', { name: en[key] })).toBeTruthy()
    }
    expect(container.textContent).not.toMatch(/\p{Script=Han}/u)

    rerender(<AntigravityAuthSettings rpc={rpc} t={key => zh[key]} subscribe={subscribe} />)

    expect(await screen.findByRole('status', { name: '就绪' })).toBeTruthy()
    expect(screen.queryByRole('status', { name: 'Ready' })).toBeNull()
    expect(screen.queryByText(en.intro)).toBeNull()
    expect(screen.getByText(zh.intro)).toBeTruthy()
    for (const key of ['authCardIntro', 'searchCardIntro', 'imageCardIntro', 'videoCardIntro'] as const) {
      expect(screen.getByText(zh[key])).toBeTruthy()
    }
    for (const key of ['toggleSearch', 'toggleImage', 'toggleVideo'] as const) {
      expect(screen.getByRole('checkbox', { name: zh[key] })).toBeTruthy()
    }
  })

  it('keeps complete bilingual dictionaries without Chinese text in English copy', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    expect(Object.entries(en).filter(([, value]) => /\p{Script=Han}/u.test(value))).toEqual([])
    expect([...Object.values(en), ...Object.values(zh)].every(value => value.trim().length > 0)).toBe(true)
  })

  it('renders safe pending, success, cancelled, expired, port-conflict, and failure states', async () => {
    const cases = [
      ['pending', { phase: 'pending', configured: false, projectAvailable: false, authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${'a'.repeat(43)}`, expiresAt: '2026-08-21T00:00:00.000Z' }, en.openAuthorization],
      ['success', { phase: 'success', configured: true, projectAvailable: true, maskedEmail: 'a***@example.com' }, en.relogin],
      ['cancelled', { phase: 'cancelled', configured: false, projectAvailable: false, errorCode: 'cancelled' }, en.login],
      ['expired', { phase: 'expired', configured: false, projectAvailable: false, errorCode: 'expired' }, en.loginExpired],
      ['port-conflict', { phase: 'port-conflict', configured: false, projectAvailable: false, errorCode: 'port-conflict' }, en.loginPortConflict],
      ['failed', { phase: 'failed', configured: false, projectAvailable: false, errorCode: 'project-unavailable' }, en.loginFailed],
    ] as const
    for (const [_name, login, copy] of cases) {
      const { unmount } = render(<AntigravityAuthSettings rpc={rpcFixture(login, true)} t={key => en[key]} subscribe={() => () => {}} />)
      expect((await screen.findAllByText(copy)).length).toBeGreaterThan(0)
      unmount()
      document.body.innerHTML = ''
    }
  })

  it.each([
    ['project-authentication-failed', en.projectAuthenticationFailed],
    ['project-forbidden', en.projectForbidden],
    ['project-rate-limited', en.projectRateLimited],
    ['project-offline', en.projectOffline],
    ['project-malformed', en.projectMalformed],
    ['project-protocol-drift', en.projectProtocolDrift],
  ] as const)('renders a safe project discovery state for %s', async (errorCode, copy) => {
    const { unmount } = render(
      <AntigravityAuthSettings
        rpc={rpcFixture({ phase: 'failed', configured: false, projectAvailable: false, errorCode }, true)}
        t={key => en[key]}
        subscribe={() => () => {}}
      />,
    )
    expect(await screen.findByText(copy)).toBeTruthy()
    unmount()
    document.body.innerHTML = ''
  })

  it('polls Host status while pending so callback completion reaches the settings UI', async () => {
    vi.useFakeTimers()
    const pending: LoginStatusView = {
      phase: 'pending',
      configured: false,
      projectAvailable: false,
      authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${'a'.repeat(43)}`,
      expiresAt: '2026-08-21T00:00:00.000Z',
    }
    const completed: LoginStatusView = { phase: 'success', configured: true, projectAvailable: true, maskedEmail: 'a***@example.com' }
    const base = rpcFixture(pending, true)
    const status = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { status: createStatusView(true, pending) } })
      .mockResolvedValueOnce({ ok: true, value: { status: createStatusView(true, completed) } })
    const rpc = { ...base, status: status as typeof base.status }
    const { unmount } = render(<AntigravityAuthSettings rpc={rpc} t={key => en[key]} subscribe={() => () => {}} />)

    await vi.waitFor(() => expect(status).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2))
    expect(screen.getByText(en.relogin)).toBeTruthy()
    unmount()
    vi.useRealTimers()
  })

  it('aborts an in-flight status read and unsubscribes on unmount', async () => {
    let signal: AbortSignal | undefined
    const status = vi.fn((_candidate?: AbortSignal) => {
      signal = _candidate
      return new Promise<never>(() => {})
    })
    const unsubscribe = vi.fn()
    const { unmount } = render(
      <AntigravityAuthSettings
        rpc={{ status, acknowledgeRisk: vi.fn(), login: vi.fn() } as unknown as AntigravityAuthRpcClient}
        t={key => en[key]}
        subscribe={() => unsubscribe}
      />,
    )

    await waitFor(() => expect(signal).toBeDefined())
    unmount()
    expect(signal?.aborted).toBe(true)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('passes an unmount-scoped signal to pending browser actions', async () => {
    let actionSignal: AbortSignal | undefined
    const rpc = rpcFixture()
    rpc.login = vi.fn((_signal?: AbortSignal) => {
      actionSignal = _signal
      return new Promise<never>(() => {})
    })
    const { unmount } = render(
      <AntigravityAuthSettings rpc={rpc} t={key => en[key]} subscribe={() => () => {}} />,
    )

    await screen.findByRole('heading', { name: en.title })
    fireEvent.click(screen.getByRole('button', { name: en.login }))
    await waitFor(() => expect(actionSignal).toBeDefined())

    unmount()
    expect(actionSignal?.aborted).toBe(true)
  })
})
