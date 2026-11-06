# Changelog

## Unreleased

Claude2DSH now supports the DSH 0.2.x line (verified on `0.2.2-rc.1`) in addition to 0.1.5+. DSH 0.2 moved the Session log to **format v4** and replaced the namespaced settings registry, so 0.3.0 refused to load on it (`claude2dsh requires @deepseek-ai/dsh-session >=0.1.5-rc.1 <0.2.0, found 0.2.2-rc.1`) and, with the gate bypassed, every import failed with `format v4 tool/result at seq N requires a tool-role message`.

### Changed

- The declared peer range and the load-time gate are now `>=0.1.5-rc.1 <0.3.0`; the gate accepts Session formats v3 and v4. A prerelease of the next minor line (for example `0.3.0-alpha.1`) is still refused.
- Development dependencies track DSH `0.2.2-rc.1` (with `@deepseek-ai/cordis` 4.1, `cordis-plugin-include` 1.1 and `schemastery` 3.19, matching that release); CI runs the unit suites on Node 24 and the real-profile acceptance against `0.1.5-rc.1`, `0.1.6-alpha.2` and `0.2.2-rc.1` (Node 24 for DSH 0.2, which requires Node >= 24.9). `0.1.6-alpha.1` left the matrix because it no longer installs: its caret dependency on `dsh-app-boot` now resolves to `0.1.6-alpha.2`.
- `scripts/e2e-acceptance.sh` installs the packed packages into the acceptance profile instead of a `link:` to the workspace, so the plugin's host peers resolve to the DSH under test rather than to its own devDependencies; the assertions expect the Session format of that release (v3 on 0.1.x, v4 on 0.2.x) and check that tool results round-trip through export.

### Fixed

- **Imports on DSH 0.2.** `tool/result` events are written in the representation of the installed format: on v4 a tool-role message carrying `toolCallId`, direct content and an optional `isError`; on v3 the user-role `tool-result` wrapper as before. This covers real, failed and synthesized (lost-result) tool results and the import, append and merge paths (`SynthesizeOptions.sessionFormatVersion`).
- **Export and sync on DSH 0.2.** The Claude JSONL serializer reads both tool-result representations (`storedToolResults`), so tool results no longer disappear from exported and synced transcripts. A v3 message carrying several wrapped results now produces one `tool_result` record per call instead of repeating all of them for each call.
- **Three-way merge on DSH 0.2.** Format v4 requires consecutive turn numbers, so merged growth turns are renumbered after the common base (a conflicting pair occupies two adjacent turns). Source-event references are resolved against the side that produced the citing event, instead of colliding when both sides numbered their growth from the same watermark.
- Image re-projection replaces surface nodes with `{ op: 'replace', startSeq, endSeq }`, the shape every supported DSH release validates; the previous `start`/`end` keys were rejected.
- Auto mirror is activated once from the effective settings instead of a second time from the raw bundle config, so disabling it in Settings is honoured.

### Settings on DSH 0.2

DSH 0.2 replaced `settings.register(namespace, schema)` with Config-derived profile forms. On hosts without the registry the Claude2DSH settings document (layered over the bundle config and schema defaults) is persisted in `$DSH_HOME/claude2dsh/settings.json`; DSH 0.1.x keeps using its settings registry. The Settings page, tools and auto mirror read the same live settings on both lines.

## 0.3.0 — 2026-09-17

Claude2DSH now targets the DSH releases that replaced the service-level session API with per-session handles and moved the Session log to format v3. **This release is required for DSH 0.1.5 and later, including 0.1.6-alpha.1, and no longer starts on 0.1.0-rc.x.**

### Breaking

- Minimum supported harness is `@deepseek-ai/dsh-session >= 0.1.5-rc.1`; the declared peer range is `>=0.1.5-rc.1 <0.2.0`. The load-time gate now fails with an upgrade instruction instead of a version-regex message.
- Imported sessions are written in the **current Session log format (v3)**: the header carries `version: 3` and the required `isSeeded: false`, and the on-disk artifact is `session.vN.jsonl[.zstd]`. Sessions written by 0.2.x are v0 files and are read through the harness's own migration chain.

### Fixed

