# Changelog

## [0.1.4-rc.5] - 2026-09-28

- Align the plugin and its dependency graph with DSH `0.2.0-rc.1`, Cordis `4.0.4`, and Schemastery `3.18.4`.
- Migrate capability controls to Config Forms and volatile settings, forward the Connection RPC operator, and map V4 role `tool` messages to provider history.
- Verify with the full package gate and artifacts built from the official DSH source tag; real account and private transport flows remain unverified.

## [0.1.4-rc.4] - 2026-09-25

- Fix #35: cancelling pending concurrent web searches no longer emits an unhandled TLS socket error that terminates the DSH Host. Cancellation errors still return to callers and affected sockets close.

## [0.1.4-rc.3] - 2026-09-20

- Fix #33: allow Gemini to reuse a completed tool-call ID for a later tool while preserving each result's original function name. Reject IDs reused before their result and orphan/duplicate results; retain Claude and GPT-OSS history validation.

## [0.1.4-rc.2] - 2026-09-20

- Preserve Gemini thinking/tool signatures and replay block alignment across empty trailing frames, repair truncated historical tool arguments, and limit capacity retries to HTTP 503; HTTP 429 and other statuses are not retried.
- Fix account-switch races during refresh, logout, and revoke: each operation retains its credential snapshot, stale cache updates and removals are rejected, and cleanup preserves the new account's capability evidence.
- Private LLM transport failures now surface a safe failure kind and HTTP status (for example `protocol drift (HTTP 400)`) instead of the opaque "failed safely" card. Gemini thinking-signature replay remains as landed in #29.
- Caches multiple Antigravity Google accounts locally and activates one at a time through `/antigravity-auth` (`/anti`) `accounts`, `switch`, `login`, `logout`, and `remove`. Refresh-token rotation, logout/revoke cleanup, and userinfo email backfill bind to the account that started the operation, so a late result cannot overwrite or delete a different active account.

## [0.1.4-rc.1] - 2026-09-10

- Completes English settings descriptions, localizes the ready status and capability control labels, and uses natural English/Chinese quota reset word order. Adds dictionary and language-switching regression coverage.

- Shows quota reset countdowns of at least 24 hours in localized days, hours, and minutes (`3d 22h 43m` / `3天 22h 43m`), preserving shorter and expired countdowns. Fixes #24.

- Updates development dependencies, peer ranges, package checks, and the matching source verification target to DSH `0.1.5-rc.1`. Existing authentication, model, search, and media contracts remain covered by offline tests.
- Moves the development baseline to DSH `0.1.5-rc.1`. Gemini and Claude requests preserve V3 system-message text in `systemInstruction`; one-shot `options.system` remains a preface, followed by system messages in order. Account operations use authenticated `/api/antigravity-auth/*` routes with the existing static loopback guard. Terminal commands keep their existing names.

- Added an `antigravity-auth` slash command (`status` default, `login`, `cancel`, `logout`) on surfaces that host the DSH `commands` seam. Account operations are the terminal login entry point: they run on a local DSH Host (no WebServer, or an explicitly `127.0.0.1`-bound one) and are denied before touching the auth service whenever the WebServer exposes the shared commands seam on another interface. `login` opens the Google sign-in page in the default browser (best-effort platform opener) and never echoes the authorization URL (state handle and PKCE challenge) into persisted command results or the session log. The Windows opener passes the URL quoted and verbatim to `cmd /c start`, so every `&`-separated OAuth parameter reaches the browser, and a failed browser launch is reported without reproducing the URL. A pending authorization no longer blocks `login`: the command cancels the previous flow and starts a fresh PKCE exchange, matching the Web settings card, so an abandoned browser handoff can be retried immediately instead of waiting out the five-minute TTL.
- Fixed capability registration after a successful browser login. The OAuth loopback callback commits the credential without passing through the public `completeCallback` wrapper, so the committed state was never published to status listeners and the LLM provider plus Search/Image/Video routes stayed unregistered until the Host restarted. The commit point now notifies status listeners, so the running Host registers those routes immediately.

## [0.1.4-alpha.6] - 2026-09-07

- Add explicit DSH `0.1.3-alpha.1` source compatibility alongside the npm alpha.5 baseline; keep dependency graphs separate.
- Add reproducible isolated source-package checks and coherent lockfile validation.

## [0.1.4-alpha.5] - 2026-09-03

- Raised the development and peer baseline to DSH `0.1.2-alpha.5`, Cordis `4.0.2`, and Schemastery `3.18.2`, with one coherent prerelease dependency graph.
- Migrated tool-call IDs, Settings registration, Session event reads, Connection result types, browser Context owners, and client injection metadata to alpha.5 public APIs; removed the retired client-runtime and Host apiproxy packages.
- Preserved fail-closed account controls after alpha.5 removed per-method RPC authority: only an explicit `127.0.0.1` Web bind uses the real dispatcher; absent, all-interface, and unknown binds receive an inert value-free denial, while non-loopback clients hide the settings section.
- Updated the audited community core snapshot to `2.2.0`, normalizing the live `gemini-3.8-flash-tiered` directory alias so Gemini 3.8 Flash survives live intersection with its native Medium default and captured Low/Medium/High wire routes and request metadata.
- Realigned private requests with the audited AGY 1.1.24 wire identity and envelope: the fixed CLI User-Agent replaces obsolete desktop/X-Goog metadata headers while preserving the mandatory DSH secondary attribution, and Gemini 3.8 sends captured numeric thinking budgets plus the `userAgent` field.
- Drained successful SSE bodies after provider terminal events and replaced Node's race-prone `Readable.toWeb()` bridge with its async-iterable Web Stream bridge, preventing legitimate response cancellation from crashing the Host with `ERR_INVALID_STATE`.
- Refreshed the release README with current Gemini 3.8 behavior, exact prerelease/tag/tarball installs, the real Host row ID, and no obsolete rc.2 migration warnings.

