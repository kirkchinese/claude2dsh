# @claude2dsh/plugin

DeepSeek Harness plugin for Claude2DSH. It imports Claude Code conversations and skills into DSH as native resumable sessions, and exports/syncs DSH sessions back into Claude Code JSONL.

## Settings

The bundle registers a `claude2dsh` settings namespace and a **Claude2DSH** page in the DSH Settings UI. It edits auto-mirror, import defaults, export/write-back and hook-bridge fields. The host schema validates every save; invalid values return a 400 with the schema error. Tool arguments and `CLAUDE2DSH_*` environment variables remain call-time overrides.

## Tools

- `claude2dsh_import`: read `~/.claude/projects` read-only, write DSH-native session logs. Idempotent; grown Claude transcripts append only new turns. `preview:true` is zero-side-effect. `includeSubagents:true` imports subagent/workflow transcripts as `origin:"subagent"` child sessions.
- `claude2dsh_import_skills`: copy validated Claude skills into `$DSH_HOME/skills`; conflicts are never overwritten.
- `claude2dsh_export`: serialize one DSH session into a Claude Code JSONL transcript under `$DSH_HOME/claude2dsh/exports`. Writing below the real `~/.claude` is refused unless `allowOriginalClaudeDir:true`.
- `claude2dsh_sync`: append DSH turns newer than the export watermark to the exported Claude copy (default `target:"copy"`). `target:"source"` requires `allowOriginalClaudeDir:true`. External modification/shrink guards refuse the write unless `force:true`.
- `claude2dsh_import_context`: copy the user-global `~/.claude/CLAUDE.md` into `$DSH_HOME/AGENTS.md` with preview and never-overwrite conflicts; project CLAUDE.md is left to DSH native discovery.
- `claude2dsh_import_memory`: package one project `MEMORY.md`/`memory/*.md` as a DSH-native skill bundle with preview and never-overwrite conflicts.
- `claude2dsh_merge`: explicit bidirectional three-way merge after double-side growth; same-turn dual edits keep both versions and a log-only conflict marker, always writing a new safe copy.
- `claude2dsh_sidecars`: list/resolve copied tool-result `.txt` sidecars.
- `claude2dsh_session_sources`: list/resolve source markers (`claude-main`/`claude-subagent`/`claude-merged`).
- `claude2dsh_plugin_inventory`: read-only inventory of installed Claude Code plugins; `apply:true` copies only declarative SKILL.md assets. Hooks and app-server runtime code are never executed.
- `claude2dsh_autosync`: `status` shows the mirror's pause state, reason, recent conflicts and pending queue; `resume` clears a conflict pause after the two sides were reconciled with explicit tools.
- `claude2dsh_import` image policy: `imageMode:"auto"` follows the current DSH session route. Leave Settings provider/model empty to follow the live session, or fill them to probe an explicit route; text-only routes degrade images to safe placeholders while attachments are retained and re-projected on model switch. Each import item records the route and reason.

## Safety

`~/.claude` is read-only for migration. DSH writes go only through host persistence and `$DSH_HOME`.

## Optional features

- **Auto mirror (default off)**: set `autoSync.enabled: true` in the plugin row config to watch the Claude projects directory and mirror completed DSH turns to the safe export copy. The real `~/.claude` directory is never written by auto-sync. Live sessions are skipped, the pending queue survives restart, and double-side growth pauses the mirror with a conflict report (`claude2dsh_autosync` inspects/resumes).
- **Claude hook bridge (default off)**: set `CLAUDE2DSH_HOOKS_CONFIG=/path/to/hooks.json` before boot to activate the upstream `@deepseek-ai/dsh-hooks-claude-code` bridge. Invalid or unreadable config fails boot with the exact path and reason. The Settings page can read-only scan Claude settings/plugin hooks, preview mappable command handlers, and save a candidate for the next boot. Only command handlers for the seven mapped hook events are supported; hook outcomes are persisted as `hook/invoked` + `hook/result` session-log events. See that package's README for the exact subset.
