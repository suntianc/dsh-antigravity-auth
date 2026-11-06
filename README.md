# dsh-antigravity-auth

[![npm version](https://img.shields.io/npm/v/dsh-antigravity-auth.svg)](https://www.npmjs.com/package/dsh-antigravity-auth)
[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

English | [中文](README.zh.md)

Use your Antigravity account in [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) for language models, web search, image creation, and experimental video understanding. One shared login also powers the usage dashboard. Cache multiple accounts locally and switch between them manually, with **one active account at a time**.

> **Unofficial, experimental, personal use only.** Google does not support third-party Antigravity login tools; your account may be suspended or terminated. Read the [Google FAQ](https://antigravity.google/docs/faq/) and [Additional Terms](https://antigravity.google/terms) before signing in. Private endpoints can change or stop working without notice. Do not rely on this plugin for production workloads.

**Current release:** `0.1.5` (`latest`). See [Releases](https://github.com/suntianc/dsh-antigravity-auth/releases) and [CHANGELOG](CHANGELOG.md) for version history.

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
dsh plugin --profile web add --save-exact dsh-antigravity-auth@0.1.5
dsh plugin --profile web list
```

Replace `web` with your actual profile, such as `desktop`. Confirm the listed version, restart that Host (for the Web profile, `dsh web`), and refresh the client.

### 3. Sign in

1. Open **Settings → Antigravity** and choose **Start Antigravity login**. Starting login records acknowledgement of the unofficial-channel risk above.
2. Complete Google authorization in the browser on the Host machine. If the new tab is blocked, use **Open the Google authorization page** in the settings card.
3. Return to DSH and check the login result. Run `/anti status` for detailed capability status. If authorization expires, cancel it or start a new login.
4. Select an available `google-antigravity` model. In the Antigravity settings cards, enable the Search, Image, or Video capabilities you want to use.

Login and a usable project are required. The normal Host automatically activates capability gates for the account; this is **not a live test of every model or tool**. Actual availability still depends on the account and private backend. A disabled control also needs a writable Host settings scope.

For terminal login, see [Account commands](#account-commands).

## Using the capabilities

- **Models:** choose `google-antigravity` in DSH's model selector. The plugin also registers `google` as an alias when no other provider owns it. Live discovery filters the pinned model catalog; if discovery is temporarily unavailable, the selector may show an advisory snapshot rather than confirmed availability.
- **Search:** select `antigravity` in the Host's **Web Search** provider configuration when multiple providers are installed. Enabling the Antigravity card alone does not replace DSH's selected provider. The stock `web_search` tool then returns grounded results with source links.
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
| `invalid_grant` / login required, HTTP 403, or HTTP 429 | Sign in again for an expired/revoked grant. For 403, check the account's access; for 429, wait for the quota/rate limit to recover. The plugin does not rotate accounts to bypass limits. |
| `protocol-drift`, unsupported video, or an unexpected model error | Private APIs may have changed. Check [Releases](https://github.com/suntianc/dsh-antigravity-auth/releases) and [Issues](https://github.com/suntianc/dsh-antigravity-auth/issues). Include plugin/DSH versions, platform, and the safe error code or HTTP status. Never attach credentials or OAuth URLs. |

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

## License and community

[MIT](LICENSE) · [LINUX DO (L 站)](https://linux.do/)
