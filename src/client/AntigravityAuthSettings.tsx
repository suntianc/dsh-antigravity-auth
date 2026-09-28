/** Settings shell for value-safe Antigravity login status. */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { AntigravityAuthRpcClient } from '../rpc-contract.ts'
import type { QuotaStatusView } from '../quota.ts'
import type { AntigravitySearchSettings } from '../search.ts'
import type { AntigravityImageSettings } from '../image.ts'
import type { AntigravityVideoSettings } from '../video.ts'
import type { RevokeState } from '../credential-coordinator.ts'
import type {
  AntigravityStatusView,
  CapabilityRowId,
  LoginErrorCode,
} from '../status.ts'
import type { AntigravityAuthKey } from './locales.ts'
import { ensureSettingsStyles } from './styles.ts'

export interface AntigravityAuthSettingsProps {
  rpc: AntigravityAuthRpcClient
  t: (key: AntigravityAuthKey) => string
  subscribe: (listener: () => void) => () => void
  searchScope?: ConfigForm<AntigravitySearchSettings>
  imageScope?: ConfigForm<AntigravityImageSettings>
  videoScope?: ConfigForm<AntigravityVideoSettings>
}

type LoadState = 'loading' | 'ready' | 'error'
type BooleanSettings = { readonly enabled: boolean }
type SettingsSnapshot = ConfigFormSnapshot<BooleanSettings>
const EMPTY_SETTINGS_SNAPSHOT: SettingsSnapshot = { status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'memory' }

function useCapabilitySettings<T extends BooleanSettings>(scope: ConfigForm<T> | undefined): SettingsSnapshot & { readonly value: T | undefined } {
  const subscribe = useCallback((listener: () => void) => scope?.subscribe(listener) ?? (() => {}), [scope])
  const getSnapshot = useCallback(() => scope?.getSnapshot() ?? EMPTY_SETTINGS_SNAPSHOT, [scope])
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SETTINGS_SNAPSHOT) as SettingsSnapshot & { readonly value: T | undefined }
}

function useUnmountSignal(): () => AbortSignal {
  const controller = useRef(new AbortController())
  useEffect(() => {
    const active = new AbortController()
    controller.current = active
    return () => active.abort()
  }, [])
  return useCallback(() => controller.current.signal, [])
}

