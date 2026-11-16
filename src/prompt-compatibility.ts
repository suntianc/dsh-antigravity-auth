/** Default-on prompt compatibility, matching dsh-prompt-compat's built-in rules. */
import type { Context } from '@deepseek-ai/cordis'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'

export const HARNESS_IDENTITY_SENTENCE = 'You are an AI agent powered by DeepSeek Harness.'
const COMPATIBLE_IDENTITY_SENTENCE = 'You are an AI coding assistant.'
const BROWSER_SURFACE_SENTENCE = 'The browser provides no implicit DOM, route, or screenshot context.'
const COMPATIBLE_BROWSER_SURFACE_SENTENCE = 'The browser tool has no DOM, route, or screenshot context available to it by default.'

/** Transform the named identity contributions while retaining their instructions.
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
  const transformText = (name: string, text: string): string => {
    if (name === 'harness:identity') return text.replaceAll(HARNESS_IDENTITY_SENTENCE, COMPATIBLE_IDENTITY_SENTENCE)
    if (name === 'harness:source' || name === 'app:web-surface') return text.replaceAll('DeepSeek Harness', 'host application').replaceAll(BROWSER_SURFACE_SENTENCE, COMPATIBLE_BROWSER_SURFACE_SENTENCE)
    return text
  }
  let changed = false
  const sections = assembly.sections.map(section => {
    const text = transformText(section.name, section.text)
    if (text === section.text) return section
    changed = true
    return { ...section, text }
  })
  const contexts = assembly.contexts.map(item => {
    if (item.name !== 'harness:source' && item.name !== 'app:web-surface') return item
    const text = transformText(item.name, item.text)
    if (text === item.text) return item
    // DSH refreshes registered runtime contexts after assembly. A plugin-owned
    // snapshot name preserves the replacement and the original path/GUI URL.
    const name = `antigravity-prompt-compat:${item.name}`
    if (assembly.contexts.some(other => other.name === name)) {
      throw new Error('antigravity-auth: a compatible context name is already registered.')
    }
    changed = true
    return { ...item, name, text }
  })
  return changed ? { ...assembly, sections, contexts } : assembly
}

/** Optional service injection leaves non-agent/terminal compositions usable. */
export function mountPromptCompatibility(ctx: Context, ownsRoute: (provider: string) => boolean): void {
  ctx.inject(['systemPrompt'], promptCtx => {
    promptCtx.on('system-prompt/assemble', async (_assembly, context, next) => {
      return compatiblePromptAssembly(await next(), context, ownsRoute)
    })
  })
}