- **Sessions no longer fail to open on resume.** `assistant/message` events now carry the required `stream` array (empty, because a Claude transcript stores the assembled reply and not its deltas). Without it DSH's seed validation rejects the log with `has invalid settlement fields`, and `token-meter` / `session-stats` throw while iterating the stream.
- Every session read and write goes through DSH's handle-based persistence (`create`/`open` → `handle.read`/`handle.append`/`handle.flush`/`handle.close`); the removed service-level `readFrom`/`append`/`inspect`/`prepare` calls are gone, and `list()` results are read through their `header` field. This also applies to the export, sync, merge, session-source and Web settings paths.
- A write that collides with a live agent now reports "session is open for writing by a live agent; retry after that agent is idle or closed" instead of leaking a backend ownership error.
- `subagent/descriptor` is stamped with the harness's current descriptor version (3) instead of a hardcoded 2, so imported subagent sessions are recognized as one-shot children.
- The settings namespace registers as the plain string `claude2dsh`; the removed `settingsNamespace()` helper is no longer imported.
- `JsonValue` is imported from `@deepseek-ai/dsh-util-values`, where DSH moved it.
- The browser half no longer references the removed `@deepseek-ai/dsh-client-runtime`: the client context comes from `@deepseek-ai/cordis`, and `dsh.client.inject` lists module ids that exist in current releases.

### Added

- **`claude2dsh_import_agents`** — translates `~/.claude/agents/*.md` subagent definitions into DSH skills (`cc-agent-<name>`). A Claude subagent is a delegated persona; the skill keeps its instructions and records the origin, model and tool list in frontmatter metadata.
- **`claude2dsh_import_commands`** — translates `~/.claude/commands/**/*.md` slash commands into DSH skills (`cc-cmd-<namespace>-<name>`), with `disable-model-invocation: true` so a human prompt never enters the model catalog.
- **`claude2dsh_import_mcp`** — translates `~/.claude.json` and project `.mcp.json` MCP servers into a `dsh-mcp-client` patch layer under `$DSH_HOME/claude2dsh/mcp.patch.yml`, reporting the exact `dsh --patch` command. stdio and streamable-HTTP servers translate; SSE servers are reported as unsupported, and two servers claiming one namespace are reported as a collision rather than emitting a layer that cannot boot.
- `claude2dsh_plugin_inventory --apply` now also translates a plugin's `agents/` and `commands/` directories, through the same translators as the top-level tools.
- `scripts/e2e-acceptance.sh` — a five-round, real-profile acceptance (import → native read → idempotency → export → sync → conflict → three-way merge → agents/commands/MCP → generated layer composes) that runs against any installed DSH CLI and is wired into CI for both published channels.
- `scripts/check-version-compat.mjs` — typechecks the plugin against one or more DSH source checkouts without installing them, so a breaking API change is caught before a release rather than by an issue report.
- `scripts/sync-guidance-docs.mjs` — refreshes the shared guidance checkout and re-flattens its guides.

### Changed

- The compatibility gate is capability-based: it requires a Session format this build writes and names the exact `npm install -g @deepseek-ai/dsh@latest` remedy.
- The CI compatibility job now asserts that the newest published DSH release still satisfies the declared peer range, and fails when it does not.
- Dependencies, peers and the integrator script target the current releases; the installer default is `@claude2dsh/plugin@0.3.0`.


## 0.2.0-rc.5 — 2026-08-17

### Fixed

- The npm package now carries every official DSH peer required by the optional hook bridge, so a clean `dsh plugin --profile web add` boots with `CLAUDE2DSH_HOOKS_CONFIG` and reports no peer issues. 0.2.0-rc.4 is deprecated because it omitted these peers.

## 0.2.0-rc.4 — 2026-08-17

### Fixed

- Hook bridge now declares its upstream peers, so the Settings “save candidate and enable next boot” path boots in a fresh profile instead of failing with a missing `@deepseek-ai/dsh-hook-protocol`.
- Imported subagent transcripts now carry a durable one-shot `subagent/descriptor`, so DSH lists them as readable one-shot children instead of “corrupted session record”.
- Settings validation errors show the validator message instead of a raw JSON body.

### Added

- Settings now has a session picker with one-click **Export to Claude** and **Sync to Claude**, so the reverse path no longer requires a model/agent execution.
- Settings clarifies image modes, auto-mirror boundaries, write-back targets, hook scan scope, and session-source filtering.

## 0.2.0-rc.3 — 2026-08-17

### Changed

