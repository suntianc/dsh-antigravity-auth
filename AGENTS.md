# dsh-antigravity-auth Agent Guide

This file supplements the workspace-level `AGENTS.md`. The workspace guide remains authoritative for shared plugin, Git, verification, and delivery rules.

## Project identity

- Command target: `dsh-antigravity-auth`
- Local development root: `/Users/suntc/project/dsh-plugins/dsh-antigravity-auth`
- Canonical Git origin: `git@github.com:suntianc/dsh-antigravity-auth.git`
- GitHub repository: `https://github.com/suntianc/dsh-antigravity-auth`
- Issue tracker: `https://github.com/suntianc/dsh-antigravity-auth/issues`
- Parent implementation spec: GitHub issue `#1`
- Canonical local spec: `docs/specs/antigravity-auth-capability-bundle.md`
- Canonical research report: `docs/research/antigravity-auth-plugin.md`

The repository and issue tracker are public, while the integrated Antigravity backend surface is private and unofficial. Do not publish, change visibility, push, install into a live profile, or run live OAuth/private endpoint probes unless the user explicitly requests that separate action.

## DSH compatibility baseline

- The minimum and tested DSH package baseline is `dsh-v0.2.0-rc.1` (`0.2.0-rc.1` on npm). The upgrade impact source is `docs/research/dsh-0.2.0-rc.1-impact.md`.
- DSH peer dependencies use `^0.2.0-rc.1`; development dependencies and the lockfile resolve the exact `0.2.0-rc.1` line with Cordis `4.0.4` and Schemastery `3.18.4`. Do not reintroduce older or mixed DSH prerelease families.
- A clean install must pass `pnpm peers check`, followed by the full offline `pnpm run check` gate. Treat peer-resolution warnings as failures rather than suppressing them.
- The public `LlmAdapter`, `ctx.llm`, client injection, Cordis patch, and `attributionHeaders()` seams remain in use. Settings registration uses Config Forms and volatile values; V4 requests carry tool responses as role `tool` messages. Account RPC stays behind the plugin-owned static loopback guard: only an explicit `127.0.0.1` Web bind reaches the real dispatcher; an absent, all-interface, or unknown bind receives the inert `loopback-required` handler.
- Every future DSH prerelease-line bump requires a new plugin impact assessment before changing package ranges. Upgrade the development baseline as one coherent graph; do not mix prerelease families.
- Credential lifecycle Issue `#5` is implemented at `dbc8783`, and the one-time rc.1 migration Issue `#17` (`[05A]`) is implemented at `efa4aaa`. The capability series through Issue `#16` is implemented on `main`; later repairs must preserve the scope of the already completed bootstrap Issue `#3`.

## Required session startup

For every implementation, review, spec, or ticket command targeting this project:

1. Set this project root as the working directory before running any command.
2. Verify `git rev-parse --show-toplevel` equals the local development root above; a parent repository is never acceptable.
3. Verify `git remote get-url origin` resolves to the canonical origin above. Do not infer, create, or rewrite a remote.
4. Fetch the requested issue from this repository, including comments and its parent issue/spec.
5. Read this guide, the parent spec, relevant research, current Git status, package metadata/README/patch when present, and relevant tests before editing.
6. Confirm every intended changed file is inside this repository. A path outside the project root is a hard scope error.
7. Preserve unrelated local files and user changes; this repository may initially contain uncommitted research/spec documents.

If any verification fails, stop and report the mismatch before changing files.

## Plugin-only implementation scope

- All implementation for this project belongs in this repository.
- Do not modify, fork, replace, commit to, or patch DeepSeek Harness core, the globally installed DSH checkout, another plugin, `node_modules`, generated DSH bundles, or a user profile.
- An issue in this tracker cannot authorize a DSH core change, even if its text mentions a missing core seam. Correct or split the issue instead of leaving the project.
- Register the Antigravity provider through existing public DSH plugin seams and a plugin-owned `LlmAdapter`; do not replace the `ctx.llm` runtime.
- The plugin-owned Wire Identity module keeps the fixed audited `agy` User-Agent/framing and obtains the truthful DSH identity value from public `attributionHeaders()`, carrying it in `X-DeepSeek-Harness-Attribution`.
- LLM, Search, Image, Video, Quota, and project discovery must share that one Host-only identity module; callers must not construct identity headers independently.
- OAuth credentials and secret-bearing network requests stay Host-side. Browser, RPC, settings, logs, fixtures, and session text never receive tokens, codes, verifiers, cookies, callback URLs, or media base64.
- The product caches multiple Google accounts locally and activates one at a time through explicit switch/login/logout/remove. Do not add quota pools, automatic account rotation, identity fallback, fingerprint regeneration, automatic onboarding, or a fallback project. Refresh, logout, revoke, and email backfill must stay bound to the account that started the operation.
- Default development and `pnpm run check` are offline. Live OAuth and private endpoint calls always require a new explicit user authorization.

## Slash-command examples

Use the workspace command target explicitly in new sessions:

```text
/implement dsh-antigravity-auth #issue2
/code-review dsh-antigravity-auth main #issue2
/to-spec dsh-antigravity-auth
/to-tickets dsh-antigravity-auth #issue1
/research dsh-antigravity-auth <topic>
```

- `#issue2` and `#2` both mean issue 2 in this repository only.
- `/implement dsh-antigravity-auth #issue2` means implementation may change only this project root; it never means “follow issue text into deepseek-harness.”
- `/code-review` additionally requires an explicit fixed point such as `main` or a commit SHA and a non-empty three-dot diff.
- A full issue URL is accepted only when it belongs to `suntianc/dsh-antigravity-auth`.

## Current source-of-truth correction

Issue `#2` is plugin-only and owns the plugin Wire Identity module. Any prior experiment that implemented issue `#2` in DeepSeek Harness core is out of scope and must be reverted or excluded. The updated issue body, parent issue `#1`, local spec, and this guide supersede the earlier core-scope interpretation.

## Delivery report

Every handoff must state:

- local development root and canonical origin;
- issue number and parent spec;
- branch and fixed point when reviewing;
- changed files;
- tests/checks executed;
- whether any live account, profile, remote, commit, push, publish, or deployment action occurred.

## Release conventions

- Before preparing any release, read `docs/release-policy.md` and fill `docs/release-notes.template.md`; these define the canonical title, body layout, channel mapping, and completion checks.
- The GitHub Release title is exactly `<package.name> v<package.version>`, with no appended theme. Preserve the template's metadata table, five section headings, order, and bilingual correspondence.
- A complete publication requires the pushed source and annotated tag, a public non-draft GitHub Release with the verified artifact, and the matching npm version/dist-tag. Report each result separately; a tag, draft, or successful CLI exit alone is insufficient.
- Keep immutable-artifact and Passkey handling in the workspace npm publication skill. Do not treat this format policy as new authorization to publish, rewrite historical releases, or install into a live profile.

## Matching source verification

DSH `0.2.0-rc.1` at `4878cdabd87d4041bdaff61d04c966883b9fd07a` is the matching source target for the published npm baseline. Use the isolated workflow in `docs/dsh-source-verification.md`; run both `pnpm run check` and the source check when changing compatibility-sensitive behavior. Keep the complete dependency graph coherent. Older release graphs are historical evidence, not the current development baseline.
