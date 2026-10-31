import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { expect, it, vi } from 'vitest'
import { registerAccountRoutes } from '../src/account-routes.ts'
import { createLoopbackRpcGuard } from '../src/loopback-rpc.ts'

it('passes the peer admitted for each account request and refuses a rejected admission', async () => {
  const peer = { id: 'request-owner' }
  let admission: { peer: typeof peer } | { rejection: 401 | 403 } = { peer }
  const admit = vi.fn(() => admission)
  let route: ((request: Request) => Promise<Response>) | undefined
  const connection = {
    admit,
    fetch: { register: (value: { fetch: (request: Request) => Promise<Response> }) => {
      route = value.fetch
      return async () => {}
    } },
  } as unknown as HostConnectionHandle
  const handler = vi.fn(async () => ({ ok: true as const, value: { configured: false } }))
  const dispose = registerAccountRoutes(connection, 'antigravity-auth', ['status'], handler)
  const makeRequest = () => new Request('http://127.0.0.1/api/antigravity-auth/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'status-test', method: 'antigravity-auth/status', payload: {} }),
  })
  if (route === undefined) throw new Error('account route was not registered')

  const request = makeRequest()
  expect((await route(request)).status).toBe(200)
  expect(admit).toHaveBeenCalledWith(request)
  expect(handler).toHaveBeenCalledWith('status', {}, request.signal, peer)

  admission = { rejection: 401 }
  expect((await route(makeRequest())).status).toBe(401)
  expect(handler).toHaveBeenCalledOnce()
  await dispose()
})

it('serves authenticated account RPC on the real Connection Host and disposes its routes', async () => {
  const ctx = new Context()
  const delegate = vi.fn(async () => ({ ok: true as const, value: { configured: false } }))
  try {
    ctx.provide('credentials', {
      modifyRecord: async (_key: unknown, update: (current: undefined) => Promise<CredentialRecord>) => update(undefined),
    } as unknown as CredentialProvider)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(Connection)
    const baseUrl = 'http://127.0.0.1:' + String(ctx.webServer.port)
    const headers = new Map<string, string>()
    ctx.connection.authorizeIndex({
      method: 'GET', url: ctx.connection.authenticatedUrl(baseUrl), headers: { host: new URL(baseUrl).host },
    }, {
      writeHead: (_status, values) => { for (const [key, value] of Object.entries(values ?? {})) headers.set(key.toLowerCase(), value) },
      end: () => undefined,
    })
    const cookie = headers.get('set-cookie')?.split(';', 1)[0]
    expect(cookie).toBeDefined()
    const namespace = 'antigravity-auth'
    const channel = '/api/' + namespace
    const dispose = registerAccountRoutes(ctx.connection, namespace, ['status'], createLoopbackRpcGuard('127.0.0.1', delegate).handler)
    const send = (body: unknown, authenticated = true, contentType = 'application/json', origin?: string) => fetch(baseUrl + channel + '/status', {
      method: 'POST', headers: { 'content-type': contentType, ...(authenticated ? { cookie: cookie! } : {}), ...(origin ? { origin } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    const envelope = { type: 'client-request', rpcId: 'account-status-test', method: namespace + '/status', payload: {} }
    expect((await send(envelope, false)).status).toBe(401)
    expect((await send(envelope, true, 'application/json', 'https://untrusted.example')).status).toBe(403)
    expect(delegate).not.toHaveBeenCalled()
    const response = await send(envelope)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { configured: false } } })
    expect(delegate).toHaveBeenCalledTimes(1)
    const admission = ctx.connection.admit({ headers: { host: new URL(baseUrl).host, cookie: cookie! } })
    if ('rejection' in admission) throw new Error('test browser was not admitted')
    expect(delegate).toHaveBeenCalledWith('status', {}, expect.any(AbortSignal), admission.peer)
    expect((await send('{')).status).toBe(400)
    expect((await send(envelope, true, 'text/plain')).status).toBe(415)
    const mismatch = await send({ ...envelope, method: 'login' })
    expect((await mismatch.json() as { result: { ok: boolean } }).result.ok).toBe(false)
    expect(delegate).toHaveBeenCalledTimes(1)
    await dispose()
    expect((await send(envelope)).status).toBe(404)
    const blocked = registerAccountRoutes(ctx.connection, namespace, ['status'], createLoopbackRpcGuard('0.0.0.0', delegate).handler)
    const denied = await send(envelope)
    expect(await denied.json()).toMatchObject({ result: { ok: false, error: { code: 'loopback-required' } } })
    expect(delegate).toHaveBeenCalledTimes(1)
    await blocked()
  } finally {
    await ctx.fiber.dispose()
  }
})
