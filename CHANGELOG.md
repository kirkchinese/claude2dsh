# Changelog

All notable changes to Harness Forge are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

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
