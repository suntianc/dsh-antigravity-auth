import { describe, expect, it, vi } from 'vitest'
import { Config as ImageConfig, apply as applyImage } from '../src/image.ts'
import { Config as SearchConfig, apply as applySearch } from '../src/search.ts'
import { Config as VideoConfig, apply as applyVideo } from '../src/video.ts'
import { createStatusView } from '../src/status.ts'

function bench(kind: 'search' | 'image' | 'video') {
  const configure = vi.fn(() => vi.fn())
  const listeners = new Map<string, () => void>()
  const registerSearchProvider = vi.fn((_provider: unknown) => vi.fn())
  const auth = {
    credential: vi.fn(),
    status: vi.fn(async () => ({ ...createStatusView(true, {
      phase: 'success', configured: true, projectAvailable: true,
    }), capabilities: [{ id: kind, state: 'available', reasonCode: 'capability-ready' }] })),
    watchStatus: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
  }
  const ctx = {
    ...(kind === 'search' ? { web: { registerSearchProvider } } : {}),
    ...(kind === 'image' ? { tools: { register: vi.fn(() => vi.fn()) }, attachments: {}, fs: {} } : {}),
    ...(kind === 'video' ? { tools: { register: vi.fn(() => vi.fn()) }, fs: {} } : {}),
    fiber: {},
    get: vi.fn(() => auth),
    inject: vi.fn((dependencies: readonly string[], callback: (injected: unknown) => unknown) => {
      if (dependencies.length === 1 && dependencies[0] === 'settings') {
        return callback({ settings: { configure }, effect: (setup: () => unknown) => setup() })
      }
      throw new Error(`unexpected injection: ${dependencies.join(',')}`)
    }),
    on: vi.fn((event: string, callback: () => void) => { listeners.set(event, callback); return vi.fn() }),
    effect: vi.fn((setup: () => unknown) => setup()),
  }
  return { ctx, configure, listeners, registerSearchProvider }
}

describe('Host Config Forms registration', () => {
  it.each([
    { kind: 'search' as const, schema: SearchConfig, apply: applySearch, config: { enabled: true, model: 'antigravity-gemini-3.7-flash', maxResults: 10 } },
    { kind: 'image' as const, schema: ImageConfig, apply: applyImage, config: { enabled: true, model: 'antigravity-gemini-3.1-flash-image', n: 1 } },
    { kind: 'video' as const, schema: VideoConfig, apply: applyVideo, config: { enabled: true, model: 'antigravity-gemini-3.7-flash', maxBytes: 1024 } },
  ])('declares volatile $kind settings and suppresses the automatic form', fixture => {
    const { ctx, configure } = bench(fixture.kind)
    fixture.apply(ctx as never, fixture.config as never)
    expect(configure).toHaveBeenCalledWith({ auto: false }, ctx.fiber)
    const parsed = (fixture.schema as unknown as (input: unknown) => Record<string, { get(): unknown }>)({})
    expect(parsed.enabled?.get()).toBe(true)
  })

  it('reads updated volatile Search settings without replacing its provider', async () => {
    const { ctx, listeners, registerSearchProvider } = bench('search')
    let model = 'initial-model'
    const config = {
      enabled: { get: () => true },
      model: { get: () => model },
      maxResults: { get: () => 10 },
    }
    applySearch(ctx as never, config)
    await new Promise<void>(resolve => setImmediate(resolve))
    const provider = registerSearchProvider.mock.calls[0]?.[0] as unknown as {
      options: { settings?: () => { model: string } }
    }
    expect(provider.options.settings?.().model).toBe('initial-model')
    model = 'replacement-model'
    listeners.get('loader/volatile-update')?.()
    expect(provider.options.settings?.().model).toBe('replacement-model')
  })
})
