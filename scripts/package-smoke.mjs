#!/usr/bin/env node
/** Verify the private Wire Identity package shape without installing or publishing it. */
import { DSH_BASELINE, DSH_PEER_RANGE, DSH_VERIFY_VERSION, resolvedDshPackages } from './dsh-compatibility.mjs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const sourceRoot = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(resolve(sourceRoot, '.package-smoke-'))
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
try {
  const packDestinationArg = process.platform === 'win32'
    ? `--pack-destination="${temporary}"`
    : `--pack-destination=${temporary}`
  const output = execFileSync(npmCmd, [
    'pack', '--json', '--ignore-scripts', packDestinationArg,
  ], {
    cwd: sourceRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
  })
  const jsonStart = output.lastIndexOf('\n[')
  const packed = JSON.parse(output.slice(jsonStart < 0 ? 0 : jsonStart + 1))
  const filename = packed?.[0]?.filename
  if (typeof filename !== 'string') throw new Error('package smoke: npm pack returned no artifact')
  // Use relative filename with cwd to avoid drive-letter colons on Windows, compatible with both bsdtar and GNU tar without --force-local
  execFileSync('tar', ['-xzf', filename], { cwd: temporary })

  const packageRoot = resolve(temporary, 'package')
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
  const dshGraph = resolvedDshPackages(await readFile(resolve(sourceRoot, 'pnpm-lock.yaml'), 'utf8'))
  if (dshGraph.length === 0 || dshGraph.some(entry => entry.version !== DSH_VERIFY_VERSION)) {
    throw new Error('package smoke: DSH lockfile is not one coherent verified graph')
  }
  for (const [name, version] of Object.entries(manifest.devDependencies ?? {})) {
    if (name.startsWith('@deepseek-ai/dsh-') && version !== DSH_BASELINE) {
      throw new Error(`package smoke: ${name} is not pinned to the exact development baseline`)
    }
  }
  if (manifest.dependencies?.['@cortexkit/antigravity-auth-core'] !== '2.2.0'
    || manifest.devDependencies?.['@cortexkit/antigravity-auth-core'] !== '2.2.0') {
    throw new Error('package smoke: Antigravity core changed without a separate audit')
  }
  const changelog = await readFile(resolve(packageRoot, 'CHANGELOG.md'), 'utf8')
  if (!changelog.includes(`## [${String(manifest.version)}]`)) {
    throw new Error(`package smoke: CHANGELOG.md lacks release ${String(manifest.version)}`)
  }
  const retiredPackages = new Set([
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-host-apiproxy',
  ])
  for (const field of ['dependencies', 'peerDependencies', 'devDependencies']) {
    for (const dependency of Object.keys(manifest[field] ?? {})) {
      if (retiredPackages.has(dependency)) throw new Error(`package smoke: ${field} retains ${dependency}`)
    }
  }
  const clientInject = manifest.dsh?.client?.inject
  if (!Array.isArray(clientInject) || clientInject.some(dependency => retiredPackages.has(dependency))) {
    throw new Error('package smoke: client injection retains a retired DSH package')
  }
  for (const [dependency, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (dependency.startsWith('@deepseek-ai/dsh-') && range !== DSH_PEER_RANGE) {
      throw new Error(`package smoke: ${dependency} does not declare the verified DSH baseline`)
    }
  }
  if (manifest.peerDependencies?.['@deepseek-ai/cordis'] !== '^4.0.4'
    || manifest.peerDependencies?.['@deepseek-ai/schemastery'] !== '^3.18.4') {
    throw new Error('package smoke: Cordis or Schemastery peer baseline does not match DSH 0.2.0-rc.2')
  }
  const patch = await readFile(resolve(packageRoot, 'cordis.patch.yml'), 'utf8')
  for (const row of ['antigravity-auth', 'antigravity-search', 'antigravity-image', 'antigravity-video']) {
    if (!patch.includes(`id: ${row}`)) throw new Error(`package smoke: patch lacks independent row ${row}`)
  }
  if (patch.includes('deepseek-harness')) throw new Error('package smoke: patch unexpectedly mentions DSH core')

  for (const key of [
    '.',
    './client',
    './search',
    './image',
    './video',
    './rpc-contract',
    './project-context',
    './wire-identity',
    './invariant',
    './llm-adapter',
    './private-transport',
    './replay',
    './quota',
    './media-admission',
    './live-gates',
  ]) {
    const target = manifest.exports?.[key]?.default
    const types = manifest.exports?.[key]?.types
    if (typeof target !== 'string' || typeof types !== 'string') throw new Error(`package smoke: incomplete export ${key}`)
    await access(resolve(packageRoot, target))
    await access(resolve(packageRoot, types))
    if (key !== './client') {
      const loaded = await import(pathToFileURL(resolve(packageRoot, target)).href)
      if (key === '.' && typeof loaded.createWireIdentity !== 'function') {
        throw new Error('package smoke: root entry has no Wire Identity export')
      }
      if (key === './project-context' && typeof loaded.createProjectDiscovery !== 'function') {
        throw new Error('package smoke: project-context export has no discovery factory')
      }
      if (key === './llm-adapter' && typeof loaded.AntigravityAdapter !== 'function') {
        throw new Error('package smoke: llm-adapter export has no adapter')
      }
      if (key === './quota' && typeof loaded.normalizeQuotaResponse !== 'function') {
        throw new Error('package smoke: quota export has no normalizer')
      }
      if (key === './media-admission' && typeof loaded.admitWorkspaceImage !== 'function') {
        throw new Error('package smoke: media-admission export has no workspace admission')
      }
      if (key === './live-gates' && typeof loaded.runLiveGateCli !== 'function') {
        throw new Error('package smoke: live-gates export has no opt-in CLI boundary')
      }
    }
  }
  await access(resolve(packageRoot, 'lib/live-gate-runner.js'))
  const packedLiveGateCli = resolve(packageRoot, 'scripts/live-gates.mjs')
  await access(packedLiveGateCli)
  const cliEnvironment = { ...process.env }
  delete cliEnvironment.DSH_ANTIGRAVITY_LIVE_ACK
  const cliProbe = spawnSync(process.execPath, [packedLiveGateCli, '--gate', 'S'], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: cliEnvironment,
  })
  if (cliProbe.status !== 2 || !cliProbe.stderr.includes('explicit acknowledgement')) {
    throw new Error('package smoke: packed live gate CLI did not enforce inert dual opt-in')
  }
  const liveGateSource = await readFile(resolve(packageRoot, 'lib/live-gates.js'), 'utf8')
  if (!liveGateSource.includes('live-gate-runner.js')) throw new Error('package smoke: live gate CLI cannot load its packed production runner')
  const liveGateRunnerSource = await readFile(resolve(packageRoot, 'lib/live-gate-runner.js'), 'utf8')
  for (const marker of ['live-sha256-', 'gemini', 'claude', 'gpt-oss', 'KUMQUAT']) {
    if (!liveGateRunnerSource.includes(marker)) throw new Error(`package smoke: packed live gate runner lacks ${marker}`)
  }

  const hostEntrySource = await readFile(resolve(packageRoot, 'lib/index.js'), 'utf8')
  if (!hostEntrySource.includes('loopback-required')) {
    throw new Error('package smoke: Host entry lacks the account RPC guard')
  }
  for (const marker of ['dsh-client-runtime', 'dsh-host-apiproxy']) {
    if (hostEntrySource.includes(marker)) throw new Error(`package smoke: Host entry retains ${marker}`)
  }

  const source = await readFile(resolve(packageRoot, 'lib/wire-identity.js'), 'utf8')
  for (const marker of ['X-DeepSeek-Harness-Attribution', 'buildAgyCliHeaderPairs', 'buildAntigravityHarnessUserAgent']) {
    if (!source.includes(marker)) throw new Error(`package smoke: Wire Identity artifact lacks ${marker}`)
  }
  for (const marker of ['ANTIGRAVITY_HEADERS', 'X-Goog-Api-Client', 'Client-Metadata']) {
    if (source.includes(marker)) throw new Error(`package smoke: Wire Identity artifact retains obsolete ${marker}`)
  }
  if (source.includes('deepseek-harness core')) throw new Error('package smoke: artifact contains an invalid core implementation claim')

  const clientTarget = manifest.exports?.['./client']?.default
  if (typeof clientTarget !== 'string') throw new Error('package smoke: client export is missing')
  const clientSource = await readFile(resolve(packageRoot, clientTarget), 'utf8')
  for (const marker of ['node:', '@cortexkit/antigravity-auth-core', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-host-apiproxy', 'globalThis.fetch']) {
    if (clientSource.includes(marker)) throw new Error(`package smoke: client artifact contains Host-only marker ${marker}`)
  }
  let registration
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window')
  const originalWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: value => { registration = value } } }
  try {
    await import(pathToFileURL(resolve(packageRoot, clientTarget)).href)
  } finally {
    if (hadWindow) globalThis.window = originalWindow
    else delete globalThis.window
  }
  if (registration?.id !== manifest.name || typeof registration.factory !== 'function') {
    throw new Error('package smoke: client artifact did not register with the DSH module loader')
  }
  const clientExports = registration.factory(createRequire(resolve(packageRoot, 'package.json')))
  if (typeof clientExports?.apply !== 'function') {
    throw new Error('package smoke: client factory did not expose an apply function')
  }

  console.log(`package smoke: ${filename} exposes private Host/client entries, project discovery, an inert packed live-gate CLI, fixed Wire Identity, and value-free types`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
