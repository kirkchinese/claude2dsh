# Claude2DSH

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

Migrate Claude Code conversations, skills, memory and plugin assets into DeepSeek Harness (DSH) as native, resumable sessions — then export and sync DSH sessions back into Claude Code JSONL transcripts. Claude Code is the first session-source adapter of a multi-tool migration layer.

Included in the community [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) list under **Sessions & Messages**. The automatic [awesome-dsh-plugins](https://github.com/AdamPlatin123/awesome-dsh-plugins) radar has not marked this project as runtime-verified; this badge only reports the curated-list inclusion.

## Quickstart (empty machine)

Requirements: Node.js `>=22.19.0`, pnpm, and the `dsh` CLI.

```sh
# 1. Create a DSH profile with this bundle
dsh plugin --profile claude2dsh add @claude2dsh/plugin

# 2. Import all Claude Code sessions (read-only) and skills
#    In a DSH session (web profile), call:
#      claude2dsh_import({ path: "~/.claude/projects" })
#      claude2dsh_import_skills({ path: "~/.claude/skills" })
#    Or boot once with the test seam:
#      CLAUDE2DSH_TEST_IMPORT=~/.claude/projects dsh --profile claude2dsh
```

The profile installs `@deepseek-ai/dsh-base` automatically and adds `@claude2dsh/plugin` as a bundle. Restart DSH after installation.

Headless profiles only expose tools; the Settings UI needs a web-capable profile. Either add the plugin to your existing web profile (`dsh plugin --profile web add @claude2dsh/plugin@0.2.0-rc.1` then `dsh web`), or add `@deepseek-ai/dsh-web-app@0.1.0-rc.6` to the same profile and boot it with a free port. The web Settings page appears under **Settings → Claude2DSH**.

## Capabilities

| Tool                          | Behavior                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude2dsh_import`           | Read Claude Code JSONL read-only and write DSH-native session logs through `ctx.sessionPersistence`. Idempotent; a grown Claude transcript appends only new turns. `preview:true` is zero-side-effect. `includeSubagents:true` imports subagent/workflow transcripts as `origin:"subagent"` child sessions.                           |
| `claude2dsh_import_skills`    | Copy kebab-case Claude skills into `$DSH_HOME/skills`; identical skills are skipped and conflicts are never overwritten.                                                                                                                                                                                                              |
| `claude2dsh_export`           | Serialize one DSH session into a Claude Code JSONL transcript under `$DSH_HOME/claude2dsh/exports`. Writing below the real `~/.claude` requires `allowOriginalClaudeDir:true`; existing files require `force:true`.                                                                                                                   |
| `claude2dsh_sync`             | Append DSH turns newer than the export watermark to the exported Claude copy (default `target:"copy"`). `target:"source"` requires `allowOriginalClaudeDir:true`; external modification/shrink guards refuse unless `force:true`.                                                                                                     |
| `claude2dsh_autosync`         | `status` reports whether auto-mirroring is paused and lists recent conflicts plus the pending queue; `resume` clears a conflict pause after the two sides were reconciled with explicit tools.                                                                                                                                        |
| `claude2dsh_import_context`   | Copy the user-global `~/.claude/CLAUDE.md` into `$DSH_HOME/AGENTS.md`. Preview by default, identical content is skipped, an existing different target is reported and never overwritten. Project CLAUDE.md is not copied because DSH already reads it.                                                                                |
| `claude2dsh_import_memory`    | Package one project's `MEMORY.md` and `memory/*.md` as a DSH-native skill bundle under `$DSH_HOME/skills`; preview, identical skip and never-overwrite conflicts.                                                                                                                                                                     |
| `claude2dsh_merge`            | Explicit three-way merge when both sides grew after the sync watermark. Complete turns are ordered by timestamp; a turn edited on both sides keeps both versions plus a log-only conflict marker. The original DSH session and Claude JSONL are never mutated; the result is a new safe copy. `dryRun:true` computes without writing. |
| `claude2dsh_sidecars`         | List or resolve tool-result `.txt` sidecars copied under `$DSH_HOME/claude2dsh/sidecars` during import. Original Claude path references are preserved; the map translates them.                                                                                                                                                       |
| `claude2dsh_session_sources`  | List or resolve the source marker written for every imported session: `claude-main`, `claude-subagent` or `claude-merged` (`codex`/`native` reserved).                                                                                                                                                                                |
| `claude2dsh_plugin_inventory` | Dry-run inventory of installed Claude Code plugins; `apply:true` copies only declarative `SKILL.md` assets. Hooks and app-server runtime code are never executed.                                                                                                                                                                     |
| Image policy                  | `claude2dsh_import` accepts `imageMode:"auto"` (default), `"placeholder"` or `"native"`. `auto` probes the target model's `inputModalities`: image-capable routes receive native DSH attachment blocks; text-only routes receive safe placeholders while attachments are retained and re-projected when the resumed model changes.    |

Settings panel: the plugin contributes a **Claude2DSH** page to the dsh Settings UI for auto-mirror, import defaults, write-back and hook-bridge fields. Changes validate on save; invalid values are rejected with the schema error. Tool arguments and `CLAUDE2DSH_*` environment variables remain available and take precedence as call-time overrides.

## Current limitations (honest status)

- Claude hook bridge is **opt-in and default off**: the wrapper around the upstream `@deepseek-ai/dsh-hooks-claude-code` bridge validates config before boot and fails loud on invalid `hooks.json`. The upstream bridge supports **7 of Claude Code's 30 hook events** and only `type:"command"` handlers, with partial semantics per event; hook runs are recorded in the session log as `hook/invoked` + `hook/result` event pairs. Full hook compatibility is a roadmap goal, not a current claim.
- Native image path is implemented but has not been validated against a real vision-capable DSH model route; the shipped DeepSeek adapter declares text-only input.
- Auto mirror is **opt-in and default off**. Enable with `autoSync.enabled: true` in the plugin row. It watches Claude transcripts and mirrors DSH turns to the safe export copy; it never writes the real `~/.claude`. When both sides grew after the sync point it pauses and reports a conflict instead of overwriting either side; use `claude2dsh_autosync` to inspect/resume.
- Full plugin-runtime compatibility is a roadmap goal. Automatic conflict merging is now an explicit opt-in tool; the automatic mirror still pauses and reports rather than guessing.

## Interop

- `claude2dsh_session_move_inspect` talks to `dsh-session-move` when it is mounted; it never moves anything itself. After migration, use dsh-session-move for cold-session workspace moves. Full move capability depends on that project's DSH patch series; see `docs/session-move-interop.md`.

## Safety boundaries

- `~/.claude` is read-only for migration. Export/sync never write the original Claude directory by default.
- DSH writes go only through host persistence (`$DSH_HOME/sessions`), the DSH-native skill root (`$DSH_HOME/skills`), and the sidecar registry (`$DSH_HOME/claude2dsh`).
- Validation always uses an experimental copy of source data, never the live original.

## Repository layout

```
src/                                 root bundle: sessionSources registry plugin
packages/core/                       normalized session IR + DSH event synthesis + tail logic
packages/adapters/claude-code/       Claude Code adapter
packages/plugin/                     DSH plugin bundle: @claude2dsh/plugin
scripts/e2e-round*.sh                reproducible acceptance runs
docs/                                design notes, surveys and validation records
```

## Development validation

```sh
pnpm install
pnpm run check
pnpm -r build && pnpm -r typecheck && pnpm -r test

CLAUDE2DSH_SOURCE_BACKUP=/tmp/claude2dsh-source-backup bash scripts/e2e-round1.sh
CLAUDE2DSH_SOURCE_BACKUP=/tmp/claude2dsh-source-backup bash scripts/e2e-round2-claude-recognition.sh
CLAUDE2DSH_SOURCE_BACKUP=/tmp/claude2dsh-source-backup bash scripts/e2e-round3-bidirectional.sh
CLAUDE2DSH_SOURCE_BACKUP=/tmp/claude2dsh-source-backup bash scripts/e2e-round4-subagents.sh
bash scripts/e2e-round7-merge.sh
```

Round 2 and round 3 use the real `claude` binary against a local mock Anthropic endpoint; no real API request is made in those scripts.

## License and acknowledgements

MIT. The design was benchmarked against `dsh-chat-import` (MIT) and `dsh-claude-move` (Apache-2.0); thanks to both projects for their useful reference points. Hook compatibility delegates to the official DeepSeek Harness hook bridge package.
