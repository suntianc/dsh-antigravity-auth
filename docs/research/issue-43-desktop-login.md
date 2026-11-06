# Issue #43: login release gap

## Inputs checked on 2026-11-06

- [Issue #43](https://github.com/suntianc/dsh-antigravity-auth/issues/43)
  reports an unresponsive login button on DSH Desktop `0.2.1-rc.5`. It has no
  comments and does not identify the installed plugin version or OS.
- Plugin `main`: `98119aa6e0a691731e4f6feeb574a1a7aa2b9ec0`.
- Plugin `v0.1.4`: `597fc8e3778272500f16d6faaaeaa8ab96e406cc`.
- npm `latest`: `0.1.4`, published `2026-10-31T04:22:09.180Z`.
- Downloaded npm artifact: `dsh-antigravity-auth-0.1.4.tgz`, integrity
  `sha512-U6BPMM9bwpNhm7u99v6NDuQDfkUntt3F4HYREepLHz6HTXiRP887RpYkeXpRICDl2aktnIddqN/4IherhWNR9A==`.
- DSH `dsh-v0.2.1-rc.5`: `b830ec950faba0a46dda564be3e2d854afed94f1`.

## Confirmed defect in the published package

The Host generates an OAuth URL with `prompt=select_account consent`, but the
published browser RPC validator accepts only an absent prompt or `consent`.
Consequently, it rejects both the successful login response and the subsequent
pending status. The UI never reaches `window.open` or renders the authorization
link. The released UI also stores errors in an unused `_error` state and does
not render them, which makes this failure appear unresponsive.

The actual npm artifact contains the same mismatch as the release tag. An
offline test importing its built RPC client confirmed that the Host becomes
pending while the client rejects login and pending status as invalid responses.
No Google request or real callback listener was needed.

The production fix already exists in
[PR #41](https://github.com/suntianc/dsh-antigravity-auth/pull/41)
(`151f9f91af44ed06027b7220e4016bde03ec748f`, merged as
`5e94ee6`), followed by polling-error recovery in
[`98119aa`](https://github.com/suntianc/dsh-antigravity-auth/commit/98119aa6e0a691731e4f6feeb574a1a7aa2b9ec0).
Neither fix is in npm `0.1.4`. No duplicate production patch or relaxed URL
allowlist is needed.

## Desktop carrier review

No additional rc.5 login-specific incompatibility was found in source:

- [Web boot](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/apps/web/src/main.ts#L24-L27)
  sets `ownsHost` before client plugins load.
- [The desktop opener](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/apps/desktop/src/main.ts#L241-L244)
  sends HTTP(S) `window.open` requests to the OS browser.
- [Desktop API forwarding](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/apps/desktop/src/main.ts#L667-L680)
  preserves the request method, body, signal and Host authentication.
- Current plugin account routes already resolve the authenticated peer using
  `connection.admit(request)`; the old removed `operator` field is not used.

## Regression and validation

`tests/login-flow.client.spec.tsx` exercises a settings click through the real
Host service, RPC dispatcher and browser response validator. It covers a blocked
or throwing browser opener, the usable manual link, cancellation, a second login
with a fresh URL, and listener disposal. Network, callback listener and browser
launch are replaced with test doubles. The credential store is in memory.

On Linux, Node `24.22.1`, pnpm `11.7.0`, with the frozen DSH `0.2.1-rc.5` graph:

- The same new UI regression fails both cases against archived `v0.1.4` at the
  missing authorization link and passes both cases against current `main`.
- The downloaded npm artifact reproduces the client rejection independently.
- `pnpm peers check`: passed without peer warnings.
- `pnpm run check`: passed, including lint, Host/client typechecks, **38 files /
  370 tests**, build, package smoke and publint.
- `git diff --check`: passed.

The source-artifact compatibility gate was not rerun in this investigation;
there is no production behavior or dependency change. The prior matching-source
verification is recorded in `dsh-0.2.1-rc.5-impact.md`.

## Next step and limits

The released-package defect and release gap are confirmed and match the report.
The reporter's installed plugin version is still unknown, so this is not a
verified diagnosis of that machine. An authorized new package release containing
the existing fixes is the next delivery step; reinstalling unchanged npm
`latest` cannot supply them. Then verify the reporter's actual plugin version
and ask for an OS-specific follow-up only if the failure remains.

No live account, real OAuth exchange, private endpoint, user profile, packaged
Desktop execution, commit, push, issue comment, PR, release or publication was
performed. Changes in this investigation are limited to the regression test
and this report.
