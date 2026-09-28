/** Browser contribution registration and cleanup. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import type { AntigravityAuthKey } from '../src/client/locales.ts'
import { createStatusView } from '../src/status.ts'

interface SlotRecord {
  options: Record<string, unknown>
  component: unknown
}

function bench(isLoopback = true) {
  const call = vi.fn().mockResolvedValue({
    ok: true as const,
    value: { status: createStatusView(false, { phase: 'idle', configured: false, projectAvailable: false }) },
  })
  const disposers: Array<() => void> = []
  const dictionaries = new Map<string, { zh: Record<AntigravityAuthKey, string>; en: Record<AntigravityAuthKey, string> }>()
  const slots: SlotRecord[] = []
  const listeners = new Set<() => void>()

  const ctx = {
    locale: {
      register(namespace: string, value: { zh: Record<AntigravityAuthKey, string>; en: Record<AntigravityAuthKey, string> }) {
        dictionaries.set(namespace, value)
        return () => { dictionaries.delete(namespace) }
      },
      bind(namespace: string) {
        return (key: AntigravityAuthKey) => dictionaries.get(namespace)?.en[key] ?? key
      },
    },
    slots: {
      inject(_name: string, register: () => () => void) { disposers.push(register()) },
      register(options: Record<string, unknown>, component: unknown) {
        const record = { options, component }
        slots.push(record)
        return () => {
          const index = slots.indexOf(record)
          if (index >= 0) slots.splice(index, 1)
        }
      },
    },
    get(service: string) {
      if (service === 'connection') return { isLoopback, rpc: { call } }
      throw new Error(`unexpected service: ${service}`)
    },
    configForms: { get: vi.fn(() => ({ getSnapshot: () => ({ status: 'unavailable' }) })) },
    effect(effect: () => () => void) {
      const dispose = effect()
      disposers.push(dispose)
      return dispose
    },
    on(event: string, listener: () => void) {
      if (event !== 'connection/reset') throw new Error(`unexpected event: ${event}`)
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  apply(ctx as unknown as ClientContext)
  return {
    call,
    dictionaries,
    listeners,
    slots,
    dispose: () => { for (const dispose of disposers.reverse()) dispose() },
  }
}

describe('Antigravity client apply', () => {
  it('declares its services and removes dictionaries, slots, and listeners on teardown', async () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'configForms'])
    const b = bench()

    expect(b.slots.map(record => record.options)).toEqual([
      expect.objectContaining({ name: 'settings.section', id: 'antigravity-auth', order: 20 }),
    ])
    const settings = b.slots[0]
    const props = (settings?.options.inject as (() => { rpc: { status: () => Promise<unknown> }; t: (key: AntigravityAuthKey) => string }) | undefined)?.()
    await props?.rpc.status()
    expect(b.call).toHaveBeenCalledWith('/api', 'antigravity-auth/status', {}, undefined)
    expect(props?.t('title')).toBe('Antigravity Auth')

    b.dispose()
    expect(b.slots).toHaveLength(0)
    expect(b.listeners.size).toBe(0)
    expect(b.dictionaries.size).toBe(0)
  })

  it('does not expose account controls to a non-loopback browser connection', () => {
    const b = bench(false)

    expect(b.slots).toHaveLength(0)
    expect(b.listeners.size).toBe(0)
    expect(b.call).not.toHaveBeenCalled()
    expect(b.dictionaries.size).toBe(1)

    b.dispose()
    expect(b.dictionaries.size).toBe(0)
  })
})
