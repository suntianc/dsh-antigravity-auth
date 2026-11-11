import { buildAntigravityHarnessUserAgent } from '@cortexkit/antigravity-auth-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGY_PROVIDER_USER_AGENT,
  DSH_ATTRIBUTION_HEADER,
  WireIdentityError,
  createWireIdentity,
} from 'dsh-antigravity-auth/wire-identity'

const { attributionHeadersMock } = vi.hoisted(() => ({ attributionHeadersMock: vi.fn() }))
vi.mock('@deepseek-ai/dsh-llm', () => ({
  attributionHeaders: () => attributionHeadersMock(),
}))

const DSH_USER_AGENT = 'deepseek-harness/0.1.2-alpha.5 (+https://github.com/deepseek-ai/deepseek-harness)'

beforeEach(() => {
  attributionHeadersMock.mockReset()
  attributionHeadersMock.mockReturnValue({ 'user-agent': DSH_USER_AGENT })
})

function identity() {
  return createWireIdentity()
}

describe('plugin-owned Wire Identity', () => {
  it('keeps the audited Antigravity provider identity and adds one DSH carrier', () => {
    const wire = identity()
    expect(AGY_PROVIDER_USER_AGENT).toBe(buildAntigravityHarnessUserAgent())
    expect(AGY_PROVIDER_USER_AGENT).toContain('antigravity/cli/1.3.5')
    expect(wire.headers()).toEqual({
      'User-Agent': AGY_PROVIDER_USER_AGENT,
      [DSH_ATTRIBUTION_HEADER]: DSH_USER_AGENT,
    })
    expect(Object.isFrozen(wire.headers())).toBe(true)
  })

  it('does not expose a caller-controlled identity override surface', () => {
    const wire = identity()
    const headers = wire.headers() as unknown as Record<string, string>
    expect(() => { headers[DSH_ATTRIBUTION_HEADER] = 'spoofed' }).toThrow()
    expect(wire.headers()[DSH_ATTRIBUTION_HEADER]).toBe(DSH_USER_AGENT)
  })

  it('builds fixed HTTP/1.1 header pairs with both identities', () => {
    const wire = identity()
    const pairs = wire.headerPairs('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent', {
      authorization: 'Bearer access-token',
      body: '{}',
    })
    expect(pairs).toEqual([
      ['Host', 'daily-cloudcode-pa.googleapis.com'],
      ['User-Agent', AGY_PROVIDER_USER_AGENT],
      [DSH_ATTRIBUTION_HEADER, DSH_USER_AGENT],
      ['Transfer-Encoding', 'chunked'],
      ['Authorization', 'Bearer access-token'],
      ['Content-Type', 'application/json'],
      ['Accept-Encoding', 'gzip'],
    ])
  })

  it('uses content length for non-stream requests without changing the provider framing', () => {
    const pairs = identity().headerPairs('https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent', {
      authorization: 'Bearer access-token',
      body: new Uint8Array([0, 1, 2]),
    })
    expect(pairs).toContainEqual(['Content-Length', '3'])
    expect(pairs).not.toContainEqual(['Transfer-Encoding', 'chunked'])
  })

  it('serializes the exact ordered raw HTTP/1.1 request with the DSH carrier on wire', () => {
    const bytes = identity().serialize('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent', {
      authorization: 'Bearer access-token',
      body: '{}',
    })
    const raw = new TextDecoder().decode(bytes)
    expect(raw).toBe([
      'POST /v1internal:streamGenerateContent HTTP/1.1',
      'Host: daily-cloudcode-pa.googleapis.com',
      `User-Agent: ${AGY_PROVIDER_USER_AGENT}`,
      `${DSH_ATTRIBUTION_HEADER}: ${DSH_USER_AGENT}`,
      'Transfer-Encoding: chunked',
      'Authorization: Bearer access-token',
      'Content-Type: application/json',
      'Accept-Encoding: gzip',
      '',
      '2',
      '{}',
      '0',
      '',
      '',
    ].join('\r\n'))
  })

  it('terminates an empty chunked streaming request explicitly', () => {
    const bytes = identity().serialize('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent', {
      authorization: 'Bearer access-token',
      body: '',
    })
    expect(new TextDecoder().decode(bytes)).toMatch(/\r\n\r\n0\r\n\r\n$/u)
  })

  it.each([
    ['missing', () => ({})],
    ['empty', () => ({ 'user-agent': '' })],
    ['control', () => ({ 'user-agent': `${DSH_USER_AGENT}\r\nX-Leak: yes` })],
    ['too long', () => ({ 'user-agent': 'x'.repeat(1025) })],
    ['unexpected header', () => ({ 'user-agent': DSH_USER_AGENT, authorization: 'Bearer secret' })],
    ['duplicate casing', () => ({ 'user-agent': DSH_USER_AGENT, 'User-Agent': DSH_USER_AGENT })],
  ])('rejects unsafe DSH attribution (%s) without echoing the value', (_name, source) => {
    attributionHeadersMock.mockReturnValue(source())
    expect(() => createWireIdentity()).toThrow(WireIdentityError)
    try {
      createWireIdentity()
    } catch (error) {
      expect(String(error)).not.toContain('Bearer secret')
      expect(String(error)).not.toContain('X-Leak')
    }
  })

  it('rejects attribution replaced by the provider identity', () => {
    attributionHeadersMock.mockReturnValue({ 'user-agent': AGY_PROVIDER_USER_AGENT })
    try {
      createWireIdentity()
      expect.fail('expected provider-overridden attribution to be rejected')
    } catch (error) {
      expect(error).toMatchObject({ code: 'WIRE_ATTRIBUTION_PROVIDER_OVERRIDE' })
    }
  })

  it('rejects a caller-supplied authorization value that could inject headers', () => {
    try {
      identity().headerPairs('https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent', {
        authorization: 'Bearer good\r\nX-Leak: yes',
        body: '{}',
      })
      expect.fail('expected unsafe authorization to be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(WireIdentityError)
      expect((error as WireIdentityError).code).toBe('WIRE_REQUEST_UNSAFE_AUTHORIZATION')
      expect(String(error)).not.toContain('X-Leak')
    }
  })

  it('rejects caller attempts to inject or replace provider headers', () => {
    expect(() => identity().headerPairs(
      'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent',
      {
        authorization: 'Bearer access-token',
        body: '{}',
        headers: { [DSH_ATTRIBUTION_HEADER]: 'spoofed' },
      } as never,
    )).toThrow(WireIdentityError)
  })

  it('does not send a bearer value to an arbitrary HTTPS origin or path', () => {
    expect(() => identity().headerPairs('https://example.test/private', {
      authorization: 'Bearer access-token',
      body: '{}',
    })).toThrow(WireIdentityError)
    expect(() => identity().headerPairs('https://daily-cloudcode-pa.googleapis.com/private', {
      authorization: 'Bearer access-token',
      body: '{}',
    })).toThrow(WireIdentityError)
  })
})
