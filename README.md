# claude2dsh

Migrate Claude Code conversations and skills into DeepSeek Harness (DSH) as native, resumable sessions — and export/sync DSH sessions back into Claude Code JSONL transcripts. Claude Code is the first adapter of a multi-tool session-source framework.

## Workspace layout

```
src/                                 root bundle: sessionSources registry plugin
test/                                root bundle tests (Cordis + patch engine)
packages/core/                       normalized session IR + DSH event synthesis + tail logic
packages/adapters/claude-code/       Claude Code adapter: discovery, main-chain parser,
                                     skills, Claude JSONL serializer
packages/plugin/                     DSH plugin: claude2dsh_import,
                                     claude2dsh_import_skills, claude2dsh_export,
                                     claude2dsh_sync
scripts/e2e-round*.sh                reproducible acceptance runs
docs/                                data survey, competitor analysis, gap list, validation
```

The root package remains the DSH bundle skeleton that publishes the in-memory `sessionSources` extension point. `@claude2dsh/plugin` is the bundle you install into a DSH profile.

## Install into a DSH profile

```sh
pnpm -r build
dsh plugin --profile web add -w link:$PWD/packages/plugin
# or in an isolated profile:
# package.json dependencies: { "@claude2dsh/plugin": "link:$PWD/packages/plugin" }
# dsh.profile.bundles: ["@deepseek-ai/dsh-base", "@claude2dsh/plugin"]
```

Restart DSH after installation.

## Tools

| Tool                       | Behavior                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude2dsh_import`        | Read `~/.claude/projects` (or one JSONL) read-only and write DSH-native session logs through `ctx.sessionPersistence`. Idempotent; a grown Claude transcript appends only new turns. `preview:true` is zero-side-effect. `includeSubagents:true` imports subagent/workflow transcripts as `origin:"subagent"` child sessions. |
| `claude2dsh_import_skills` | Copy kebab-case Claude skills with non-empty descriptions from `~/.claude/skills` into `$DSH_HOME/skills`. Existing identical skills are skipped; conflicts are never overwritten.                                                                                                                                            |
| `claude2dsh_export`        | Serialize one DSH session into a Claude Code JSONL transcript under `$DSH_HOME/claude2dsh/exports`. Writing below the real `~/.claude` is refused unless `allowOriginalClaudeDir:true`; existing files are never overwritten unless `force:true`.                                                                             |
| `claude2dsh_sync`          | Append DSH turns newer than the export watermark to the exported Claude copy (default `target:"copy"`). `target:"source"` requires `allowOriginalClaudeDir:true`. External modification/shrink guards refuse the write unless `force:true`.                                                                                   |

## Optional beta features

- Auto mirror: `autoSync.enabled: true` in the plugin row (default false). Watches Claude transcripts and mirrors DSH turns to the safe export copy. Never writes the real `~/.claude` directory.
- Claude hook bridge: set `CLAUDE2DSH_HOOKS_CONFIG` before boot. Command-handler subset only.
- Image policy: `claude2dsh_import` `imageMode` `auto`/`placeholder`/`native` probes model `inputModalities`, retains attachments, and re-projects image nodes when the resumed model changes.

## Safety boundaries

- `~/.claude` is always read-only for migration. Export/sync never write the original Claude directory by default.
- DSH writes go only through host persistence (`$DSH_HOME/sessions`), the DSH-native skill root (`$DSH_HOME/skills`), and the sidecar registry (`$DSH_HOME/claude2dsh`).
- Every validation run uses an experimental copy of the source data, never the live original.

## Validation

```sh
pnpm install
pnpm run format && pnpm run lint && pnpm run typecheck && pnpm run test
pnpm -r typecheck && pnpm -r test && pnpm -r build

CLAUDE2DSH_SOURCE_BACKUP=/tmp/claude2dsh-source-backup bash scripts/e2e-round1.sh
CLAUDE2DSH_SOURCE_BACKUP=/tmp/claude2dsh-source-backup bash scripts/e2e-round2-claude-recognition.sh
CLAUDE2DSH_SOURCE_BACKUP=/tmp/claude2dsh-source-backup bash scripts/e2e-round3-bidirectional.sh
CLAUDE2DSH_SOURCE_BACKUP=/tmp/claude2dsh-source-backup bash scripts/e2e-round4-subagents.sh
```

Round 2 and round 3 use the real `claude` binary against a local mock Anthropic endpoint: Claude Code proves it can reconstruct model messages from the exported transcript, while no real API request is made. See `docs/validation.md` for the recorded results.
