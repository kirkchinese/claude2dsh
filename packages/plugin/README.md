# @dsh2claude/plugin

DeepSeek Harness plugin for DSH2Claude. It reads DSH sessions, skills, global instructions, and MCP declarations, stages Claude Code-ready artifacts below `$DSH_HOME/dsh2claude/staging`, and installs them into Claude Code on explicit confirmation.

## Install

From this checkout:

```sh
pnpm install
pnpm -r build
dsh plugin --profile web add ./packages/plugin
dsh web
```

Then open **Settings → DSH2Claude**.

## Tools

- `dsh2claude_migrate`: stage sessions and selected assets. `preview:true` reports without writing.
- `dsh2claude_install`: copy staged artifacts into `~/.claude` (or `CLAUDE_CONFIG_DIR`). Dry-run unless `confirm:true`; conflicts require `force:true`, which keeps a timestamped backup.
- `dsh2claude_status`: show the manifest and resolved paths.
- `dsh2claude_sessions`: list DSH sessions and their staged/installed state.

## Safety

Stage never writes below `~/.claude`. Install is the only write path, previews first, confines target paths to the Claude home, and compares content hashes before replacing anything. The original DSH data is read-only.

## Layout

```
$DSH_HOME/dsh2claude/staging/
  manifest.json
  projects/<slug>/<session-uuid>.jsonl
  skills/<name>/
  CLAUDE.md
  mcp-servers.json
```

## Limitations

Images are counted and dropped. DSH agent presets, custom commands, hooks, and plugin runtime behavior are not migrated. MCP `cwd` has no Claude Code stdio equivalent. There is no incremental turn-append yet.