## [0.1.3] - 2026-08-31

- Restored reliable Claude Opus tool selection by preserving the complete DSH system prompt and applying the audited Claude tool instruction, strict parameter descriptions, and validated function-calling mode.
- Fixed Claude continuation after parallel tool execution by preserving call/response IDs, applying the safe thought-signature sentinel, dropping unsigned reasoning replay, and grouping correlated function responses.
- Mapped exact bounded Antigravity context-window overflow responses into DSH compaction recovery while retaining fail-closed parsing, timeout, response-size, frame-size, depth, and redaction limits.

## [0.1.2] - 2026-08-27

- Kept the Antigravity provider visible in DSH's stock model catalog during explicitly allowlisted transient live-discovery failures by falling back to the audited pinned text snapshot.
- Preserved fail-closed handling for missing authentication, authorization denial, cancellation, attribution rejection, unknown failures, and successful live catalogs with no supported-model intersection.

## [0.1.1] - 2026-08-25

- Fixed Windows reads of auth, capability-gate, and controlled live-image records by applying `0700`/`0600` mode rejection only on POSIX while retaining symlink, file-type, size, schema, and content validation on every platform.
- Raised the minimum and tested DSH package baseline to `0.1.1-rc.2` and regenerated one coherent rc.2 dependency graph.
- Confirmed that rc.2's additive LLM preparation and normalized request-image pipeline preserve the plugin's public seams; Antigravity keeps its private transport and existing `AttachmentStore.readImage()` path rather than adopting DeepSeek Files API behavior.

## [0.1.0] - 2026-08-22

- Removed callback-URL submission from browser RPC, added closed value-free RPC error validation, and made every settings action abort with component lifetime.
- Replaced private-endpoint `fetch` dispatch with a plugin-owned TLS/raw HTTP/1.1 serializer that fixes ordered audited `agy` framing and mandatory truthful DSH secondary attribution.
- Added credential-lineage-fenced, value-free Gate 0/L/S/I/V and independent atomically persisted Gemini/Claude/GPT-OSS outcomes; Auth/LLM is derived directly from all three rather than a separately writable aggregate pass.
- Added an explicitly acknowledged, one-gate-at-a-time packed `live:gates` harness that remains outside default checks, does not construct credential/network services before opt-in, and persists Gate I outputs through an owner-only content-addressed AttachmentStore seam after bounded PNG chunk/CRC/zlib/pixel admission.
- Exposed pinned snapshot, live-available, unavailable, refresh-failed, and protocol-drift model states while keeping exact pinned-model requests independent from advisory catalog absence; fixed call-id-correlated tool-result names and fragmented function-call assembly.
- Changed multi-image generation to independent no-retry requests with partial-success warnings, validates declared MIME against admitted bytes, and rechecks workspace target identity/version around bounded image/video reads.
- Made each Gate 0/L or selected family run one catalog-free request, distinguished generic forbidden failures from attribution rejection, made Gate V require an exact deterministic pixel-only fixture answer, and fenced replacement logins from prior-account gate evidence.
- Added the public Antigravity `LlmAdapter` with pinned/live-intersected model discovery, bounded SSE/JSON translation, pre-delta auth replay, and bounded provider replay metadata.
- Added grounded Web Search, AttachmentStore-backed image generation/edit/list tools, workspace media admission, quota/usage normalization, and the gated MP4 video understanding POC.
- Added Host settings namespaces, client SettingsScope toggles, quota-safe usage UI, and shared single-account service lifecycle wiring.
- Added offline transport, replay, quota, media, search, and adapter fixtures; package exports now include the bounded Host capability modules.
- Added fixed, read-only `loadCodeAssist` project discovery through the centralized Wire Identity policy; only normalized project metadata can gate and replace a single-account credential.
- Added distinct safe project discovery states for unavailable, authentication, forbidden, rate-limited, offline, malformed, and protocol-drift outcomes; no onboarding or fallback project is attempted.
- Raised the minimum and tested DSH package baseline to `0.1.1-rc.1`, regenerated a coherent rc.1 lockfile, and added peer-graph verification before the full offline check.
- Confirmed that the rc.1 credentials/authorization, session-projection, client boot, and sandbox changes require no current Antigravity behavior migration; plugin-owned auth and Wire Identity modules remain unchanged.
- Added the offline-verifiable Host-only single-account PKCE S256 login path with a strict loopback callback listener.
- Added one-shot state expiry/cancellation, fixed-port conflict handling, remote callback URL submission, and safe value-free login status RPC results.
- Added injected project validation and versioned owner-only atomic persistence; access tokens remain Host memory and failed validation preserves the existing account.
- Added pending, success, cancelled, expired, port-conflict, and safe failure settings states in English and Chinese.
- Added independently addressable, gate-visible Auth/LLM, Search, Image, and Video rows.
- Retained the plugin-owned Wire Identity seam and its fixed provider-attribution policy.
