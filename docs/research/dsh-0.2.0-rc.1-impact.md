# DSH 0.2.0-rc.1 plugin impact assessment

The published `@deepseek-ai/dsh@0.2.0-rc.1` package and official source tag
`dsh-v0.2.0-rc.1` (`4878cdabd87d4041bdaff61d04c966883b9fd07a`)
define this development baseline. npm currently assigns it the `next` tag;
`latest` still points to the older `0.1.7-rc.2` channel.

## Public contract changes

- The LLM request uses V4 messages. A tool response is a role `tool` message
  with direct content and a `toolCallId`; the old nested `tool-result` block
  is no longer the request representation.
- Settings now exposes Config Forms. Config fields that can update without
  remounting must be `volatile()` and read through the current value handle;
  `settings.installSection()` and client `SettingsScope.bind()` are gone.
- Connection RPC handlers receive an operator argument. Account routes keep
  their existing Host-side loopback guard.
- Cordis `4.0.4` and Schemastery `3.18.4` belong to the matching dependency
  graph. Retired DSH package names are removed from development dependencies.

## Verification boundary

The package check covers peer consistency, typecheck, tests, build, package
smoke, and publint. The isolated source check uses packages built from the
tagged source. Neither check proves a real account login, private backend
transport, or an installed Web/Desktop profile. Existing user transport and
stream changes in this worktree are preserved.
