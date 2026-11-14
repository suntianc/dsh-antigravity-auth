import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createAntigravityAuthService } from '../src/auth-service.ts'
import { createMemoryAuthStore } from '../src/auth-store.ts'
import { createAccountStore, createMemoryAccountStore } from '../src/account-store.ts'
import { createMemoryCapabilityGates, createFileCapabilityGates } from '../src/capability-gates.ts'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

async function stores() {
  const store = createMemoryAuthStore()
  const accounts = createMemoryAccountStore()
  const a = (await accounts.saveAccount({email: 'alice@example.com', refreshToken: 'fake-A1', projectId: 'project-A', lineage: 'lineage-A'})).account
  const b = (await accounts.saveAccount({email: 'bob@example.com', refreshToken: 'fake-B1', projectId: 'project-B', lineage: 'lineage-B'})).account
  return { store, accounts, a, b }
}

it('overlapping account lookups keep each rotation bound to its original account', async () => {
  const { store, accounts, a, b } = await stores()
  const readEntered = deferred(), releaseRead = deferred(), aTransportEntered = deferred()
  const bTransportEntered = deferred(), releaseB = deferred()
  let pauseNextRead = false
  const wrapped = {...accounts, read: async () => {
    const snapshot = await accounts.read()
    if (pauseNextRead) {
      pauseNextRead = false
      readEntered.resolve()
      await releaseRead.promise
    }
    return snapshot
  }}
  const service = createAntigravityAuthService({ store, accountStore: wrapped, credentialOptions: {
    refreshToken: async ({ refreshToken }) => {
      if (refreshToken === 'fake-A1') {
        aTransportEntered.resolve()
        return {accessToken: 'fake-access-A', refreshToken: 'fake-A2', expiresAt: 9e15}
      }
      bTransportEntered.resolve()
      await releaseB.promise
      return {accessToken: 'fake-access-B', refreshToken: 'fake-B2', expiresAt: 9e15}
    },
  }})
  try {
    await service.switchAccount(a.id)
    pauseNextRead = true
    const pendingA = service.credential(undefined, {forceRefresh: true})
    await readEntered.promise
    await service.switchAccount(b.id)
    const pendingB = service.credential(undefined, {forceRefresh: true})
    await bTransportEntered.promise
    releaseRead.resolve()
    await aTransportEntered.promise
    releaseB.resolve()
    await Promise.all([pendingA, pendingB])
    const result = await accounts.read()
    expect({
      aToken: result.accounts.find(x => x.id === a.id)?.refreshToken,
      bToken: result.accounts.find(x => x.id === b.id)?.refreshToken,
      currentToken: (await store.read())?.refreshToken,
    }).toEqual({aToken: 'fake-A2', bToken: 'fake-B2', currentToken: 'fake-B2'})
  } finally {
    releaseRead.resolve(); releaseB.resolve(); await service.dispose()
  }
})

it('revoke started on A cannot send B token after a delayed binding read', async () => {
  const {store, accounts, a, b} = await stores()
  const readEntered = deferred(), releaseRead = deferred()
  let pauseNextRead = false
  const sentTokens: string[] = []
  const wrapped = {...accounts, read: async () => {
    const snapshot = await accounts.read()
    if (pauseNextRead) {
      pauseNextRead = false
      readEntered.resolve()
      await releaseRead.promise
    }
    return snapshot
  }}
  const service = createAntigravityAuthService({store, accountStore: wrapped, credentialOptions: {
    revokeGrant: async ({token}) => {sentTokens.push(token)},
  }})
  try {
    await service.switchAccount(a.id)
    pauseNextRead = true
    const pending = service.revoke(true)
    await readEntered.promise
    await service.switchAccount(b.id)
    releaseRead.resolve()
    const outcome = await pending
    expect({
      sentTokens,
      outcome,
      currentToken: (await store.read())?.refreshToken,
      remainingAccounts: (await accounts.read()).accounts.map(x => x.id),
    }).toEqual({sentTokens: [], outcome: {state: 'superseded'}, currentToken: 'fake-B1', remainingAccounts: [a.id, b.id]})
  } finally {
    releaseRead.resolve(); await service.dispose()
  }
})

