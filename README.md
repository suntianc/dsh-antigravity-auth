# dsh-antigravity-auth

[![npm version](https://img.shields.io/npm/v/dsh-antigravity-auth.svg)](https://www.npmjs.com/package/dsh-antigravity-auth)
[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

English | [中文](README.zh.md)

Use your Antigravity account in [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) for language models, web search, image creation, and experimental video understanding. One shared login also powers the usage dashboard. Cache multiple accounts locally and switch between them manually, with **one active account at a time**.

> **Unofficial, experimental, personal use only.** Google does not support third-party Antigravity login tools; your account may be suspended or terminated. Read the [Google FAQ](https://antigravity.google/docs/faq/) and [Additional Terms](https://antigravity.google/terms) before signing in. Private endpoints can change or stop working without notice. Do not rely on this plugin for production workloads.

**Current release:** `0.1.13` (`latest`). See [Releases](https://github.com/suntianc/dsh-antigravity-auth/releases) and [CHANGELOG](CHANGELOG.md) for version history.

[Quick start](#quick-start) · [Using the capabilities](#using-the-capabilities) · [Account commands](#account-commands) · [Troubleshooting](#troubleshooting) · [Development](#development)

## What it provides

| Capability | DSH entry point |
| --- | --- |
| Language models | `google-antigravity` provider in the model selector, with Gemini, Claude, and GPT-OSS routes subject to account availability |
| Web search | `antigravity` search provider for the stock `web_search` tool |
| Image generation and editing | `generate_image`, plus `list_images` for saved session images |
| Experimental video understanding | `analyze_video` for MP4 files in the active workspace |
| Account and quota status | **Settings → Antigravity**, with five-hour and weekly quota windows and English/Chinese UI |

## Quick start

### 1. Check requirements

- A working DSH installation. The tested development baseline is **DSH `0.2.1-rc.5`**.
- Node.js `^22.19.0` or `>=24.0.0`, and `pnpm` on `PATH` (`11.7.0` is the project's tested version).
- A Google account with Antigravity access.
- A local Host and browser for OAuth. Web account actions require the Host's WebServer to be explicitly bound to **`127.0.0.1`**; the temporary OAuth callback uses **`127.0.0.1:51121`**.

The package does not restrict the DSH peer version range. That allows installation on other versions, but does **not** establish compatibility. See the [verification scope](docs/dsh-source-verification.md).

### 2. Install or upgrade

Stop the Host using the target profile, then run:

```sh
dsh --version
dsh plugin --profile web add --save-exact dsh-antigravity-auth@0.1.13
dsh plugin --profile web list
```

Replace `web` with your actual profile, such as `desktop`. Confirm the listed version, restart that Host (for the Web profile, `dsh web`), and refresh the client.

### 3. Sign in

> **Check networking before signing in:** if you see a “could not sign in safely” error, an authorization timeout, or DSH still fails after browser authorization, see [Network and proxy setup](#network-and-proxy). Where a proxy is required, try Clash / Mihomo TUN mode and keep `127.0.0.1` and `localhost` on a direct route.

1. Open **Settings → Antigravity** and choose **Start Antigravity login**. Starting login records acknowledgement of the unofficial-channel risk above.
2. Complete Google authorization in the browser on the Host machine. If the new tab is blocked, use **Open the Google authorization page** in the settings card.
3. Return to DSH and check the login result. Run `/anti status` for detailed capability status. If authorization expires, cancel it or start a new login.
4. Select an available `google-antigravity` model. In the Antigravity settings cards, enable the Search, Image, or Video capabilities you want to use.

Login and a usable project are required. The normal Host automatically activates capability gates for the account; this is **not a live test of every model or tool**. Actual availability still depends on the account and private backend. A disabled control also needs a writable Host settings scope.

For terminal login, see [Account commands](#account-commands).

## Using the capabilities

- **Models:** choose `google-antigravity` in DSH's model selector. The plugin also registers `google` as an alias when no other provider owns it. Live discovery filters the pinned model catalog; if discovery is temporarily unavailable, the selector may show an advisory snapshot rather than confirmed availability.
  Version 0.1.13 adds Gemini 4 Neon via core `3.1.10`. When the account's live catalog includes Neon, the picker offers Low, Medium, High (default), and XHigh. Hydrogen offers the same tiers. Argon and Carbon offer Low/Medium/High (default Medium), and Claude Opus/Sonnet 5.5 offer Low/Medium/High (default Low). Argon's weekly quota appears separately. Carbon, Hydrogen, and Neon share the Gemini quota group. Gemini 3.5/3.6/3.7 Flash, Gemini 3.1 Pro and Claude 4.6 routes are retired from the catalog. Select a current model for existing sessions. Neon discovery and request routing were verified offline.
- **Search:** select `antigravity` in the Host's **Web Search** provider configuration when multiple providers are installed. Enabling the Antigravity card alone does not replace DSH's selected provider. The stock `web_search` tool then returns grounded results with source links. Search defaults to `antigravity-gemini-3.8-flash`; an explicit model override remains supported.
- **Images:** ask DSH to generate an image, or edit an explicit session image (`image:<id>`) or workspace image. `generate_image` accepts a prompt, up to **5 references**, an optional model, and requests for **1–4 images** (`n`). Partial success can return fewer images with warnings. Images are saved as session attachments and can be found with `list_images`. Dedicated size, aspect-ratio, quality, and transparency parameters are not implemented.
- **Video:** provide an explicit MP4 path inside the active workspace and a question for `analyze_video`. The default and maximum file limit is **32 MiB**. Remote URLs, paths outside the workspace, and symlinks are rejected. The tool sends the MP4 to the private endpoint; it does not implement local frame sampling. This is an experimental POC, not a guarantee of full video, audio, or timeline understanding.
- **Quota:** check the Antigravity settings dashboard for remaining five-hour/weekly limits and reset times. Unavailable or rate-limited quota data is shown as a status, not treated as zero usage.

## Account commands

On interactive DSH surfaces that support slash commands, `/anti` is an alias for `/antigravity-auth`:

```text
/anti status       # Show login and capability status (also the default action)
/anti login        # Start Google OAuth and activate the signed-in account
/anti cancel       # Cancel a pending login
/anti accounts     # List locally cached accounts
/anti switch <id>  # Switch by account index, id, or email
/anti logout       # Log out locally and remove the active account's cached credential
/anti remove <id>  # Remove a cached account; use a remaining account or log out
```

- Successful login caches the account in `accounts.json` and makes it active in `auth.json`. Other cached accounts remain until explicitly removed. There is no automatic rotation or quota pool.
- Local logout removes only that account's local credential; it does not revoke the Google grant. Removing an active cached account can activate another remaining account, or log out when none remains.
- Commands work on a local Host without a WebServer, or with one explicitly bound to `127.0.0.1`. They are blocked when the shared command interface is exposed on another address.
- Terminal login opens the Host's browser and deliberately does not print the authorization URL into persisted session output. It cannot complete the interactive handoff on a headless Host without a usable browser. After browser authorization, run `/anti status`.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Settings section missing, or `loopback-required` | Confirm the plugin is installed in the running profile, restart the Host, and refresh the client. Account RPC requires an explicit `127.0.0.1` WebServer bind; a loopback-looking client URL alone is not enough. Non-loopback connections hide the section. |
| Login does not open a browser | In Settings, use **Open the Google authorization page**. If the link never appears, check the displayed error and confirm the installed version is `0.1.5` or newer. The terminal command has no printed-link fallback. |
| Callback port in use, or authorization expired | Identify the process using `127.0.0.1:51121`; close it only if safe, then start a fresh login. Expired or cancelled authorization links cannot be reused. |
| Logged in, but a capability is unavailable | Check project availability, the capability status, its enabled setting, and the Host settings scope. A successful login is not proof that the backend accepts every capability. |
| Search still uses another provider | Set the Host's Web Search provider to `antigravity`; the plugin preserves the existing selection. |
| Sign-in safety error, connection timeout, `offline`, or proxy connection failure | Follow [Network and proxy setup](#network-and-proxy) below to check Host outbound traffic, loopback bypass rules, and the proxy port. |
| `invalid_grant` / login required or HTTP 403 | Sign in again for an expired/revoked grant. For 403, check account access and the sanitized error details. |
| HTTP 429 / `RESOURCE_EXHAUSTED` | First upgrade to `0.1.11` or newer, which includes the prompt compatibility fix, and restart the Host (see [#47](https://github.com/suntianc/dsh-antigravity-auth/issues/47)). Refresh quota and inspect the error reason and `Retry-After`; wait as directed when the response identifies rate limiting. |
| `protocol-drift`, unsupported video, or an unexpected model error | Private APIs may have changed. Check [Releases](https://github.com/suntianc/dsh-antigravity-auth/releases) and [Issues](https://github.com/suntianc/dsh-antigravity-auth/issues). Include plugin/DSH versions, platform, and the safe error code or HTTP status. Never attach credentials or OAuth URLs. |

<a id="network-and-proxy"></a>

### Network and proxy setup

Sign-in involves three connections: the browser opens Google's authorization page, the browser returns to `127.0.0.1:51121`, and the DSH Host exchanges credentials and contacts Cloud Code. The browser and Host can use different proxy settings, so check each connection separately.

[Network feedback in #47](https://github.com/suntianc/dsh-antigravity-auth/issues/47#issuecomment-6896816447) suggests trying Clash TUN. [The reporter in #27](https://github.com/suntianc/dsh-antigravity-auth/issues/27#issuecomment-5637017374) confirmed that system proxy mode also worked after excluding loopback addresses with `NO_PROXY`. Use the following three options to troubleshoot.

**Option 1: Cover Host traffic with Clash / Mihomo TUN mode**

Enable TUN in your proxy client and check that its rules route Google OAuth and Cloud Code connections through a working exit. Keep `127.0.0.1`, `localhost`, and the local DSH Web address direct. Fully quit and restart the DSH Host, then begin a new sign-in. This is useful when the browser can open the authorization page but the Host times out, or model connections fail after sign-in.

**Option 2: Bypass the proxy for the callback and local DSH UI**

Add `127.0.0.1` and `localhost` to your proxy client's bypass list and set `NO_PROXY` / `no_proxy` in the environment that starts the Host. These examples preserve existing exclusions. Windows PowerShell:

```powershell
$env:NO_PROXY = (@($env:NO_PROXY, $env:no_proxy, "127.0.0.1", "localhost") | Where-Object { $_ }) -join ","
$env:no_proxy = $env:NO_PROXY
dsh web
```

macOS / Linux shell:

```sh
export NO_PROXY="${NO_PROXY:+${NO_PROXY},}${no_proxy:+${no_proxy},}127.0.0.1,localhost"
export no_proxy="$NO_PROXY"
dsh web
```

Start the Host from **the same terminal** where you set the variables. The examples use `dsh web`; for Desktop, fully quit the app and use a launch method that passes these variables to its Host. An already running Host, or an app launched from a desktop icon, does not automatically inherit new variables from another terminal. Check the proxy client's own bypass rules as well, because browsers may not read these environment variables.

**Option 3: Set an explicit HTTP proxy for private requests**

The plugin's private model, quota, project-discovery, search, image, and video requests support HTTP CONNECT proxies. Replace `7890` with your proxy client's actual **HTTP or Mixed port** and retain the loopback exclusions from Option 2. PowerShell:

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
dsh web
```

macOS / Linux shell:

```sh
export HTTPS_PROXY="http://127.0.0.1:7890"
dsh web
```

The lookup order is `HTTPS_PROXY` → `https_proxy` → `ALL_PROXY` → `all_proxy`, using the first defined value; `NO_PROXY` takes precedence over `no_proxy`. This transport accepts `http://` proxy URLs and tunnels HTTPS targets through CONNECT. It does not support `socks5://` / `https://` proxy URLs, read `HTTP_PROXY` alone, or automatically load OS proxy/PAC settings. Check for an older, higher-priority variable overriding your new setting.

OAuth token exchange/refresh and account-info requests use the Host's `fetch`, whose proxy behavior depends on the Host/Node configuration. If the private-request proxy resolves model connectivity but sign-in still times out, check the Host's proxy support or use Option 1 to cover its outbound traffic.

If problems persist, locate the failing phase: check browser networking when the authorization page cannot open; loopback bypass and port `51121` when the callback fails; and Host outbound networking when it times out after the callback. In your proxy client's connection list, check the routing of `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`, `daily-cloudcode-pa.googleapis.com`, and `cloudcode-pa.googleapis.com`.

Report the OS, DSH/plugin versions, launch method, failing phase, proxy mode, and sanitized error. Use the dedicated entry above for HTTP 429. Do not include credential files, proxy passwords, OAuth URLs, or full traffic captures.

## Security and scope

- OAuth uses PKCE S256 and a temporary loopback-only callback. Tokens stay on the Host and are not exposed to the browser, settings, logs, or tool metadata.
- Local account files contain refresh tokens. Protect them: POSIX storage uses owner-only permissions; Windows uses user-data ACLs. Do not share `auth.json`, `accounts.json`, authorization/callback URLs, or raw media payloads in bug reports.
- Refresh, switch, logout, and revoke operations remain bound to the account that started them, so delayed work cannot overwrite a different active account.
- Private requests use fixed approved endpoints and retain truthful DSH attribution through `X-DeepSeek-Harness-Attribution`. This is transport compatibility, not protection from account restrictions.
- The plugin uses public DSH extension interfaces. It does not replace DSH core, offer automatic account rotation, or provide production support.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run check
```

`check` runs peer checks, lint, type checks, offline tests, Host/client builds, package smoke checks, and publint. Live OAuth and private endpoint checks are separate opt-in operations; an offline pass does not verify a real account.

The [bundle patch](cordis.patch.yml) installs four Host rows: `antigravity-auth` (shared authentication and LLM), `antigravity-search`, `antigravity-image`, and `antigravity-video`.

- [Matching DSH source verification](docs/dsh-source-verification.md)
- [Design specification](docs/specs/antigravity-auth-capability-bundle.md) and [research](docs/research/antigravity-auth-plugin.md)
- [Release policy](docs/release-policy.md) and [release notes template](docs/release-notes.template.md)
- [Changelog](CHANGELOG.md) · [GitHub Releases](https://github.com/suntianc/dsh-antigravity-auth/releases) · [Report an issue](https://github.com/suntianc/dsh-antigravity-auth/issues)

## Contributors and acknowledgements

- [@krymov](https://github.com/krymov) identified the browser-context sentence that triggered the reproduced HTTP 429 case in [#47](https://github.com/suntianc/dsh-antigravity-auth/issues/47) and provided the replacement and regression coverage in [PR #48](https://github.com/suntianc/dsh-antigravity-auth/pull/48). The fix was incorporated into `0.1.11`, with additional path/URL protection and local validation, and is retained in subsequent releases.

## License and community

[MIT](LICENSE) · [LINUX DO (L 站)](https://linux.do/)

## Antigravity prompt compatibility

`promptCompatibility` is enabled by default for every model on this plugin's
`google-antigravity` route and its owned `google` alias. It includes the built-in
identity rules of the local `dsh-prompt-compat` plugin and the issue #47 sentence repair:

| Contribution | Replacement |
| --- | --- |
| `harness:identity` section | Replace each `You are an AI agent powered by DeepSeek Harness.` with `You are an AI coding assistant.`, preserving any surrounding instructions. |
| `harness:source` and `app:web-surface` sections | Replace `DeepSeek Harness` with `host application`, preserving quoted absolute paths and URLs. |
| `app:web-surface` browser-context sentence | Replace the exact `The browser provides no implicit DOM, route, or screenshot context.` with `The page provides no implicit markup, route, or capture context.`, preserving quoted paths and URLs. |
| The two identically named runtime contexts | Apply the same replacement and retain it through DSH's admission-time context refresh. |

Paths, GUI URLs, interpolation flags and other instructions are preserved. Other
providers, complete personas, user/project content, tools and stored history remain
unchanged. HTTP attribution remains truthful. This feature adds no prompt logging;
DSH records the assembled input normally.

No route lists, model filters or extra rules need configuring. To disable it, set
`promptCompatibility: false` on the existing `antigravity-auth` row:

```yaml
- id: antigravity-auth
  config:
    promptCompatibility: false
```

The feature uses public SystemPrompt assembly. Calls that skip assembly or change
provider after assembly are outside its scope. Offline checks cover DSH 0.2.1-rc.5. The same minimal implementation was verified
on DSH 0.2.2-rc.3 with Gemini 3.8 Flash / Medium in an existing failed desktop
session: its next turn completed successfully. This repair targets the reproduced
issue #47 sentence refusal; other 429 responses require their own diagnosis.
