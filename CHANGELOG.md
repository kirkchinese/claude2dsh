# Changelog

All notable changes to Harness Forge are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

Fill with AI, after a test with a real model on claude-hud's status line.

### Fixed

- **The first questions come right away.** The creation-mode agent now asks its questions from the brief alone, before reading any files. In the test the wait fell from almost five minutes to a few seconds.
- **Fewer approvals.** The creation session starts in `~/dsh-adapters`, so writing the adapter's source no longer asks for approval in Workspace Write mode. Plugin Manager actions still ask, as DSH requires, unless the session runs with Full access.
- **The agent reports when it is done.** Once `harness_verify_port` confirms the adapter, the agent sends its final report at once instead of waiting for optional reviews.
- **Imported sessions open at once.** An imported session is registered with the running DSH: it shows in the sidebar with its title, under the workspace of its project, and **Open session** works right away instead of failing with `sessions.retain: unknown session` until DSH restarts.
- **Codex tool output reads as the model saw it.** Output wrapped as `{"output": …, "metadata": …}` imports as its output text.
- **Imported sessions can be continued.** Assistant text that came after a tool call (Codex, OpenCode) goes into the next step, so the call stays next to its result; before, the first new message in such a session could fail with HTTP 400.
- **Compressed Codex rollouts.** `rollout-*.jsonl.zst` files (Codex 0.167+) are found and imported.
- **Importing again opens the session.** Importing a session that was imported before opens that session instead of failing with "already exists".
- **Codex and OpenCode imports get their own ids** (`codex-…`, `opencode-…`), so other importers no longer take them for native DSH sessions. Sessions imported earlier under the source's id keep working and are reused.
- **One status line, one gap.** A `statusLine` in `~/.claude/settings.json` that runs a plugin's own script is shown as part of that plugin (for example claude-hud) instead of as a second gap under your own settings, and it is covered when the plugin's part is.

### Added

- **dsh-chat-import is recommended for session import.** The first-run banner and **More → Import sessions** offer [dsh-chat-import](https://github.com/Nwflower/dsh-chat-import) (Claude Code, Codex, OpenCode and 40+ other agents) with **Install**, which asks first and installs it through DSH's plugin manager. While it is installed, Harness Forge's own import steps aside and points to its **Import sessions** button in the sidebar.

## 0.4.0 - 2026-11-27

The first public release under the Harness Forge name: a smaller product, built around switchable rows, a new workbench, and DSH's own creation mode for the parts DSH cannot run.

### Changed

- **Safer command and skill rendering.** Shell lines and `@file` references are found in the command or skill text before any argument goes in. Arguments inside a shell line reach the shell as quoted environment variables. `@file` attaches only files inside the plugin, the workspace or `~/.claude`.
- **Instruction imports stay in the workspace.** A project's `CLAUDE.md` files import only from inside the repository (or the working directory outside one), unless you approved external imports in Claude Code.
- **New package names.** `@kirkchinese/dsh-harness-compat` is now `@kirkchinese/harness-forge`, and `@kirkchinese/dsh-harness-compat-core` is now `@kirkchinese/harness-forge-core`. The old packages and `@kirkchinese/dsh-claude-suite` are deprecated.
- **One package, several rows.** Skills, commands, agents, hooks, MCP servers, Claude Code mods, OpenCode plugins, instructions, sessions, porting and the workbench are separate plugin rows of the one package. Each can be switched off in DSH's **Plugins** page; a row that fails to start is recorded and the others keep running.
- **New workbench.** **Harness** in the sidebar now has three screens: **Discover & migrate** (with marketplace browsing), **Migrated** (switch single parts off, undo) and **Gaps** (reasons and **Fill with AI**), plus **Import sessions**, **Settings** and **Diagnostics**. It follows DSH's language (English or Chinese).
- **Fill with AI uses DSH's creation mode.** For a part DSH cannot run, Harness Forge writes a task brief and opens a session on DSH's `cordis` agent preset, which builds, installs and checks a local adapter plugin `dsh-adapter-<plugin>-<part>`. Publishing is optional and under your own npm scope.
- Requires DSH 0.2.2-rc.3 or later. Tested on DSH 0.2.2-rc.3 and 0.2.2-rc.5.

### Added

- **Workspace trust.** A project's hooks, MCP servers, shell-line commands and skills, and settings that grant tools or set `env` wait until you trust the workspace. A workspace counts as trusted when you accepted Claude Code's trust dialog for it, Codex marks it trusted, or you trust it with the banner on the Discover and Migrated screens. Project `.mcp.json` servers also follow Claude Code's approvals. See [Compatibility](docs/user/compatibility.md#workspace-trust).
- **Instruction files.** The Instructions row adds the Claude Code instruction files DSH does not read itself (`~/.claude/CLAUDE.md`, `.claude/CLAUDE.md`, `@path` imports) and Codex's global `AGENTS.md` to the system prompt. It steps aside when the Recollect plugin is installed.
- **Diagnostics** screen: row faults, failed mounts, the hook shell, Bun and versions.

### Removed

- The suite package `@kirkchinese/dsh-claude-suite`. The capability catalog and Recollect are separate, optional plugins; Harness Forge works with them when they are installed.
- The Recollect toggle in the workbench settings.
- The porting studio templates and its tools, replaced by **Fill with AI** through DSH's creation mode.
- Hosted runs of the Claude Code, Codex and OpenCode command-line tools.
- Repair of sessions imported before 0.3 (`/harness repair-sessions` and the `harness-forge-repair-sessions` command).
- Support for DSH 0.2.1.

### Upgrading from `@kirkchinese/dsh-harness-compat` or the suite

```sh
dsh plugin --profile web remove @kirkchinese/dsh-harness-compat   # or @kirkchinese/dsh-claude-suite
dsh plugin --profile web add @kirkchinese/harness-forge
```

`web` is the main profile that `dsh web` runs; use another profile's name to upgrade that one.

Your migrations are kept: Harness Forge 0.4.0 reads the same ledger (`<profile>/.harness-forge/state.json`). If you used the suite and want the capability catalog or Recollect, install `@kirkchinese/dsh-capability-catalog` or `@kirkchinese/dsh-recollect` on their own. Sessions imported before 0.3 that still need repair must be repaired with Harness Forge 0.3 before upgrading.
