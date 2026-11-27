---
name: harness-forge
description: Bring Claude Code, Codex and OpenCode plugins into DSH and report what works. Use when the user mentions a plugin, skill, hook, MCP server, agent or command from another harness, or asks why an imported one does not behave as before.
---

# Harness Forge

Harness Forge installs plugins written for Claude Code, Codex and OpenCode into DSH without changing them, and records what each part actually did at runtime.

## Tools

| Tool | Use it to |
|---|---|
| `harness_discover` | List the user's own `~/.claude` and `~/.codex` assets and the plugin roots found under `~/.claude/plugins`, `~/.codex/plugins` and the OpenCode plugin directories, with an `installed` flag. |
| `harness_scan` | Read one plugin root and list its components (skills, commands, agents, hooks, MCP servers, code, UI, unmapped parts). Writes nothing. |
| `harness_plan` | Show the actions an install would take. |
| `harness_install` | Install one plugin root. Everything mounts immediately. |
| `harness_status` | Installed plugins, each component's status, runtime observations and gaps. |
| `harness_capabilities` | The installed capability catalog and its context cost. |
| `harness_mcp_login` | Sign in to a remote MCP server that needs OAuth. |

The user can do the same from the **Harness** sidebar panel or with `/harness status | list | scan <path> | plan <path> | import <path> | undo <receipt> | remove <plugin-id>`.

## How imported parts appear in DSH

- **Skills** join the normal skill catalog under their own names; load them with the `skill` tool. `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_ROOT}` and `` !`command` `` lines are expanded when loaded.
- **Commands** are slash commands named `/<plugin>-<command>` (Claude's `/plugin:command`). They expand `$ARGUMENTS`, `$0`…, named arguments, `!` shell lines and `@file` references, then send the result as the user's message.
- **Agents** are offered through the `agent` tool: pass the agent's id as `agent_preset`. Each agent keeps its own prompt and tool list.
- **MCP servers** expose tools named `mcp__plugin_<plugin>_<server>__<tool>`, exactly as in Claude Code; Codex servers keep their own server name.
- **Hooks** run on their own: Claude and Codex tool names (`Bash`, `Write`, `apply_patch`, …) are matched against the DSH tools that do the same work.
- **Claude Code mods** (a plugin's `hooks.json` `modules`) run in DSH sessions: their hooks see prompts, tool calls and checks, commands, turns and subagent spawns; what they draw appears as a band above the prompt and as panes, and their buttons work.
- **OpenCode code plugins** run in Bun as in OpenCode, with their `client`, hooks (`chat.message`, `tool.execute.before/after`, `permission.ask`, `shell.env`, `command.execute.before`, events) and tools under their original names.
- **The user's own assets** come over as they are: `~/.claude` (skills, agents, commands, output styles, settings, MCP servers) and `~/.codex` (skills, `/prompts:<name>` prompts, agent roles, `config.toml` MCP servers and `notify`, `rules` as permission rules, `AGENTS.md`).

## Reading a status

Each component has a status:

- `verified`: it ran in this DSH and every recorded run succeeded.
- `mounted`: it is installed and has not run yet.
- `failed`: installing it failed, or its latest run failed. The `observations` list names the event or tool and the error.
- `skipped`: DSH has no equivalent; the gap list says why.
- `inactive`: the Harness Forge row that runs this kind of part is turned off in the profile.

Gaps name what does not carry over: hook events DSH never raises, events that run but cannot block, handler types that are not executed, LSP servers, app connectors and other unmapped parts.

When you report on a plugin, say which parts are verified, which only mounted, which failed with the recorded error, and which gaps apply. For a gap the user needs closed, point them to **Fill with AI** on that part in the Harness Forge panel: it opens a session in DSH's creation mode with a brief of the gap, and that session writes and installs a local adapter plugin.
