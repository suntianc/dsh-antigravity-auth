# dsh-antigravity-auth

> **DSH compatibility:** `0.1.4-rc.5` targets DSH `0.2.0-rc.1` as its minimum and tested development baseline. Use compatible older plugin versions for older DSH Hosts. See [verification](docs/dsh-source-verification.md).

[![npm rc version](https://img.shields.io/npm/v/dsh-antigravity-auth/rc.svg?label=npm%20rc)](https://www.npmjs.com/package/dsh-antigravity-auth)
[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

English | [中文](README.zh.md)

Release: **v0.1.4-rc.5** (npm tag: `rc`).

A self-contained [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
**Antigravity Capability Bundle**. It integrates Antigravity's private OAuth session
and Wire Identity for:

- the `google-antigravity` LLM route (Gemini 3.8/3.7/3.6 Flash, Gemini 3.1 Pro, Claude Opus, Claude Sonnet, GPT-OSS);
- a Global Antigravity Search Provider behind DSH's stock `web_search` tool;
- durable image generation and editing through `generate_image`, plus the model-facing `list_images` catalog;
- multimodal workspace MP4 video understanding through `analyze_video`;
- resilient five-hour and weekly usage/quota visualization dashboard;
- one native **Antigravity Auth** Settings section with Login, Search, Image Creation, and Video cards.

The settings section follows the DSH interface language (English or Chinese), including descriptions, status labels, capability control names, and quota reset text.

> **⚠️ Unofficial channel — personal development only.** The private,
> account-gated Antigravity backend surface is unsupported, revocable, and
> may be rate-limited or changed without notice. Do not rely on it for
> production workloads.

## 0.1.4-rc.5: DSH 0.2.0-rc.1 adaptation

This release updates the DSH dependency graph, registers capability controls through Config Forms and volatile settings, forwards the current Connection RPC operator, and maps V4 role `tool` messages into provider history. The account route keeps its Host-side loopback guard. The complete package and tagged-source checks pass; live account and private transport behavior remain unverified.

## 0.1.4-rc.4: concurrent search cancellation

Fixes #35: if one query in a concurrent `web_search` fails, cancelling the other pending requests no longer emits an unhandled TLS socket error that exits the DSH Host.

## 0.1.4-rc.3: Gemini tool-call ID reuse

Fixes #33: Gemini conversations can continue when a later tool call reuses the ID of a completed call. Ambiguous reuse before the first result and unmatched results still fail explicitly; Claude and GPT-OSS retain their existing validation.

## 0.1.4-rc.2: account switching and Gemini replay fixes

- Adds local account caching and explicit switching through `/antigravity-auth` or `/anti`, with one active account at a time.
- Keeps delayed refresh, logout, and revoke work bound to its original credential, preserving other accounts and their capability state.
- Fixes Gemini thinking/tool signature replay and empty trailing frames; capacity retries apply only to HTTP 503.
- Shows safe failure details and HTTP status in LLM errors. The DSH baseline remains `0.1.5-rc.1`.

## 0.1.4-rc.1: DSH 0.1.5-rc.1 adaptation

Updates development dependencies, peer ranges, package checks, and the matching source verification target to DSH `0.1.5-rc.1`. Existing authentication, model, search, and media contracts remain covered by offline tests.

Moves the development baseline to DSH `0.1.5-rc.1`. Gemini and Claude requests preserve V3 system-message text in `systemInstruction`; one-shot `options.system` remains a preface, followed by system messages in order. Account operations use authenticated `/api/antigravity-auth/*` routes with the existing static loopback guard. Terminal commands keep their existing names.

## v0.1.4-alpha.5 highlights

- Moves the development graph and peer baseline to DSH `0.1.2-alpha.5`, including current Settings, Session, Connection, client-injection, and `ToolCallId` APIs; this repository's lockfile contains no older DSH family.
- Adds authenticated Gemini 3.8 Flash discovery with a Medium default and captured Low/Medium/High routes, model enums, and numeric thinking budgets.
- Realigns every private Cloud Code `v1internal:` operation with the audited AGY CLI 1.1.24 wire identity while retaining mandatory truthful DSH secondary attribution.
- Drains successful provider terminal SSE framing and bodies, then uses the cancellation-safe async-iterable Web Stream bridge to prevent Node `ERR_INVALID_STATE` crashes.
- Keeps account RPC fail-closed on alpha.5: only an explicit `127.0.0.1` Web bind reaches authentication services.

## Features

### Shared Antigravity Login State

- Uses one Host-only auth coordinator for LLM, Search, Image, Video, and Quota operations. Multiple Google accounts may be cached locally; commands activate one of them at a time.
- Direct OAuth 2.0 with PKCE S256: Host memory generates verifier and state handle; the browser receives only the authorization URL.
- The callback listener binds only `127.0.0.1:51121`, accepting only the registered one-shot code/state pair.
- Resolves credentials through versioned owner-only storage (POSIX `0600`; Windows user-data ACLs), short-lived in-memory cache, and proactive refresh before expiry.
- Coalesces concurrent refreshes in-process and enforces account/lineage consistency before persisting refreshed tokens.
- Shows connection state plus real-time visual progress bars for 5-hour and weekly quotas across Gemini and Claude/GPT model families.
- Sends no token value over `/api/antigravity-auth/*`. On DSH alpha.5, the real account dispatcher is mounted only for an explicit `127.0.0.1` Web bind; an absent, all-interface, or unknown bind receives an inert value-free denial handler.

### LLM Routing & Models

- Registers the `google-antigravity` provider through DSH's public `LlmAdapter` seam.
- Intersects the audited `@cortexkit/antigravity-auth-core@2.2.0` model snapshot with live account discovery, normalizing the provider's `gemini-3.8-flash-tiered` directory alias. Gemini 3.8 Flash uses the captured AGY 1.1.24 Low/Medium/High wire routes, numeric thinking budgets, model enums, `userAgent` envelope field, and Medium default.
- Keeps DSH's stock model selector usable when live discovery is temporarily unavailable or drifts by falling back to the pinned text snapshot; Settings still reports the live-catalog state. This advisory fallback can temporarily retain a legacy route such as Gemini 3.5 Flash, while a successful live intersection filters routes absent for the account. A successful empty intersection stays empty, while missing authentication, authorization denial, cancellation, and explicit attribution rejection remain fail-closed.
- Supports streaming with pre-delta authentication replay and preserve-by-id function call correlation across fragmented provider names. Successful terminal events drain the remaining SSE framing before DSH completion, while required cancellation paths use Node's async-iterable Web Stream bridge instead of the race-prone `Readable.toWeb()` adapter.

### Web Search

The `antigravity-search` Host row registers provider ID `antigravity` through
`@deepseek-ai/dsh-web`. Grounded web search requests are formatted and dispatched through
the audited Wire Identity dispatcher. Results include the generated output and deduplicated,
validated HTTP(S) source references.

### Image Creation & Editing

`generate_image` presents a unified operation dispatching to Antigravity image endpoints:

- Supports prompts, up to five explicit references (session handle `image:<id>` or workspace path), and size/aspect controls.
- Generated image bytes are validated, decoded, signature-checked, and persisted via `AttachmentStore`.
- `list_images` provides paginated session image catalogs for image-capable models.

### Video Understanding

Multimodal `analyze_video` tool accepts workspace MP4 videos, performing bounded frame sampling and textual comprehension.

### Usage & Quota Visual Dashboard

- Renders real-time progress bars for 5-Hour and Weekly limit windows.
- Reset countdowns of at least 24 hours show days, hours, and minutes (for example, `94h 43m` becomes `3d 22h 43m`; Chinese uses `3天 22h 43m`). Shorter countdowns retain the hour/minute format.
- Clear status tiers: Normal (>60%, emerald green), Warning (30%–60%, amber), and Low (<30%, coral red).
- Elegant loading shimmer tracks and querying spinner animations.

## Requirements

- DeepSeek Harness `0.2.0-rc.1` (tested coherent dependency graph).
- Node.js `^22.19.0` or `>=24.0.0`.
- `pnpm` available on `PATH` (`11.7.0` is the tested project package manager).
- A Google account with Antigravity access.

## Install

Stop `dsh web`, ensure the target Host uses a coherent DSH `0.2.0-rc.1` graph, then install this exact prerelease into the intended profile:

```sh
dsh --version
dsh plugin --profile web add --save-exact dsh-antigravity-auth@0.1.4-rc.5
dsh plugin --profile web list
```

Verify the entry, restart `dsh web`, and refresh the browser. This version uses the npm `rc` tag. An install without a version or tag selects `latest`, which does not include this DSH 0.2 adaptation. Older DSH Hosts should retain a compatible older plugin release.

## Terminal login command

On interactive surfaces that host the DSH `commands` seam, the bundle registers an `antigravity-auth` slash command as an alternative to the Web settings card:

```text
/antigravity-auth              # show current login state (default)
/antigravity-auth accounts     # list locally cached accounts
/antigravity-auth switch <id>  # activate a cached account by index, id, or email
/antigravity-auth login        # start the Google OAuth authorization flow
/antigravity-auth cancel       # cancel a pending authorization
/antigravity-auth logout       # sign out the active account and drop its cached credential
/antigravity-auth remove <id>  # drop one cached account (signs out if it was active)
```

`/anti` is the same command. Successful `login` writes the new credential into the local account cache (`accounts.json`) and makes it active in `auth.json`. Only one account is active at a time; other cached refresh tokens stay on disk until `logout` or `remove` targets that account. `logout` and an explicit Web revoke clear Host memory and `auth.json`, then delete **only** the account that started the operation. A revoke that the coordinator marks `superseded` (for example because you switched accounts while Google's revoke request was in flight) does not delete the newly active account. Refresh-token rotation and optional userinfo email backfill are bound to the account identity captured at the start of that operation, not to the display email or whichever account is active when the result arrives.

Account operations are the terminal login entry point: they run on a local DSH Host (no WebServer at all, or one bound explicitly to `127.0.0.1`) and are denied before touching the auth service only when the WebServer exposes the shared `commands` seam on any other interface. The account RPC keeps its own stricter ADR-0008 guard (a real dispatcher on the explicit `127.0.0.1` bind only).

`login` acknowledges the unofficial-channel risk note and starts the loopback OAuth flow, whose temporary callback listener binds `127.0.0.1:51121` independently of any DSH WebServer. The command then opens the Google sign-in page in your default browser with a best-effort platform opener; the authorization URL is **not** echoed into the command result, because `CommandResult.text` is persisted verbatim into the session's `command/done` event and the URL carries the OAuth state handle and PKCE challenge. On Windows the opener is `cmd /c start "" "<url>"` with the URL quoted and Node's argument rewriting disabled, so every `&`-separated OAuth parameter reaches the browser intact. If the opener cannot start, the command reports that failure without reproducing the URL. Complete sign-in in the browser, then run `/antigravity-auth status`. Tokens, verifier, codes, and callback URLs never appear in command output or the session log. DSH exposes no public transient-presentation or browser-launch API for plugins, so on a Host without a desktop browser the interactive handoff cannot complete from the terminal.

## Host configuration

The bundle patch activates independent Host rows in dependency order:

| Row | Export | Purpose |
|---|---|---|
| `antigravity-auth` | `dsh-antigravity-auth` | Shared auth coordinator and LLM route |
| `antigravity-search` | `dsh-antigravity-auth/search` | Global Search Provider |
| `antigravity-image` | `dsh-antigravity-auth/image` | Image generation & editing tools |
| `antigravity-video` | `dsh-antigravity-auth/video` | Video understanding tools |

## Wire Identity

The Wire Identity module keeps the audited AGY CLI 1.1.24 content-request User-Agent and adds the truthful DSH identity returned by DSH's public `attributionHeaders()` formatter as the mandatory secondary carrier:

```text
X-DeepSeek-Harness-Attribution: deepseek-harness/<version> (+repository-url)
```

Requests are code-owned: only fixed HTTPS Antigravity origins and enumerated `v1internal:` operation paths are accepted.

## Security and limitations

- Token values never enter the browser, settings, logs, session events, or tool metadata. Only Host-side requests receive authorization headers.
- POSIX owner-only modes are enforced for auth, gate-evidence, and controlled live-image files. Windows access is governed by ACLs, so synthetic POSIX group/other bits are not treated as an access decision; symlink, file-type, size, schema, and content checks remain enforced.
- Local multi-account cache with manual switch: `accounts.json` may hold several refresh tokens; `auth.json` holds only the active record. There is no quota pool, automatic account rotation, identity fallback, or fingerprint regeneration.
- Local logout clears Host memory and `auth.json`, then removes that account's cached credential so `switch` cannot restore it. Other cached accounts are left in place. Revoke is a separate explicit action and follows the same per-account cleanup; `superseded` does not authorize deleting a different active account.
- Switching while an earlier refresh, logout, or revoke is waiting preserves the new account's credentials and capability state. A delayed cleanup only removes the original credential; it cannot remove a newer login of that account.
- DSH alpha.5 no longer exposes a per-method or Host-side carrier authority tier. The plugin therefore enables the real account RPC handler only when the public WebServer bind is exactly `127.0.0.1`; absent, all-interface, and unknown binds receive only `loopback-required`. The browser also hides the section when `ConnectionHandle.isLoopback` is false, but that client hint is UX only: an owner-contained custom carrier cannot be authorized until DSH exposes a corresponding Host-side fact.
- Raw media base64 never enters session text or browser RPC.

## Development

Maintainers: follow the [release policy](docs/release-policy.md) and [release notes template](docs/release-notes.template.md) for consistent titles, bilingual notes, channels, and publication verification.

```sh
pnpm install
pnpm peers check
pnpm test
pnpm run check
```

`pnpm run build` emits:

- `lib/index.js` — Auth / LLM Host plugin;
- `lib/search.js` — Search Host plugin;
- `lib/image.js` — Image Host plugin;
- `lib/video.js` — Video Host plugin;
- `lib/quota.js` — Quota Host plugin;
- `lib/wire-identity.js` — Wire Identity Host module;
- `lib/client.cjs` — Loader-compatible browser settings plugin;
- `lib/types/**` — TypeScript declarations.

## Friendship links

- [LINUX DO (L 站)](https://linux.do/)
