# DSH2Claude

**Move DeepSeek Harness conversations, skills, global instructions, and MCP servers into Claude Code — as resumable Claude Code sessions and native assets.**

This is the inverted sibling of Claude2DSH. The source is DeepSeek Harness (`$DSH_HOME`); the target is Claude Code (`~/.claude` or `CLAUDE_CONFIG_DIR`). Migration is two-phase: everything is staged below `$DSH_HOME/dsh2claude`, and a separate explicit install copies it into Claude Code.

## What it does

| Source                                                                                            | Target                                           |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `$DSH_HOME/sessions/...` (`session.v3` / `session.v4` JSONL, plain or concatenated zstd)          | `~/.claude/projects/<slug>/<session-uuid>.jsonl` |
| `$DSH_HOME/skills/<name>/SKILL.md` and flat `*.md` skills                                         | `~/.claude/skills/<name>/`                       |
| `$DSH_HOME/AGENTS.md`                                                                             | `~/.claude/CLAUDE.md`                            |
| `@deepseek-ai/dsh-mcp-client` rows in profile patches and `$DSH_HOME/storages/mcp_connector.json` | `~/.claude.json` → `mcpServers`                  |

Sessions become native Claude Code transcripts with a contiguous `parentUuid` chain, tool results parented on the assistant record that declared the call, and the source `cwd` preserved so Claude Code lists them under the right project. Re-running the migration is idempotent: the Claude session UUID is derived deterministically from the DSH session id.

## Requirements

- Node.js `>=22.19.0` (uses `node:zlib` Zstandard).
- pnpm and a DSH installation that has written data under `$DSH_HOME` (default `~/.dsh`).
- Claude Code for consuming the result.

## Install

From this checkout:

```sh
pnpm install
pnpm -r build
dsh plugin --profile web add ./packages/plugin
dsh web
```

Then open **Settings → DSH2Claude**.

Once published, the equivalent is:

```sh
dsh plugin --profile web add @dsh2claude/plugin@0.4.0
```

## Two-phase migration

1. **Stage** (`dsh2claude_migrate`, or the Settings buttons). Reads `$DSH_HOME` and writes only `$DSH_HOME/dsh2claude/staging`:
   - `projects/<slug>/<uuid>.jsonl` — rendered Claude transcripts
   - `skills/<name>/` — copied DSH skill bundles
   - `CLAUDE.md` — from `$DSH_HOME/AGENTS.md`
   - `mcp-servers.json` — normalized MCP declarations
   - `manifest.json` — source path, staged path, target path, hash, install state

2. **Install** (`dsh2claude_install`, or **Confirm install**). Copies staged artifacts into Claude Code.
   - Dry-run by default; `confirm: true` is required to write.
   - Existing different content is a conflict.
   - `force: true` renames the old copy to `<target>.dsh2claude-backup-<timestamp>` before replacing it.
   - MCP servers are merged into `~/.claude.json`; unrelated entries are left alone.

## Tools

| Tool                  | Purpose                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `dsh2claude_migrate`  | Stage sessions and selected assets. `preview:true` renders the report and writes nothing. |
| `dsh2claude_install`  | Copy staged artifacts into Claude Code. Dry-run unless `confirm:true`.                    |
| `dsh2claude_status`   | Show the manifest, install state, and resolved DSH/Claude paths.                          |
| `dsh2claude_sessions` | List DSH sessions with title, cwd, format version, and staged/installed state.            |

## How sessions are translated

- **Format support.** DSH writes a header record (`type: "session"`, `version: 3` or `4`) followed by `seq`-numbered events. Logs may be plain `.jsonl` or `.jsonl.zstd` with one concatenated Zstandard frame per durable batch. The reader scans frame boundaries and decompresses each complete frame; an incomplete final frame is ignored and reported as `tornBytes`.
- **Turn mapping.** `turn/start`, `step/start`, `user/message`, `assistant/message`, `tool/call`, `tool/result`, `step/end`, `turn/end`, and `session/title` are consumed. Other DSH events (`team/*`, `job/*`, `approval/*`, `compaction/*`, request headers, search traces) are ignored.
- **Injected context.** DSH user messages whose `source.kind` is not `"user"` (runtime context, time context, skill catalogs, reminders) are counted and skipped. Only real prompts become Claude user records.
- **Tool results.** v4 stores `message.toolCallId` and the output blocks directly on the message; the adapter rewrites that into Claude's `{type:"tool_result", tool_use_id, content}` shape. A missing result gets an empty synthetic result so the assistant/tool pairing stays valid.
- **Subagents.** Delegated DSH sessions are separate logs. They migrate as standalone Claude sessions; select `includeSubagents:true` to include them.
- **Images and reasoning.** Image blocks are counted and dropped. DSH reasoning blocks are also dropped: Claude Code transcripts carry signed thinking blocks, and DSH reasoning has no Claude-compatible signature. Visible text and tool output are preserved.
- **Surface replacements.** DSH `surfaceOp: replace/remove` operations are folded before rendering, so a replaced message appears once, in its replacement form.

## Safety model

- Stage never writes below `~/.claude`.
- Install is the only write path and always previews first.
- Target paths are resolved and confined to the Claude home; a manifest path escaping it is refused.
- Existing files and skill directories are compared by hash. Identical content is skipped; different content is a conflict. Forced replacement keeps a timestamped backup.
- The original DSH data is never modified.

## Current limitations

- **Images and reasoning** are dropped. Images include base64 and DSH attachment references; reasoning has no Claude-compatible signed payload.
- **Agent presets, custom commands, hooks, and plugin runtime behavior** are not migrated. DSH presets are composed Cordis plugin rows; there is no lossless Claude agent equivalent.
- **DSH-specific events** (team, jobs, compaction, goals, approvals) are not representable in Claude Code and are omitted.
- **MCP `cwd`** has no Claude Code stdio equivalent; the command still runs from Claude Code's own working directory.
- **Claude Code must be able to read the transcript.** A malformed or externally modified file is refused rather than appended.
- **No incremental sync yet.** Re-staging updates the staged file; if its hash changed, install reports a conflict and requires `force` to replace the installed copy (with a timestamped backup). A dedicated turn-append path is future work.
- **MCP config path.** With the default layout, MCP servers merge into `~/.claude.json`. A custom Claude home gets `<home>/.claude.json`; if your Claude Code uses a different global config file, merge `mcp-servers.json` manually.

## Repository layout

```
packages/core/                    shared foreign-session types
packages/adapters/dsh/            DSH discovery, zstd decoding, event normalization
packages/adapters/claude-code/    Claude JSONL serializer and target path/UUID helpers
packages/plugin/                  DSH plugin: tools, settings, staging, install, UI
scripts/e2e-migration.mjs         synthetic end-to-end migration check
```

## Development

```sh
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r test
node scripts/e2e-migration.mjs
```

The adapter and plugin tests create synthetic v3/v4 logs, concatenated zstd frames, skills, instructions, and MCP profile rows; nothing touches the real `~/.claude`.

## License

[MIT](LICENSE).
