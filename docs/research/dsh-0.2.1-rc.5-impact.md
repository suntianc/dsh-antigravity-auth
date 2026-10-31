# DSH 0.2.1-rc.5 plugin impact assessment

## Fixed inputs

- Plugin starting point: `b74b6d60bd3992d13cb94b0b2ee727a120528409`
  (`dsh-antigravity-auth@0.1.4-rc.6`).
- Previous official source tag: `dsh-v0.2.0-rc.2`, commit
  `639ed015397290b3745d163aafe02ffee4aa3f84`.
- Target official source tag: `dsh-v0.2.1-rc.5`, commit
  `b830ec950faba0a46dda564be3e2d854afed94f1`.
- The target published DSH graph uses Cordis `4.0.5` and Schemastery
  `3.18.5`. The plugin's private Antigravity core remains at `2.2.0`.
- `@deepseek-ai/dsh-invariants` has no target source package or published
  `0.2.1-rc.5` version. The plugin does not import it; its stale peer and
  development dependency must be removed rather than mixed into the graph.

## Installation reproduction

On macOS, the installed DSH `0.2.1-rc.5` was run with a disposable `DSH_HOME`
and no existing profile or credential store. `dsh plugin --profile
issue42-repro add dsh-antigravity-auth@latest` selected `0.1.3` and failed
with the version-admission error in issue #42. Installing `0.1.4-rc.6` into
the same disposable profile succeeded and its four plugin rows appeared in
the generated configuration. The profile install emitted missing-peer
warnings; it is not a substitute for the clean development-graph peer check.
The schema dump imported the configured modules but did not start a profile or
exercise OAuth, private endpoints, or an authenticated browser session.

## Public-seam changes requiring verification

- Connection removed `HostConnectionHandle.operator` and exposes separate
  authenticated peers. Exact Fetch routes receive owner traffic, but their
  callback does not receive the admitted peer. The plugin's account route
  currently forwards the removed `operator` property. Its migration must use
  a public, request-bound admission result and retain the plugin-owned static
  loopback guard. Test authenticated, unauthenticated, rejected-origin, and
  non-loopback cases against a real Connection/WebServer composition.
- WebRuntime now reads its volatile provider selection per operation. The
  previous implementation's `searchProviderId` field is no longer consulted.
  The plugin must use the public provider-registration seam and preserve the
  Host's explicit selection; test single-provider automatic selection,
  explicit selection, ambiguity, and unregistration using the real runtime.
- The LLM adapter and attribution interfaces remain present, with additions
  to image targets and call configuration. Confirm generation, replay,
  image, and AgentLoop behavior through existing public-seam tests rather
  than assuming source compatibility from an unchanged export name.
- Config Forms and volatile settings remain present, but Connection, client
  settings, session, and AgentLoop implementations changed. Run Host/client
  typechecks and the existing lifecycle, account, search, and settings tests.

## Required evidence

- A coherent registry dependency graph with no peer-resolution warnings and
  the complete offline `pnpm run check` gate.
- The same gate against artifacts built from the fixed official source tag,
  using the isolated source-verification workflow and recording its receipt.
- A packed plugin installation and module-loading check using a disposable
  DSH 0.2.1-rc.5 profile. Live OAuth, private endpoints, Windows Desktop, and
  any non-target DSH version remain separate verification boundaries.

## Verification results

- macOS arm64, Node `22.23.4`, pnpm `11.7.0`: the registry dependency graph
  passed `pnpm peers check` and the complete `pnpm run check` gate, including
  **37 files / 354 tests**, Host/client typechecks, build, package smoke, and
  publint.
- Built Host and client packages from the fixed DSH source commit above;
  the isolated source check selected 52 artifacts, including 45 DSH packages
  at `0.2.1-rc.5`, and passed the same complete gate with **37 files / 354
  tests**. The source checkout had no tracked changes after the build.
- Installed a local candidate tarball into a disposable profile of the
  installed DSH `0.2.1-rc.5`. The install succeeded with missing-peer
  warnings in that profile. Schema export loaded all four capability rows.
  In a separate disposable Web profile, the Host served its page and the
  account status RPC; an anonymous request received 401 and an authenticated
  request received 200 with a successful, logged-out status.
- No existing DSH profile, live account, OAuth exchange, Antigravity private
  endpoint, or Windows environment was exercised by these checks.
