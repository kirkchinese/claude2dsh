# Claude2DSH

Migrate Claude Code conversations, skills and plugin assets into DeepSeek Harness (DSH) as native, resumable sessions — then export and sync DSH sessions back into Claude Code JSONL transcripts. Claude Code is the first session-source adapter of a multi-tool migration layer.

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

## Capabilities

| Tool                          | Behavior                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude2dsh_import`           | Read Claude Code JSONL read-only and write DSH-native session logs through `ctx.sessionPersistence`. Idempotent; a grown Claude transcript appends only new turns. `preview:true` is zero-side-effect. `includeSubagents:true` imports subagent/workflow transcripts as `origin:"subagent"` child sessions.                        |
| `claude2dsh_import_skills`    | Copy kebab-case Claude skills into `$DSH_HOME/skills`; identical skills are skipped and conflicts are never overwritten.                                                                                                                                                                                                           |
| `claude2dsh_export`           | Serialize one DSH session into a Claude Code JSONL transcript under `$DSH_HOME/claude2dsh/exports`. Writing below the real `~/.claude` requires `allowOriginalClaudeDir:true`; existing files require `force:true`.                                                                                                                |
| `claude2dsh_sync`             | Append DSH turns newer than the export watermark to the exported Claude copy (default `target:"copy"`). `target:"source"` requires `allowOriginalClaudeDir:true`; external modification/shrink guards refuse unless `force:true`.                                                                                                  |
| `claude2dsh_plugin_inventory` | Dry-run inventory of installed Claude Code plugins; `apply:true` copies only declarative `SKILL.md` assets. Hooks and app-server runtime code are never executed.                                                                                                                                                                  |
| Image policy                  | `claude2dsh_import` accepts `imageMode:"auto"` (default), `"placeholder"` or `"native"`. `auto` probes the target model's `inputModalities`: image-capable routes receive native DSH attachment blocks; text-only routes receive safe placeholders while attachments are retained and re-projected when the resumed model changes. |

## Current limitations (honest status)

- Claude hook bridge is **beta and default off**: it reuses the upstream `@deepseek-ai/dsh-hooks-claude-code` bridge, which supports **7 of Claude Code's 30 hook events** and only `type:"command"` handlers, with partial semantics per event. Full hook compatibility is a roadmap goal, not a current claim.
- Native image path is implemented but has not been validated against a real vision-capable DSH model route; the shipped DeepSeek adapter declares text-only input.
- Auto mirror is **beta and default off**. Enable with `autoSync.enabled: true` in the plugin row. It watches Claude transcripts and mirrors DSH turns to the safe export copy; it never writes the real `~/.claude`.
- Automatic mirroring and full plugin-runtime compatibility are roadmap goals; current synchronization is explicit-tool plus the opt-in beta mirror.

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
```

Round 2 and round 3 use the real `claude` binary against a local mock Anthropic endpoint; no real API request is made in those scripts.

## License and acknowledgements

MIT. The design was benchmarked against `dsh-chat-import` (MIT) and `dsh-claude-move` (Apache-2.0); this project is an independent implementation and reuses no competitor code. Hook compatibility delegates to the official DeepSeek Harness hook bridge package.