/** One navigable settings section; credentials remain Host-only and actions use typed RPC. */
export function AntigravityAuthSettings({ rpc, t, subscribe, searchScope, imageScope, videoScope }: AntigravityAuthSettingsProps): ReactNode {
  const [status, setStatus] = useState<AntigravityStatusView | null>(null)
  const searchSettings = useCapabilitySettings(searchScope)
  const imageSettings = useCapabilitySettings(imageScope)
  const videoSettings = useCapabilitySettings(videoScope)
  const [quota, setQuota] = useState<QuotaStatusView | null>(null)
  const [quotaBusy, setQuotaBusy] = useState(false)
  const [quotaError, setQuotaError] = useState<string | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [_error, setError] = useState<string | null>(null)
  const [loginBusy, setLoginBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [resetTick, setResetTick] = useState(0)
  const statusGeneration = useRef(0)
  const quotaGeneration = useRef(0)
  const unmountSignal = useUnmountSignal()

  useEffect(() => {
    ensureSettingsStyles()
  }, [])

  useEffect(() => subscribe(() => { setResetTick(value => value + 1) }), [subscribe])

  const load = useCallback(async (signal?: AbortSignal, silent = false) => {
    const generation = ++statusGeneration.current
    if (!silent) {
      setLoadState(prev => (prev === 'ready' ? 'ready' : 'loading'))
      setError(null)
    }
    try {
      const result = await rpc.status(signal)
      if (signal?.aborted === true || generation !== statusGeneration.current) return
      if (!result.ok) {
        setLoadState('error')
        setError(result.error.message || t('statusFailed'))
        return
      }
      setStatus(result.value.status)
      setLoadState('ready')
    } catch (cause) {
      if (signal?.aborted === true || generation !== statusGeneration.current) return
      setLoadState('error')
      setError(messageOf(cause, t('statusFailed')))
    }
  }, [rpc, t])

  const loadQuota = useCallback(async (force = false, signal?: AbortSignal) => {
    if (rpc.usage === undefined) return
    const generation = ++quotaGeneration.current
    setQuotaBusy(true)
    setQuotaError(null)
    try {
      const result = await rpc.usage(signal, force)
      if (signal?.aborted === true || generation !== quotaGeneration.current) return
      if (!result.ok) {
        setQuotaError(result.error.message || t('quotaFailed'))
        return
      }
      setQuota(result.value)
    } catch (cause) {
      if (signal?.aborted === true || generation !== quotaGeneration.current) return
      setQuotaError(messageOf(cause, t('quotaFailed')))
    } finally {
      if (signal?.aborted !== true && generation === quotaGeneration.current) setQuotaBusy(false)
    }
  }, [rpc, t])

  useEffect(() => {
    if (status?.login.projectAvailable !== true || rpc.usage === undefined) {
      setQuota(null)
      return
    }
    const controller = new AbortController()
    void loadQuota(false, controller.signal)
    return () => controller.abort()
  }, [loadQuota, rpc.usage, status?.login.projectAvailable, resetTick])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, resetTick])

  useEffect(() => {
    if (status?.login.phase !== 'pending') return
    const controller = new AbortController()
    const timer = globalThis.setInterval(() => { void load(controller.signal, true) }, 1_000)
    return () => {
      globalThis.clearInterval(timer)
      controller.abort()
    }
  }, [load, status?.login.phase])

  const startLogin = useCallback(async () => {
    const signal = unmountSignal()
    setLoginBusy(true)
    setError(null)
    try {
      if (status?.riskAcknowledged !== true) {
        await rpc.acknowledgeRisk(signal)
      }
      const result = await rpc.login(signal)
      if (signal.aborted) return
      if (!result.ok) {
        setError(result.error.message || t('loginFailed'))
        await load(signal)
        return
      }
      setStatus(previous => {
        if (previous === null) return previous
        const { errorCode: _ignoredErrorCode, ...login } = previous.login
        return {
          ...previous,
          riskAcknowledged: true,
          login: {
            ...login,
            phase: 'pending',
            authorizationUrl: result.value.authorizationUrl,
            expiresAt: result.value.expiresAt,
          },
        }
      })
    } catch (cause) {
      if (!signal.aborted) setError(messageOf(cause, t('loginFailed')))
    } finally {
      if (!signal.aborted) setLoginBusy(false)
    }
  }, [load, rpc, status?.riskAcknowledged, t, unmountSignal])

  const cancelLogin = useCallback(async () => {
    const signal = unmountSignal()
    setLoginBusy(true)
    setError(null)
    try {
      const result = await rpc.cancelLogin(signal)
      if (signal.aborted) return
      if (!result.ok) {
        setError(result.error.message || t('cancelLoginFailed'))
        return
      }
      setStatus(previous => {
        if (previous === null) return previous
        const { errorCode: _ignoredErrorCode, ...login } = previous.login
        return {
          ...previous,
          login: result.value.errorCode === undefined
            ? { ...login, phase: result.value.phase }
            : { ...login, phase: result.value.phase, errorCode: result.value.errorCode },
        }
      })
    } catch (cause) {
      if (!signal.aborted) setError(messageOf(cause, t('cancelLoginFailed')))
    } finally {
      if (!signal.aborted) setLoginBusy(false)
    }
  }, [rpc, t, unmountSignal])

  const logout = useCallback(async () => {
    const signal = unmountSignal()
    setActionBusy(true)
    setError(null)
    try {
      const result = await rpc.logout(signal)
      if (signal.aborted) return
      if (!result.ok) {
        setError(result.error.message || t('logoutFailed'))
        return
      }
      await load(signal)
    } catch (cause) {
      if (!signal.aborted) setError(messageOf(cause, t('logoutFailed')))
    } finally {
      if (!signal.aborted) setActionBusy(false)
    }
  }, [load, rpc, t, unmountSignal])

  const projectError = projectErrorText(status?.login.errorCode, t)
  const isConfigured = status?.login.configured === true

  return (
    <section className="agy-settings" data-plugin="dsh-antigravity-auth" aria-labelledby="antigravity-auth-title">
      <header className="agy-bundle-header">
        <div>
          <div className="agy-title-line">
            <h1 id="antigravity-auth-title" className="agy-bundle-title">{t('title')}</h1>
            {isConfigured ? (
              <span className="agy-status-dot" role="status" aria-label={t('ready')} />
            ) : null}
          </div>
          <p className="agy-bundle-intro">{t('intro')}</p>
        </div>
      </header>

      <div className="agy-cards">
        {/* Card 1: Auth & Quota */}
        <article className="agy-card" aria-labelledby="antigravity-auth-card-title">
          <div className="agy-card-header">
            <div className="agy-card-identity">
              <h2 id="antigravity-auth-card-title" className="agy-card-title">{t('authCardTitle')}</h2>
              <p className="agy-card-intro">{t('authCardIntro')}</p>
            </div>
          </div>

          <QuotaVisualDashboard
            quota={quota}
            busy={quotaBusy}
            error={quotaError}
            onRefresh={() => { void loadQuota(true, unmountSignal()) }}
            t={t}
          />

          <div className="agy-action-row">
            {status?.login.phase === 'pending' && typeof status.login.authorizationUrl === 'string' ? (
              <>
                <a className="agy-btn agy-btn-primary" href={status.login.authorizationUrl} target="_blank" rel="noreferrer">
                  {t('openAuthorization')}
                </a>
                <button className="agy-btn agy-btn-outline" type="button" disabled={loginBusy} onClick={() => { void cancelLogin() }}>
                  {t('cancelLogin')}
                </button>
              </>
            ) : (
              <button className="agy-btn agy-btn-primary" type="button" disabled={status === null || loginBusy} onClick={() => { void startLogin() }}>
                {loginBusy ? t('startingLogin') : isConfigured ? t('relogin') : t('login')}
              </button>
            )}

            {status?.credential?.configured ? (
              <button className="agy-btn agy-btn-outline" type="button" disabled={actionBusy} onClick={() => { void logout() }}>
                {t('logout')}
              </button>
            ) : null}

            <button
              className="agy-btn agy-btn-ghost agy-refresh-btn"
              type="button"
              disabled={loadState === 'loading' || quotaBusy}
              onClick={() => {
                const minDelay = new Promise(resolve => setTimeout(resolve, 500))
                void Promise.all([load(unmountSignal()), loadQuota(true, unmountSignal()), minDelay])
              }}
            >
              <span className={quotaBusy || loadState === 'loading' ? 'agy-spin-icon' : ''}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>
              </span>
              {quotaBusy || loadState === 'loading' ? t('queryingQuota') : t('refreshStatus')}
            </button>
          </div>
          <p className="agy-footer-notice">{t('quotaFooterNotice')}</p>

          {status?.login.phase === 'expired' ? <p className="agy-alert" role="alert">{t('loginExpired')}</p> : null}
          {status?.login.phase === 'port-conflict' ? <p className="agy-alert" role="alert">{t('loginPortConflict')}</p> : null}
          {status?.login.phase === 'failed' ? <p className="agy-alert" role="alert">{t('loginFailed')}</p> : null}
          {projectError === undefined ? null : <p className="agy-alert" role="alert">{projectError}</p>}
          {status?.login.phase === 'pending' && status.login.expiresAt !== undefined ? (
            <p className="agy-card-subtext">{t('expiresAt')}: <time dateTime={status.login.expiresAt}>{status.login.expiresAt}</time></p>
          ) : null}
          {status?.revoke === undefined || status.revoke.state === 'idle' ? null : (
            <p className="agy-card-subtext" role="status">{revokeStatusText(status.revoke.state, t)}</p>
          )}
        </article>

        {/* Card 2: Web Search */}
        <article className="agy-card">
          <div className="agy-card-header">
            <div className="agy-card-identity">
              <h2 className="agy-card-title">{t('search')}</h2>
              <p className="agy-card-intro">{t('searchCardIntro')}</p>
            </div>
            <div className="agy-card-action">
              <Switch
                label={t('toggleSearch')}
                checked={searchSettings.value?.enabled ?? false}
                disabled={!capabilityAvailable(status, 'search') || searchSettings.status !== 'ready' || !searchSettings.writable}
                onChange={next => { void searchScope?.set('enabled', next) }}
              />
            </div>
          </div>
        </article>

        {/* Card 3: Image Creation */}
        <article className="agy-card">
          <div className="agy-card-header">
            <div className="agy-card-identity">
              <h2 className="agy-card-title">{t('image')}</h2>
              <p className="agy-card-intro">{t('imageCardIntro')}</p>
            </div>
            <div className="agy-card-action">
              <Switch
                label={t('toggleImage')}
                checked={imageSettings.value?.enabled ?? false}
                disabled={!capabilityAvailable(status, 'image') || imageSettings.status !== 'ready' || !imageSettings.writable}
                onChange={next => { void imageScope?.set('enabled', next) }}
              />
            </div>
          </div>
        </article>

        {/* Card 4: Video Analysis */}
        <article className="agy-card">
          <div className="agy-card-header">
            <div className="agy-card-identity">
              <h2 className="agy-card-title">{t('video')}</h2>
              <p className="agy-card-intro">{t('videoCardIntro')}</p>
            </div>
            <div className="agy-card-action">
              <Switch
                label={t('toggleVideo')}
                checked={videoSettings.value?.enabled ?? false}
                disabled={!capabilityAvailable(status, 'video') || videoSettings.status !== 'ready' || !videoSettings.writable}
                onChange={next => { void videoScope?.set('enabled', next) }}
              />
            </div>
          </div>
        </article>
      </div>
    </section>
  )
}

