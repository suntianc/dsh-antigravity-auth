// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createBootstrapStatusService } from '../src/bootstrap-service.ts'
import { AntigravityAuthSettings } from '../src/client/AntigravityAuthSettings.tsx'
import { en } from '../src/client/locales.ts'
import { handleAntigravityAuthRpc } from '../src/rpc.ts'
import { createAntigravityAuthRpcClient } from '../src/rpc-contract.ts'

describe('settings login through the Host RPC contract (issue #43)', () => {
  it.each(['blocked', 'throws'] as const)('keeps the generated login link usable when the browser opener %s', async openerResult => {
    const close = vi.fn(async () => {})
    const listen = vi.fn(async () => ({ close }))
    const fetchImpl = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network is forbidden in this test'))
    let seed = 0
    const service = createBootstrapStatusService({ flowOptions: {
      listenerFactory: { listen },
      fetchImpl,
      // Construct bytes in this realm when combining Host code with jsdom.
      randomBytes: size => new Uint8Array(size).fill(++seed),
    } })
    const rpc = createAntigravityAuthRpcClient({
      call: async (_channel, endpoint, payload, signal) => handleAntigravityAuthRpc(
        service, endpoint.replace('antigravity-auth/', ''), payload, signal,
      ),
    })
    // Exercise the real browser-opening branch, without launching a browser.
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('DSH Desktop test')
    const open = vi.spyOn(window, 'open').mockImplementation(() => {
      if (openerResult === 'throws') throw new Error('Browser opener unavailable')
      return null
    })
    const { unmount } = render(<AntigravityAuthSettings rpc={rpc} t={key => en[key]} subscribe={() => () => {}} />)

    try {
      await waitFor(() => expect(screen.getByRole('button', { name: en.login })).toHaveProperty('disabled', false))
      fireEvent.click(screen.getByRole('button', { name: en.login }))

      const firstLink = await screen.findByRole('link', { name: en.openAuthorization })
      const firstUrl = firstLink.getAttribute('href')!
      expect(new URL(firstUrl).searchParams.get('prompt')).toBe('select_account consent')
      expect(firstLink.getAttribute('target')).toBe('_blank')
      expect(open).toHaveBeenCalledWith(firstUrl, '_blank')
      expect(screen.queryByRole('alert')).toBeNull()
      await expect(rpc.status()).resolves.toMatchObject({
        ok: true, value: { status: { login: { phase: 'pending', authorizationUrl: firstUrl } } },
      })

      fireEvent.click(screen.getByRole('button', { name: en.cancelLogin }))
      await waitFor(() => expect(screen.queryByRole('link', { name: en.openAuthorization })).toBeNull())
      expect(close).toHaveBeenCalledOnce()
      await waitFor(() => expect(screen.getByRole('button', { name: en.login })).toHaveProperty('disabled', false))

      fireEvent.click(screen.getByRole('button', { name: en.login }))
      const secondUrl = (await screen.findByRole('link', { name: en.openAuthorization })).getAttribute('href')!
      expect(secondUrl).not.toBe(firstUrl)
      expect(open).toHaveBeenCalledTimes(2)
      expect(listen).toHaveBeenCalledTimes(2)
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      unmount()
      await service.dispose()
    }
    expect(close).toHaveBeenCalledTimes(2)
  })
})
