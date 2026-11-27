# Changelog

All notable changes to Harness Forge are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

Plugins straight from the internet, and Fill with AI fixes after a test with a real model on claude-hud's status line.

### Added

- **Plugins straight from the internet.** **Get plugins**, on the Discover screen, replaces "Browse a marketplace". It takes a Claude Code or Codex marketplace (`owner/repo`, a git URL or a `marketplace.json` URL), a single plugin repository or subfolder, or an OpenCode npm package. Anthropic's official, community, skills and knowledge-work marketplaces and OpenAI's curated Codex plugins are listed ready to open, and each is fetched only when you open it. You don't need the original harness.
- **A confirmation before anything is installed.** It shows the source with a link, the exact commit or version (and the npm registry), every part with whether it works in DSH, and a warning when the plugin has hooks, MCP servers, settings or code. Nothing fetched runs before you confirm. What gets installed is exactly what the confirmation showed: if the files change in between, the install is refused. Once confirmed, the plugin goes through the usual install and appears in **Migrated**.
- **Fetched into Harness Forge's own folder** (`<profile>/.harness-forge/data/remote/`), never into `~/.claude`, `~/.codex` or OpenCode's configuration. git fetches only the pinned commit, sparsely for a plugin in a subfolder, and without your git configuration, hooks or credential helpers. Without git, GitHub repositories are downloaded over HTTPS. For npm packages, npm doesn't run before you confirm: Harness Forge itself downloads the tarball of an exact version and checks it against its integrity. Once you confirm, dependencies are installed from the registry only, without install scripts. Archives with links or special files are refused. A marketplace may name only public HTTPS sources, and never this computer or your local network. Proxies in `HTTPS_PROXY`, `HTTP_PROXY` and `ALL_PROXY` (minus `NO_PROXY`) are used; through a proxy only GitHub, npm's registry or yours, and the hosts you paste are reached. Each operation is bounded in size and time while it runs. Network failures, including GitHub's rate limit, are reported in plain words.
- **Check for updates and Update.** These compare each plugin's commit or npm version with its source. An update is shown and confirmed like an install: the new revision the check found, which parts are new or changed, and the code warning. It then keeps the parts you switched off. Removing a plugin deletes its downloaded files.
- All marketplace entry sources Claude Code documents except `command`: relative paths (also bare names under `metadata.pluginRoot`), `github`, `url`, `git-subdir` (with `owner/repo` shorthand), `npm` and `archive`. An entry also acts as the plugin's manifest, following Claude Code's `strict` rules.

### Fixed

- **The first questions come right away.** The creation-mode agent now asks its questions from the brief alone, before reading any files. In the test the wait fell from almost five minutes to a few seconds.
- **Fewer approvals.** The creation session starts in `~/dsh-adapters`, so writing the adapter's source no longer asks for approval in Workspace Write mode. Plugin Manager actions still ask, as DSH requires, unless the session runs with Full access.
- **The agent reports when it is done.** Once `harness_verify_port` confirms the adapter, the agent sends its final report at once instead of waiting for optional reviews.
- **Imported sessions open at once.** An imported session is registered with the running DSH: it shows in the sidebar with its title, under the workspace of its project, and **Open session** works right away instead of failing with `sessions.retain: unknown session` until DSH restarts.
- **Codex tool output reads as the model saw it.** Output wrapped as `{"output": …, "metadata": …}` imports as its output text.
- **Imported sessions can be continued.** Assistant text that came after a tool call (Codex, OpenCode) goes into the next step, so the call stays next to its result; before, the first new message in such a session could fail with HTTP 400.
- **Compressed Codex rollouts.** `rollout-*.jsonl.zst` files (Codex 0.167+) are found and imported.
- **A skills folder with a skill called `agents`, `commands` or `hooks` is still Agent Skills.** Such a skill no longer makes the whole folder look like a Claude Code plugin (and its `SKILL.md` no longer shows up as a command or an agent); real bare Claude plugins (`commands/*.md`, `agents/*.md`, `hooks/hooks.json`) are detected as before.
- **Claude hooks read the same instruction files as the prompt.** The `prompt.context` hook's instruction files now come from the shared discovery, which stops at the repository root (or the working directory outside a repository) and keeps `@import`s inside the workspace, instead of reading every `CLAUDE.md` up to the filesystem root.
- **Importing again opens the session.** Importing a session that was imported before opens that session instead of failing with "already exists".
- **Codex and OpenCode imports get their own ids** (`codex-…`, `opencode-…`), so other importers no longer take them for native DSH sessions. Sessions imported earlier under the source's id keep working and are reused.
- **One status line, one gap.** A `statusLine` in `~/.claude/settings.json` that runs a plugin's own script is shown as part of that plugin (for example claude-hud) instead of as a second gap under your own settings, and it is covered when the plugin's part is.
- **Every workbench answer reaches the browser.** DSH's Remote channel refuses answers with empty fields, so some actions failed, such as adding an already-installed plugin again by path. Every answer is now sent as plain JSON, and a number JSON can't carry is reported with its place.
- **Claude Code sessions show their title in Import sessions** instead of their id: the `/rename` name, else Claude Code's generated title, else the latest summary, else your first message (not slash commands, their output or system reminders). The imported DSH session gets the same title.
- **Plugins installed from the internet stay out of the Claude Code, Codex and OpenCode sections** of Discover, which list only what was found in those harnesses' own folders. They show in **Get plugins** (as installed) and in **Migrated**.
- **One clear notice when the workbench row is off.** The Harness Forge page says "The Harness Forge workbench row is off — turn it on in Plugins" instead of showing screens where every action fails.
- **Chinese detail page in Plugin Manager.** With DSH in Chinese, Harness Forge's page in **Plugins** shows a Chinese description instead of the English README.

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