function capabilityAvailable(status: AntigravityStatusView | null, id: CapabilityRowId): boolean {
  return status?.login.projectAvailable === true && status.capabilities.some(capability => capability.id === id && capability.state === 'available')
}

function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  readonly label: string
  readonly checked: boolean
  readonly disabled?: boolean
  readonly onChange: (checked: boolean) => void
}): ReactNode {
  return (
    <label className="agy-switch">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={e => { onChange(e.target.checked) }}
      />
      <span className="agy-switch-slider" />
    </label>
  )
}

function formatRefreshTime(resetTime: string, dayUnit: string, now = Date.now()): string {
  const target = new Date(resetTime).getTime()
  if (Number.isNaN(target)) return resetTime
  const diffMs = target - now
  if (diffMs <= 0) return '0m'
  const diffMinutes = Math.floor(diffMs / (60 * 1000))
  const hours = Math.floor(diffMinutes / 60)
  const remMinutes = diffMinutes % 60

  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    return `${days}${dayUnit} ${hours % 24}h ${remMinutes}m`
  }
  if (hours > 0) {
    return `${hours}h ${remMinutes}m`
  }
  return `${remMinutes}m`
}

function quotaTone(fraction: number): 'normal' | 'warning' | 'error' {
  if (fraction < 0.3) return 'error'
  if (fraction <= 0.6) return 'warning'
  return 'normal'
}

