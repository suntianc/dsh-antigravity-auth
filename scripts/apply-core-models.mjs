// Adds gemini-4-neon-* and the two Orchestrator routes to the installed
// @cortexkit/antigravity-auth-core (3.1.2), whose registry is hardcoded.
// Idempotent. Usage: node scripts/apply-core-models.mjs [path-to-core-package-root]
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const patch = resolve(here, 'core-models.patch')
const root = process.argv[2]
  ? resolve(process.argv[2])
  : dirname(createRequire(import.meta.url).resolve('@cortexkit/antigravity-auth-core/package.json'))
const git = (...args) => execFileSync('git', ['apply', '-p1', ...args, patch], { cwd: root, stdio: 'ignore' })

try { git('--reverse', '--check'); console.log('already patched:', root); process.exit(0) } catch {}
try { git('--check') } catch { console.error('patch does not apply (core version != 3.1.2?): run `git apply --check -p1 scripts/core-models.patch` in', root); process.exit(1) }
git()
console.log('patched:', root)