it('logout cannot clear B when switching while A account binding is being read', async () => {
  const {store, accounts, a, b} = await stores()
  const entered = deferred(), release = deferred()
  let pauseNextRead = false
  const wrapped = {...accounts, read: async () => {
    const snapshot = await accounts.read()
    if (pauseNextRead) {
      pauseNextRead = false
      entered.resolve()
      await release.promise
    }
    return snapshot
  }}
  const gates = createMemoryCapabilityGates()
  const service = createAntigravityAuthService({store, accountStore: wrapped, gates, autoActivateGates: true})
  try {
    await service.switchAccount(a.id)
    pauseNextRead = true
    const pending = service.logout()
    await entered.promise
    await service.switchAccount(b.id)
    release.resolve()
    await pending
    expect((await store.read())?.refreshToken).toBe('fake-B1')
    expect((await accounts.read()).accounts.map(x => x.id)).toEqual([a.id, b.id])
    expect((await gates.read()).subject).toBe('lineage-B')
  } finally {
    release.resolve()
    await service.dispose()
  }
})

it('a successful A revoke only clears A while its cache cleanup is delayed', async () => {
  const {store, accounts, a, b} = await stores()
  const entered = deferred(), release = deferred()
  const gates = createMemoryCapabilityGates()
  const wrapped = {...accounts, removeAccount: async (...args: Parameters<typeof accounts.removeAccount>) => {
    entered.resolve()
    await release.promise
    return accounts.removeAccount(...args)
  }}
  const sentTokens: string[] = []
  const service = createAntigravityAuthService({store, accountStore: wrapped, gates, autoActivateGates: true,
    credentialOptions: {revokeGrant: async ({token}) => {sentTokens.push(token)}},
  })
  try {
    await service.switchAccount(a.id)
    const pending = service.revoke(true)
    await entered.promise
    await service.switchAccount(b.id)
    release.resolve()
    await expect(pending).resolves.toEqual({state: 'revoked'})
    expect(sentTokens).toEqual(['fake-A1'])
    expect((await store.read())?.refreshToken).toBe('fake-B1')
    expect((await accounts.read()).accounts.map(x => x.id)).toEqual([b.id])
    expect((await gates.read()).subject).toBe('lineage-B')
  } finally {
    release.resolve()
    await service.dispose()
  }
})

for (const action of ['logout', 'revoke'] as const) {
  it(`${action} still removes A cache if B switches in just after A auth was cleared`, async () => {
    const {store, accounts, a, b} = await stores()
    const cleared = deferred(), release = deferred()
    const gates = createMemoryCapabilityGates()
    const wrapped = {...store, clearIfCurrent: async (...args: Parameters<typeof store.clearIfCurrent>) => {
      const result = await store.clearIfCurrent(...args)
      cleared.resolve()
      await release.promise
      return result
    }}
    const service = createAntigravityAuthService({store: wrapped, accountStore: accounts, gates, autoActivateGates: true,
      credentialOptions: {revokeGrant: async () => {}},
    })
    try {
      await service.switchAccount(a.id)
      const pending = action === 'logout' ? service.logout() : service.revoke(true)
      await cleared.promise
      await service.switchAccount(b.id)
      release.resolve()
      await pending
      expect((await store.read())?.refreshToken).toBe('fake-B1')
      expect((await accounts.read()).accounts.map(x => x.id)).toEqual([b.id])
      expect((await gates.read()).subject).toBe('lineage-B')
    } finally {
      release.resolve()
      await service.dispose()
    }
  })
}

