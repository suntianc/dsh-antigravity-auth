/** One-request Gate 0 and independently selectable LLM-family live fixtures. */

import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AntigravityAuthService } from './auth-service.ts'
import type { CapabilityGateRegistry } from './capability-gates.ts'
import { ANTIGRAVITY_PROVIDER, AntigravityAdapter } from './llm-adapter.ts'
import type { LiveGateResult } from './live-gates.ts'
import { classifyGate0Outcome } from './live-gate-outcome.ts'
import type { LlmFamilyId } from './status.ts'

export const LIVE_TEXT_MODEL = 'antigravity-gemini-3.8-flash' as const
export const LIVE_TEXT_MODEL_BY_FAMILY: Readonly<Record<LlmFamilyId, string>> = Object.freeze({
  gemini: LIVE_TEXT_MODEL,
  claude: 'antigravity-claude-sonnet-5-5',
  'gpt-oss': 'antigravity-gpt-oss-120b-medium',
})

export async function runLlmGate(
  auth: AntigravityAuthService,
  gates: CapabilityGateRegistry,
  family?: LlmFamilyId,
  adapter: Pick<AntigravityAdapter, 'stream'> = new AntigravityAdapter({ auth }),
): Promise<LiveGateResult> {
  // A Gate 0 rerun invalidates all later evidence; family reruns remain independent.
  if (family === undefined) await gates.clear()
  const model = family === undefined ? LIVE_TEXT_MODEL : LIVE_TEXT_MODEL_BY_FAMILY[family]
  try {
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(minimalGenerateOptions(model))) chunks.push(chunk)
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish') throw new Error('The live text gate did not finish normally')
    if (finish.reason.kind === 'error' || finish.reason.kind === 'aborted') {
      throw Object.assign(new Error('The live text gate did not finish normally'), { code: finish.reason.failure.code })
    }
    if (!chunks.some(chunk => chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'block-end')) {
      throw new Error('The live text gate returned no content')
    }
  } catch (error) {
    const outcome = classifyGate0Outcome(error)
    if (family === undefined) await auth.recordGate0(outcome)
    else await auth.recordLlmFamilyGate(family, outcome)
    return { gate: '0L', outcome }
  }
  if (family === undefined) await auth.recordGate0('passed')
  else await auth.recordLlmFamilyGate(family, 'passed')
  return { gate: '0L', outcome: 'passed' }
}

function minimalGenerateOptions(model: string): GenerateOptions {
  const message: Message = {
    id: 'antigravity-live-gate-message' as never,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Reply with exactly: OK' }],
  }
  return { provider: ANTIGRAVITY_PROVIDER, model, messages: [message] }
}
