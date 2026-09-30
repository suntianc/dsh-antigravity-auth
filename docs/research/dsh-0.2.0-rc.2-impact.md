# DSH 0.2.0-rc.2 plugin impact assessment

## Fixed inputs

- Plugin starting point: `a0da3f3` (`dsh-antigravity-auth@0.1.4-rc.5`).
- Official source tag: `dsh-v0.2.0-rc.2`, commit
  `639ed015397290b3745d163aafe02ffee4aa3f84`.
- Compared against `dsh-v0.2.0-rc.1`, commit
  `4878cdabd87d4041bdaff61d04c966883b9fd07a`.
- npm development packages and all transitive DSH peers must resolve exactly
  `0.2.0-rc.2`; declared DSH peers start at `^0.2.0-rc.2`.

## Contract review

The tagged diff leaves the public implementation of `dsh-llm`, `dsh-web`,
`dsh-agent-loop`, `dsh-tools`, `dsh-session`, `dsh-settings`,
`dsh-client-connection`, and `dsh-credentials` unchanged. Their manifests
advance to the new release. No provider adapter rewrite is justified by this
upgrade: V4 role `tool` messages, Config Forms/volatile settings, account-bound
credential lifecycle, and plugin-owned static loopback RPC guard remain valid.

`dsh-api-remotes` adds the stock user-questions remote contribution. The plugin
continues using the public injected remotes and does not mount or duplicate it.

The upstream pi-ai adapter upgrades pi-ai from `0.85.1` to `0.87.1`, adjusts
catalog compatibility and same-model replay metadata, and carries its upstream
argument-streaming patch forward. Antigravity subclasses `LlmAdapter` directly;
it does not import pi-ai or `PiAiAdapter`, and its dependency graph contains
neither. Adding a pi-ai pin or copying that adapter's replay logic here would
introduce an unrelated dependency. The pinned Antigravity core remains `2.2.0`.

## Required regression evidence

Run the complete registry-package gate and the same gate against independently
built packages from the official tag. Existing public-seam suites cover:

- Auth/login cancellation, account-switch/refresh/logout races and loopback RPC
- Model discovery, AgentLoop system messages and V4 tool responses
- Stream terminal composition, signed replay, completed tool-call ID reuse
- Search grounding, concurrent cancellation and Host socket error containment
- Image/video tool admission, attachment authorization, settings and client UI

These are mocked/offline provider checks. They do not prove live Google OAuth,
private endpoint compatibility or an installed user profile. No real credential
or profile may be read, and no live gate is part of this upgrade.

## Verification results (2026-09-30)

- Isolated Linux cloud checkout; Node `24.19.0`, pnpm `11.19.0`.
- `pnpm install --no-frozen-lockfile --ignore-scripts`, then
  `pnpm install --frozen-lockfile`: passed. The latter ran the normal prepare
  build. Registry request-latency warnings are not peer-resolution warnings.
- Registry `pnpm run check`: passed peer checks, lint, Host/client typechecks,
  all **37 files / 342 tests**, Host/client build, package smoke and publint.
- A second verbose test run also passed **37 files / 342 tests**.
- Lockfile inspection: **40 DSH package identities**, all `0.2.0-rc.2`;
  no pi-ai package or older DSH prerelease in the resolved graph.
- No live login, OAuth exchange, private endpoint request, user profile install,
  package publication, or DSH core source edit was performed.
- Official tagged-source `pnpm run check:dsh-source`: passed the same complete
  gate, including **37 files / 342 tests**. The shared source build completed
  Host and Client builds and packed 325 official artifacts from the clean fixed
  tag. This plugin's isolated receipt selected **52 artifacts**, including
  **45 DSH packages**, all `0.2.0-rc.2`; local file overrides remain temporary.
- Compatibility guard probes passed: reject three unsupported prerelease
  versions and parse both registry and packed-source lock identities.
