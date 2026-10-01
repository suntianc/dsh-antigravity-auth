/** Host dispatcher protected by the Antigravity account RPC activation guard. */

import type { ConnectionRpcResult as RpcResult } from '@deepseek-ai/dsh-client-connection'
import { OAuthFlowError } from './oauth-flow.ts'
import { CredentialOperationError, credentialErrorMessage } from './credential-coordinator.ts'
import type { BootstrapStatusService } from './status.ts'
import type { QuotaStatusView } from './quota.ts'
import { isSafeRpcErrorCode, safeRpcErrorMessage } from './rpc-vocabulary.ts'
import type { AntigravityModelCatalogService } from './model-catalog.ts'
import { openAuthorizationUrl } from './open-authorization-url.ts'

export { ANTIGRAVITY_AUTH_RPC_CHANNEL, ANTIGRAVITY_AUTH_RPC_NAMESPACE } from './rpc-contract.ts'

/** Dispatch closed, value-safe requests; callback URLs are never echoed. */
export async function handleAntigravityAuthRpc(
  service: Pick<BootstrapStatusService, 'status' | 'acknowledgeRisk' | 'startLogin' | 'cancelLogin' | 'logout' | 'revoke'> & { usage?: (signal?: AbortSignal, force?: boolean) => Promise<QuotaStatusView> },
  endpoint: string,
  payload: unknown,
  signal?: AbortSignal,
  modelCatalog?: AntigravityModelCatalogService,
): Promise<RpcResult<unknown>> {
  if (signal?.aborted === true) return cancelled()

  try {
    if (endpoint === 'status') {
      if (!isEmptyRecord(payload)) return badRequest('status expects an empty payload')
      return { ok: true, value: { status: await service.status() } }
    }
    if (endpoint === 'models') {
      if (!isRefreshPayload(payload)) return badRequest('models expects {} or { force: boolean }')
      if (modelCatalog === undefined) return badRequest('model catalog is unavailable')
      const status = await service.status()
      const gateReady = status.login.projectAvailable
        && status.capabilities.some(capability => capability.id === 'auth-llm' && capability.state === 'available')
      return { ok: true, value: gateReady
        ? await modelCatalog.modelCatalog(signal, payload.force)
        : modelCatalog.catalogSnapshot() }
    }
    if (endpoint === 'usage') {
      if (!isRefreshPayload(payload)) return badRequest('usage expects {} or { force: boolean }')
      if (service.usage === undefined) return { ok: true, value: { state: 'protocol-drift' as const } }
      return { ok: true, value: await service.usage(signal, payload.force) }
    }
    if (endpoint === 'acknowledge-risk') {
      if (!isAcknowledgement(payload)) return badRequest('acknowledge-risk expects { acknowledge: true }')
      return { ok: true, value: await service.acknowledgeRisk() }
    }
    if (endpoint === 'login') {
      if (!isEmptyRecord(payload)) return badRequest('login expects an empty payload')
      const result = await service.startLogin()
      void openAuthorizationUrl(result.authorizationUrl).catch(() => false)
      return { ok: true, value: result }
    }
    if (endpoint === 'cancel' || endpoint === 'cancel-login') {
      if (!isEmptyRecord(payload)) return badRequest('cancel expects an empty payload')
      return { ok: true, value: await service.cancelLogin() }
    }
    if (endpoint === 'logout') {
      if (!isEmptyRecord(payload)) return badRequest('logout expects an empty payload')
      return { ok: true, value: await service.logout() }
    }
    if (endpoint === 'revoke') {
      if (!isRevokePayload(payload)) return badRequest('revoke expects { confirmed: true }')
      return { ok: true, value: await service.revoke(true, signal) }
    }
    return badRequest('unknown Antigravity auth endpoint')
  } catch (error) {
    return safeFailure(error)
  }
}

function badRequest(message: string): RpcResult<never> {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function cancelled(): RpcResult<never> {
  return { ok: false, error: { code: 'cancelled', message: 'antigravity-auth: request cancelled', details: {} } }
}

function safeFailure(error: unknown): RpcResult<never> {
  const credentialError = error instanceof CredentialOperationError ? error : undefined
  const candidate = error instanceof OAuthFlowError
    ? error.code
    : credentialError?.code ?? 'internal'
  const code = isSafeRpcErrorCode(candidate) ? candidate : 'internal'
  return {
    ok: false,
    error: {
      code: code as never,
      message: credentialError === undefined
        ? safeRpcErrorMessage(code)
        : credentialErrorMessage(credentialError.code) ?? safeRpcErrorMessage(code),
      details: {},
    },
  }
}

function isEmptyRecord(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0
}

function isRefreshPayload(value: unknown): value is { force?: boolean } {
  return isRecord(value)
    && Object.keys(value).every(key => key === 'force')
    && (value.force === undefined || typeof value.force === 'boolean')
}

function isAcknowledgement(value: unknown): value is { acknowledge: true } {
  return isRecord(value)
    && Object.keys(value).length === 1
    && value.acknowledge === true
}

function isRevokePayload(value: unknown): value is { confirmed: true } {
  return isRecord(value)
    && Object.keys(value).length === 1
    && value.confirmed === true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
