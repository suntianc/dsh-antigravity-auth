/** Opt-in, section-scoped compatibility; never inspect request/history text. */
import type { Context } from '@deepseek-ai/cordis'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'

export const HARNESS_IDENTITY_SENTENCE = 'You are an AI agent powered by DeepSeek Harness.'
const COMPATIBLE_IDENTITY_SENTENCE = 'You are an AI coding assistant.'

/** Only the exact public default contribution is eligible, not custom personas.
 * Route scope is assembly-time only; later agent/request rerouting is unsupported.
 */
export function compatiblePromptAssembly(
  assembly: PromptAssembly,
  context: AssembleContext,
  ownsRoute: (provider: string) => boolean,
): PromptAssembly {
  const route = context as AssembleContext & { provider?: unknown }
  const provider = typeof route.provider === 'string' ? route.provider : assembly.variables.provider
  if ((provider !== 'google-antigravity' && provider !== 'google') || !ownsRoute(provider)) return assembly
  let changed = false
  const sections = assembly.sections.map(section => {
    if (section.name !== 'harness:identity' || section.text !== HARNESS_IDENTITY_SENTENCE) return section
    changed = true
    return { ...section, text: COMPATIBLE_IDENTITY_SENTENCE }
  })
  return changed ? { ...assembly, sections } : assembly
}

/** Optional service injection leaves non-agent/terminal compositions usable. */
export function mountPromptCompatibility(ctx: Context, ownsRoute: (provider: string) => boolean): void {
  ctx.inject(['systemPrompt'], promptCtx => {
    promptCtx.on('system-prompt/assemble', async (_assembly, context, next) => {
      return compatiblePromptAssembly(await next(), context, ownsRoute)
    })
  })
}
