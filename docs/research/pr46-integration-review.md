# PR #46 integration review — 2026-11-17

- Repository: `suntianc/dsh-antigravity-auth`; parent specification: #1.
- Reviewed PR: https://github.com/suntianc/dsh-antigravity-auth/pull/46 (related #45).
- Main fixed point: `bc8e9620acc0a3f62bbf5b9e7ecf9dbc089cca08` (0.1.11).
- PR head: `c3c738cd76a49ed31b9ebeb4d62c838ae2815b91`.
- Integration branch: `integrate/pr46-gemini4`, isolated worktree `.pr46-integration`.

## Integrated behavior

Core is pinned to 3.1.2 in dependencies, development dependencies and lockfile.
The public catalog adds Gemini 4 Argon/Carbon/Hydrogen and Claude Opus/Sonnet
5.5, and removes the retired Gemini 3.5/3.6/3.7 Flash, Gemini 3.1 Pro and Claude
4.6 routes. Argon has a separate weekly quota group; Carbon/Hydrogen share the
Gemini quota group. Gemini 4 uses tier suffixes with no explicit thinkingConfig.
The core upgrade also changes the shared CLI identity and request-session
metadata API. Plugin transport and public DSH integration seams are retained.

## Findings fixed during integration

1. The fork version 0.1.8-fork.1 conflicted with main's 0.1.11. Keep package
   version 0.1.11 and place the new changes in Unreleased.
2. The prompt integration reroute fixture used retired Gemini 3.7. Move it to
   Gemini 4 Carbon while preserving the assertions for browser sentence
   rewriting, quoted paths, URLs and untouched user content. The prompt
   compatibility implementation and its dedicated unit test file are unchanged
   from main.
3. Claude 5.5 had no effort selector and explicit High still resolved to Low.
   Expose Low/Medium/High, default Low, and apply the selected tier to both the
   request route and model metadata. Both Opus and Sonnet are tested through
   the public LLM runtime with mock transport.
4. Live discovery expanded new model families only from catalog keys, missing
   entries identified by modelName. Apply the same expansion to both fields,
   including Claude 5.5 family/tier names. All seven new routing/discovery
   regressions failed before these fixes and pass afterward.
5. Update both READMEs, the capability specification and quota locale text for
   the new model selection and retired routes. Verify the Argon quota card in
   both English and Chinese alongside the shared Gemini card.

## Validation

- Focused model, quota and prompt integration checks: 76 tests passed.
- Complete `pnpm run check`: peers, lint, typecheck, 43 test files / 520 tests,
  build, packed-package smoke and publint passed.
- `pnpm run check:dsh-source -- /tmp/issue47-dsh-rc5-source-20261117/packages`:
  the same complete gate passed against matching DSH 0.2.1-rc.5 artifacts,
  including 43 test files / 520 tests.
- The source artifacts come from the fixed official source checkout at
  `b830ec950faba0a46dda564be3e2d854afed94f1`. The isolated verification receipt
  records all selected artifact versions and SHA-512 values.
- Retired model tests confirm rejection before credential access or transport.
- `git diff --check` passed. Existing main and investigation worktree changes
  were preserved.

Local logs: `/tmp/pr46-complete-check.log` and `/tmp/pr46-source-check.log`.
Source verification receipt:
`/var/folders/7y/sm09nq553fn8904hqgz1nps40000gn/T/.pr46-integration-dsh-source-rKTegL/artifacts.json`.

Live generation on the new models and live profile installation were not run.
This integration does not publish an npm version.