- Image `auto` policy follows the current DSH session route instead of a hardcoded text-only route; empty provider/model means follow session, manual values remain overrides.
- Import search is recursive by default and source-root resolution is `CLAUDE_CONFIG_DIR`-aware; the first-run guide shows the discovered root and counts.
- Settings image section shows a live capability probe with an explicit degradation/upgrade reason; import items record the same reason.

### Added

- Read-only Claude hook auto-discovery: scans Claude settings and plugin hooks, previews mappable command hooks, reports skipped non-command entries, and saves an opt-in candidate for the next boot.

## 0.2.0-rc.2 — 2026-08-16

### Added

- Zero-configuration-by-default criteria and rewritten bilingual README with capability how-tos and FAQ.
- One-command default headed installer (`scripts/install-claude2dsh.sh`) that repairs the profile manifest when pnpm ignores koffi's build script.
- First-run Web migration guide (language → source → preview → execute → result), Chinese default and bilingual Settings.
- Round-8 empty-environment headed acceptance script.

### Changed

- Import preview reports `previewed` separately instead of counting previews as skipped.

## 0.2.0-rc.1 — 2026-08-16

### Added

- Curated-list inclusion badge + `README.zh.md` (radar runtime-verification is explicitly not claimed).
- DSH Settings page and durable `claude2dsh` settings namespace (auto-mirror, import defaults, write-back, hook fields); host validator rejects bad values.
- Global `~/.claude/CLAUDE.md` → `$DSH_HOME/AGENTS.md` with preview/never-overwrite.
- Project `MEMORY.md`/`memory/*.md` → one DSH-native skill bundle per project.
- Tool-result `.txt` sidecar copy + durable path map, per-file size cap and `claude2dsh_sidecars`.
- Explicit bidirectional three-way turn merge (`claude2dsh_merge`), same-turn dual edits preserved with a log-only marker, safe copies only.
- Per-session source markers (`claude-main`/`claude-subagent`/`claude-merged`) + `claude2dsh_session_sources`, now also visible in the Settings page.
- `claude2dsh_session_move_inspect` interop entry for dsh-session-move (inspection only, never moves).
- Round-7 e2e for conflict merge and merged-session export.
- DSH-Session-Move interop evaluation.

### Fixed

- Claude string tool_result content was previously dropped; it is now normalized into text blocks (restores persisted-output sidecar references).
- Export-copy roundtrip now parses string items inside user/assistant content arrays.

## 0.1.0 — 2026-08-16

### Released

- Published to npm: `@claude2dsh/core@0.1.0`,
  `@claude2dsh/adapter-claude-code@0.1.0`, `@claude2dsh/plugin@0.1.0`;
  verified with a clean `dsh plugin add` + one-session import.

### Added

- Bidirectional conflict baseline: when both Claude and DSH sides grew after the last sync watermark, import/sync reports `conflict` and auto-mirror pauses with a persisted record; neither side is overwritten.
- Auto-mirror hardening: live-session skip, persisted pending queue, boot-time queue drain, conflict pause/status/resume tool, and watcher failure-injection tests.
- DSH runtime compatibility gate (`@deepseek-ai/dsh-session` peer + session format version) with CI check against the newest published DSH rc.
- Generic tool cards for import/sync/autosync calls and results.
- Fail-loud hook bridge config validation before bridge activation.
- Plugin asset-name sanitization, project-specific AGENTS.md, GitHub Actions CI and CHANGELOG.

### Changed

- Auto-mirror and hook bridge docs no longer carry the beta label: the integration layer is stable within the documented upstream subset (7/30 command-only hooks).

## 0.1.0-rc.2 — 2026-08-16

### Fixed

- Published npm manifests no longer contain `workspace:` dependency protocols. The rc.1 packages were deprecated because `dsh plugin add @claude2dsh/plugin` failed on a clean machine.

### Added

- Real-registry empty-environment acceptance: fresh profile, npm install, one-session import and skills import all pass.

## 0.1.0-rc.1 — 2026-08-16 (deprecated)

### Added

- Claude Code session import with incremental append.
- Claude Code skill migration.
- DSH -> Claude Code export and incremental sync.
- Image capability detection with placeholder fallback and attachment retention.
- Optional beta auto-mirror (default off).
- Optional Claude hook bridge via the official DSH hook bridge package.
- Read-only Claude Code plugin asset inventory.

### Known issues

- Published manifest contained `workspace:` protocol dependencies; fixed in rc.2.