function QuotaVisualDashboard({
  quota,
  busy,
  error,
  t,
}: {
  readonly quota: QuotaStatusView | null
  readonly busy?: boolean
  readonly error: string | null
  readonly onRefresh?: () => void
  readonly t: AntigravityAuthSettingsProps['t']
}): ReactNode {
  return (
    <div className="agy-quota-section">
      {quota?.state === 'available' && quota.groups !== undefined && quota.groups.length > 0 ? (
        <div className="agy-quota-groups">
          {quota.groups.map(group => {
            const groupTitle = group.group === 'gemini' ? t('geminiGroupTitle') : t('claudeGptGroupTitle')
            const groupDesc = group.group === 'gemini' ? t('geminiGroupDesc') : t('claudeGptGroupDesc')
            return (
              <div key={group.group} className="agy-quota-group">
                <div className="agy-quota-group-header">
                  <span className="agy-quota-group-title">{groupTitle}</span>
                  <span className="agy-quota-group-desc">{groupDesc}</span>
                </div>
                <div className="agy-quota-buckets">
                  {group.windows.map(window => {
                    const windowName = window.window === '5h' ? t('window5hTitle') : t('windowWeeklyTitle')
                    const pctFormatted = (window.remainingFraction * 100).toFixed(2) + '%'
                    const pctRounded = Math.round(window.remainingFraction * 100)
                    const refreshStr = formatRefreshTime(window.resetTime, t('quotaDayUnit'))
                    const subtext = `${pctRounded}% ${t('remaining')} · ${t('refreshesIn').replace('{time}', refreshStr)}`
                    const widthPct = Math.max(0, Math.min(100, window.remainingFraction * 100))
                    const tone = quotaTone(window.remainingFraction)

                    return (
                      <div key={window.window} className="agy-quota-bucket">
                        <div className="agy-quota-bucket-head">
                          <span className="agy-quota-bucket-name">{windowName}</span>
                          {busy ? (
                            <span className="agy-quota-querying">
                              <span className="agy-querying-spinner" aria-hidden="true" />
                              <span>{t('queryingQuota')}</span>
                            </span>
                          ) : (
                            <span className="agy-quota-bucket-val" data-tone={tone}>{pctFormatted}</span>
                          )}
                        </div>
                        <div className="agy-progress-track">
                          {busy ? (
                            <div className="agy-shimmer-track" aria-hidden="true" />
                          ) : (
                            <div className="agy-progress-bar" data-tone={tone} style={{ width: `${widthPct}%` }} />
                          )}
                        </div>
                        <span className="agy-quota-subtext">{subtext}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
      {error === null ? null : <p className="agy-alert" role="alert">{error}</p>}
    </div>
  )
}

const PROJECT_ERROR_KEYS: Readonly<Partial<Record<LoginErrorCode, AntigravityAuthKey>>> = {
  'project-unavailable': 'projectUnavailable',
  'project-authentication-failed': 'projectAuthenticationFailed',
  'project-forbidden': 'projectForbidden',
  'project-rate-limited': 'projectRateLimited',
  'project-offline': 'projectOffline',
  'project-malformed': 'projectMalformed',
  'project-protocol-drift': 'projectProtocolDrift',
}
const REVOKE_STATE_KEYS: Readonly<Record<RevokeState, AntigravityAuthKey>> = {
  idle: 'credentialLoggedOut',
  'logged-out': 'credentialLoggedOut',
  pending: 'revokePending',
  revoked: 'revokeSuccess',
  failed: 'revokeFailed',
  superseded: 'revokeSuperseded',
  'confirmation-required': 'revokeConfirmationRequired',
}

function projectErrorText(errorCode: LoginErrorCode | undefined, t: AntigravityAuthSettingsProps['t']): string | undefined {
  if (errorCode === undefined) return undefined
  const key = PROJECT_ERROR_KEYS[errorCode]
  return key === undefined ? undefined : t(key)
}

function revokeStatusText(state: RevokeState, t: AntigravityAuthSettingsProps['t']): string {
  return t(REVOKE_STATE_KEYS[state])
}

function messageOf(_error: unknown, fallback: string): string {
  return fallback
}