for (const backend of ['memory', 'file'] as const) {
  it(`${backend} account mutations retain concurrent updates and reject stale credentials`, async () => {
    const directory = await mkdtemp(join(process.cwd(), '.account-concurrency-'))
    try {
      const accounts = backend === 'memory' ? createMemoryAccountStore()
        : createAccountStore(join(directory, 'accounts.json'), join(directory, 'auth.json'))
      const [first, second] = await Promise.all([
        accounts.saveAccount({email: 'alice@example.com', refreshToken: 'fake-A1', projectId: 'project-A', lineage: 'lineage-A'}),
        accounts.saveAccount({email: 'bob@example.com', refreshToken: 'fake-B1', projectId: 'project-B', lineage: 'lineage-B'}),
      ])
      expect(first.account.id).not.toBe(second.account.id)
      await Promise.all([
        accounts.syncRefreshToken({accountId: first.account.id, previousRefreshToken: 'fake-A1', refreshToken: 'fake-A2', lineage: 'lineage-A'}),
        accounts.setActive(second.account.id),
      ])
      const current = await accounts.read()
      expect(current.activeId).toBe(second.account.id)
      expect(current.accounts.map(account => account.refreshToken)).toEqual(['fake-A2', 'fake-B1'])
      await expect(accounts.syncRefreshToken({accountId: first.account.id, previousRefreshToken: 'fake-A1', refreshToken: 'stale-result'})).resolves.toBe(false)
      await expect(accounts.removeAccount(first.account.id, first.account)).resolves.toBeUndefined()
      expect((await accounts.read()).accounts).toHaveLength(2)

      const replacement = await accounts.saveAccount({...first.account, refreshToken: 'fake-new-login', lineage: 'new-lineage'})
      await expect(accounts.removeAccount(first.account.id, first.account)).resolves.toBeUndefined()
      await expect(accounts.removeAccount(replacement.account.id, replacement.account)).resolves.toEqual(replacement.account)
      expect((await accounts.read()).accounts.map(account => account.id)).toEqual([second.account.id])
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  })

  it(`${backend} gate cleanup preserves a different account's evidence`, async () => {
    const directory = await mkdtemp(join(process.cwd(), '.account-concurrency-'))
    try {
      const gates = backend === 'memory' ? createMemoryCapabilityGates()
        : createFileCapabilityGates(join(directory, 'gates.json'))
      await gates.recordGate0('lineage-B', 'passed')
      await gates.clear('lineage-A')
      expect((await gates.read()).subject).toBe('lineage-B')
      await gates.clear('lineage-B')
      expect(await gates.read()).toEqual({})
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  })
}

it('switching accounts invalidates cached quota and detaches the previous account flight', async () => {
  const {store, accounts, a, b} = await stores()
  const entered = deferred(), release = deferred<Response>()
  const sent: string[] = []
  const response = (fraction: number) => new Response(JSON.stringify({groups: [{displayName: 'Gemini', buckets: [{window: 'weekly', remainingFraction: fraction, resetTime: '2030-01-01T00:00:00Z'}]}]}))
  const service = createAntigravityAuthService({store, accountStore: accounts,
    credentialOptions: {refreshToken: async ({refreshToken}) => ({accessToken: `access-${refreshToken}`, expiresAt: 9e15})},
    quotaOptions: {transport: {request: async input => {
      sent.push(input.accessToken)
      if (input.accessToken === 'access-fake-A1') {
        entered.resolve()
        return await release.promise
      }
      return response(0.2)
    }}},
  })
  try {
    await service.switchAccount(a.id)
    const pending = service.usage()
    await entered.promise
    await service.switchAccount(b.id)
    const fresh = await service.usage()
    release.resolve(response(1))
    expect((await pending).groups).toBeUndefined()
    expect(fresh.groups?.[0]?.windows[0]?.remainingFraction).toBe(0.2)
    expect(await service.usage()).toEqual(fresh)
    expect(sent).toEqual(['access-fake-A1', 'access-fake-B1'])
    await service.logout()
    expect(await service.usage()).toEqual({state: 'unauthenticated'})
  } finally {
    release.resolve(response(1))
    await service.dispose()
  }
})
