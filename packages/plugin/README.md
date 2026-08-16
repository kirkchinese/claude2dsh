# @claude2dsh/plugin

DeepSeek Harness plugin for Claude2DSH. It imports Claude Code conversations and skills into DSH as native resumable sessions, and exports/syncs DSH sessions back into Claude Code JSONL.

## Tools

- `claude2dsh_import`: read `~/.claude/projects` read-only, write DSH-native session logs. Idempotent; grown Claude transcripts append only new turns. `preview:true` is zero-side-effect. `includeSubagents:true` imports subagent/workflow transcripts as `origin:"subagent"` child sessions.
- `claude2dsh_import_skills`: copy validated Claude skills into `$DSH_HOME/skills`; conflicts are never overwritten.
- `claude2dsh_export`: serialize one DSH session into a Claude Code JSONL transcript under `$DSH_HOME/claude2dsh/exports`. Writing below the real `~/.claude` is refused unless `allowOriginalClaudeDir:true`.
- `claude2dsh_sync`: append DSH turns newer than the export watermark to the exported Claude copy (default `target:"copy"`). `target:"source"` requires `allowOriginalClaudeDir:true`. External modification/shrink guards refuse the write unless `force:true`.
- `claude2dsh_plugin_inventory`: read-only inventory of installed Claude Code plugins; `apply:true` copies only declarative SKILL.md assets. Hooks and app-server runtime code are never executed.
- `claude2dsh_autosync`: `status` shows the mirror's pause state, reason, recent conflicts and pending queue; `resume` clears a conflict pause after the two sides were reconciled with explicit tools.
- `claude2dsh_import` image policy: `imageMode:"auto"` probes the target model's `inputModalities`. Image-capable models receive native DSH attachment blocks; text-only models receive safe placeholders while attachments are retained and re-projected on model switch.

## Safety

`~/.claude` is read-only for migration. DSH writes go only through host persistence and `$DSH_HOME`.

## Optional features

- **Auto mirror (default off)**: set `autoSync.enabled: true` in the plugin row config to watch the Claude projects directory and mirror completed DSH turns to the safe export copy. The real `~/.claude` directory is never written by auto-sync. Live sessions are skipped, the pending queue survives restart, and double-side growth pauses the mirror with a conflict report (`claude2dsh_autosync` inspects/resumes).
- **Claude hook bridge (default off)**: set `CLAUDE2DSH_HOOKS_CONFIG=/path/to/hooks.json` before boot to activate the upstream `@deepseek-ai/dsh-hooks-claude-code` bridge. Invalid or unreadable config fails boot with the exact path and reason. Only command handlers for the seven mapped hook events are supported; hook outcomes are persisted as `hook/invoked` + `hook/result` session-log events. See that package's README for the exact subset.
