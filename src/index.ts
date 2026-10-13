/** Host half of the private Antigravity bootstrap capability bundle. */

import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import { createAntigravityAuthService, fetchUserEmail } from './auth-service.ts'
import { createAntigravityAuthCommand } from './auth-command.ts'
import { AntigravityAdapter, ANTIGRAVITY_PROVIDER } from './llm-adapter.ts'
import { defaultAuthStorePath } from './auth-store.ts'
import { registerAccountRoutes } from './account-routes.ts'
import { ANTIGRAVITY_AUTH_RPC_NAMESPACE, handleAntigravityAuthRpc } from './rpc.ts'
import {
  commandAccountMode, createLoopbackRpcGuard, type LoopbackRpcMode,
} from './loopback-rpc.ts'
import { mountCapabilityLifecycle } from './capability-lifecycle.ts'

export const name = 'antigravity-auth'
export const inject = ['llm', 'attachments']

/** Mount the Host-only OAuth service and its guarded account RPC channel. */
export function apply(ctx: Context): void {
  const service = createAntigravityAuthService({
    storePath: defaultAuthStorePath(),
    autoActivateGates: true,
    fetchEmail: fetchUserEmail,
  })
  // Account-control activation for the slash command. A terminal composition
  // composes no public WebServer, so the command starts enabled (local-only
  // dispatch); the connection inject below records the WebServer bind and
  // blocks every account operation when the commands seam is exposed beyond
  // loopback. The account RPC keeps its own ADR-0008 static loopback guard.
  let accountMode: LoopbackRpcMode = 'enabled'
  const runtime = ctx as unknown as {
    llm?: {
      listProviders?: () => readonly { id: string }[]
      registerAdapter?: (providers: string[], adapter: AntigravityAdapter) => (() => void) & { replace?: (providers: string[]) => void }
    }
    attachments?: Pick<AttachmentStore, 'readImage'>
  }
  const adapter = new AntigravityAdapter({
    auth: service,
    ...(runtime.attachments === undefined ? {} : { attachments: runtime.attachments }),
  })
  const contextWithProvide = ctx as Context & { provide?: (name: string, value: unknown) => () => Promise<void> | void }
  const unprovide = contextWithProvide.provide?.('antigravityAuth', service) ?? (() => {})
  ctx.inject(['connection'], (connectionCtx) => {
    const webServer = connectionCtx.get('webServer')
    accountMode = commandAccountMode(webServer)
    const guard = createLoopbackRpcGuard(
      webServer?.host,
      (endpoint, payload, signal) => handleAntigravityAuthRpc(service, endpoint, payload, signal, adapter),
    )
    if (guard.mode === 'blocked') {
      connectionCtx.logger.warn('antigravity-auth: account RPC is disabled because the WebServer is not loopback-bound')
    }
    return registerAccountRoutes(connectionCtx.connection, ANTIGRAVITY_AUTH_RPC_NAMESPACE, ['status', 'models', 'usage', 'acknowledge-risk', 'login', 'cancel', 'cancel-login', 'logout', 'revoke'], guard.handler)
  })
  mountCapabilityLifecycle({
    ctx,
    auth: service,
    id: 'auth-llm',
    enabled: () => runtime.llm?.registerAdapter !== undefined,
    register: () => {
      if (runtime.llm?.registerAdapter === undefined) return undefined
      if (runtime.llm.listProviders?.().some(provider => provider.id === ANTIGRAVITY_PROVIDER)) return undefined
      const routes: string[] = [ANTIGRAVITY_PROVIDER]
      if (!runtime.llm.listProviders?.().some(provider => provider.id === 'google')) {
        routes.push('google')
      }
      const dispose = runtime.llm.registerAdapter(routes, adapter)
      return () => {
        try { dispose() } finally { adapter.invalidateModelCatalog() }
      }
    },
    ownsAuth: true,
    cleanup: unprovide,
    label: 'antigravity-auth: OAuth and LLM operations',
  })
  ctx.inject(['commands'], (commandCtx) => {
    const mainCommand = createAntigravityAuthCommand(service, () => accountMode)
    commandCtx.commands.register(mainCommand)
    commandCtx.commands.register({
      ...mainCommand,
      name: 'anti',
      description: 'Antigravity OAuth multi-account management and switching (/anti accounts | switch | login)',
    })
  })
}

export * from './auth-service.ts'
export * from './credential-coordinator.ts'
export * from './rpc-contract.ts'
export * from './status.ts'
export * from './project-context.ts'
export * from './wire-identity.ts'
export * from './llm-adapter.ts'
export * from './private-transport.ts'
export * from './replay.ts'
export * from './quota.ts'
export * from './account-store.ts'
export * from './media-admission.ts'
export * from './model-catalog.ts'
export * from './capability-gates.ts'
export * from './live-gates.ts'
