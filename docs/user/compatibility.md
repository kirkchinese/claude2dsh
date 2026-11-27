# Compatibility

English · [中文](compatibility.zh.md)

Harness Forge does not label a whole plugin "supported" or not. It looks at each part of a plugin (a skill, a command, an agent, a hooks file, an MCP server, a code module, a UI surface…) and reports what happens to that part in DSH.

## How a part is judged

Before migration, the state is a prediction from the plugin's files. After migration, it comes from what actually happened:

| Record | When |
|---|---|
| mounted | The part is set up in DSH but has not run yet |
| verified | The part ran in DSH: the hook ran, the tool was called, the skill was loaded, the command was dispatched, the agent ran |
| failed | Setting it up failed, or a run failed; the error is kept |
| run observations | Every later run, success or failure, per signal (the latest one each) |

The workbench turns these, and the gaps found in the files, into one state per part:

| State | Meaning |
|---|---|
| Works | Set up with no known gap. Marked as checked once it has run in DSH |
| Partly works | Set up, but something it uses does not exist in DSH (an event DSH never raises, for example), or some of its runs failed |
| Needs an adapter | DSH has no equivalent, but an adapter can fill the gap: **Fill with AI** ([porting](porting.md)) |
| Not possible | DSH has no equivalent and nothing local can stand in for it |
| Error | Setting it up failed, or every run failed |
| Inactive | The row that serves this kind of part is switched off |

A part served by an installed adapter shows as working, but not as checked until it runs.

## By kind

| Kind | What works |
|---|---|
| Skills | Served from where they are installed. `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_ROOT}` and `` !`command` `` are expanded when the skill loads. `allowed-tools`, `model`, `effort` and `context: fork` apply when the skill is invoked; frontmatter hooks run through the hooks row |
| Commands | `/<plugin>-<command>` (your own commands keep their name). `$ARGUMENTS`, `$0`/`$1`, named arguments, `${CLAUDE_PLUGIN_ROOT}`, `!` commands and `@file` follow Claude Code's rules, with the safety differences under *Commands and skills: arguments, `!` and `@file`* below. Codex prompts and OpenCode commands are commands too |
| Output styles | Added to the system prompt and selected with `/output-style`. DSH keeps its own coding instructions, so `keep-coding-instructions: false` cannot remove them |
| Agents | DSH agent presets offered through one delegation tool, with their prompt, tool list, `model`, `skills`, `mcpServers`, `maxTurns`, `memory`, `isolation: worktree` and `initialPrompt` |
| Hooks | One broker runs plugin, settings and skill/agent/command frontmatter hooks of Claude Code and Codex. Tool names are translated both ways, so matchers see `Bash`, `Edit`, `Write`…; `if`, `async`, `updatedInput`, Stop continuation and `PermissionRequest` work |
| MCP servers | stdio (through DSH's MCP client, or the capability catalog when it is installed), Streamable HTTP and SSE, with OAuth sign-in (`/harness login <server>` or the workbench). Claude Code plugin servers keep their tool names, `mcp__plugin_<plugin>_<server>__<tool>`; Codex and portable servers keep their own names |
| Settings | Claude Code `settings.json` and Codex config: environment variables reach hooks, MCP servers and shell commands; permission rules gate tool calls; `disableAllHooks` and `outputStyle` apply |
| Claude Code mods | Bundled and loaded into one engine per session, with a compatibility layer for the host API they call |
| OpenCode plugins | Each in its own Bun process, loaded as OpenCode loads it; its `client` talks to an OpenCode-compatible server backed by DSH sessions (table below) |
| Sessions | Claude Code, Codex (also compressed `.jsonl.zst` rollouts) and OpenCode sessions import as DSH sessions you can open at once and continue; with [dsh-chat-import](https://github.com/Nwflower/dsh-chat-import) installed, import is left to it |

### Hook events

Hooks run on these events: `SessionStart`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `SubagentStart`, `SubagentStop`, `Stop`, `StopFailure`, `PreCompact`, `PostCompact`, `SessionEnd`.

`PreCompact`, `PostCompact`, `Notification` and `StopFailure` are seen after DSH has committed them: their hooks run, but a blocking decision is ignored. Hooks on any other event never run.

Handler types `command`, `http`, `mcp_tool`, `prompt` and `agent` are executed, on the events where Claude Code runs them. Other handler types are reported and stay inert.

### OpenCode plugin hooks

| OpenCode | Where it is raised in DSH |
|---|---|
| `tool` | A DSH tool per entry, arguments checked by the plugin's own schema |
| `chat.message` | Before a prompt enters the session |
| `chat.params` | On the model request (temperature, output tokens) |
| `tool.execute.before` / `.after` | Before and after a tool call, in OpenCode's tool names and arguments |
| `permission.ask` | On an approval request |
| `shell.env` | The shell tool's environment |
| `command.execute.before` | An OpenCode command's prompt before it is submitted |
| `experimental.chat.system.transform` | When the system prompt is assembled |
| `config` | Commands the plugin adds become DSH commands |
| `event` | Session, message, part, permission, command, file and compaction events |

## Known gaps

These are the reasons the workbench gives. Each is derived from the plugin's files or from what happened at run time.

| Reason | What it means |
|---|---|
| No equivalent UI | Status lines, themes, workflows, monitors, MCP apps and other UI surfaces have no direct place in DSH. An adapter can rebuild one: **Fill with AI** |
| Events never raised | The hooks file listens to events DSH never raises; those hooks never run. An adapter can sometimes raise them from DSH's own events |
| Cannot block | Hooks on `PreCompact`, `PostCompact`, `Notification`, `StopFailure` run after the fact |
| Handlers inert | Hook handler types the broker does not execute |
| Not mapped | LSP servers, a plugin's `bin/` executables (added to `PATH` by Claude Code), install-time `userConfig` options, and OpenCode plugins named by npm package in `opencode.json` are listed but not run |
| Hosted connector | Codex app connectors are hosted by OpenAI and only work signed in to ChatGPT or Codex. Not possible locally |
| Experimental runtime | Claude Code mods and OpenCode plugins run on a compatibility layer for their host API; a call outside the supported part fails. Once the code has run successfully this reason is dropped |
| Unknown transport | An MCP server that declares neither a known type nor a command or URL is skipped |
| Output style | See *Output styles* above |
| Setup failed / run failed | The recorded error, word for word |

A plugin that declares no license is fine to use locally. The assessment still records it, because publishing anything derived from it (an adapter, for example) needs a license decision.

Remote MCP servers and hooks that call programs need the network or those programs on your machine; when they are missing, the part fails with that error.

## Plugins from the internet

What **Get plugins** can fetch, by harness. Everything is installed through the same path as a local plugin, so the tables above apply to its parts.

| Harness | Marketplaces | Plugin sources in a marketplace entry | Pasted directly |
| --- | --- | --- | --- |
| Claude Code | `.claude-plugin/marketplace.json` in a git repository (`owner/repo`, git URL, `@ref`/`#ref`), or a `marketplace.json` URL | relative path (including bare names under `metadata.pluginRoot`), `github`, `url` and `git-subdir` over HTTPS (with `ref`, or a full 40-character `sha`, also as `URL#sha`), `npm` (from npm's registry or yours), `archive` (zip over HTTPS, checked against `sha256`). `command` is listed but not installed | a plugin repository or subfolder |
| Codex | `.agents/plugins/marketplace.json` in a git repository | `local`, `url`, `git-subdir`, `npm` | a plugin repository (`.codex-plugin/plugin.json`) |
| OpenCode | (OpenCode has no marketplaces) | none | an npm package (`name`, `name@version`, `@scope/name`) |

A Claude Code marketplace entry also acts as a manifest, following Claude Code's rules: with no `plugin.json`, the entry is the manifest; with one, the entry's `skills`, `commands`, `agents` and `hooks` are added to it unless the entry sets `"strict": false`. Harness Forge writes the combined manifest into its own copy of the plugin, so a marketplace such as `anthropics/skills`, whose entries list skills by path, installs the skills its entries name.

An OpenCode npm plugin runs on the Bun runtime, like an OpenCode code plugin found on disk. Before you confirm, npm doesn't run. Harness Forge reads the package from the registry npm is configured with (`npm_config_registry` or the `registry=` line of `~/.npmrc`, else npm's own registry). It takes an exact version or a tag such as `latest`, not a range, downloads that version's tarball from the registry's own address, and checks it against the registry's sha512 integrity. Per-scope registries and registry sign-in aren't read. The confirmation names the registry and how many dependencies the plugin declares. They're installed from that registry when you confirm, as OpenCode installs plugins, with `npm install --ignore-scripts`. A plugin that depends on a git repository, a URL or a local folder, directly or deeper down, is refused. Once you confirm, npm works out the dependencies with its own configuration and may contact other hosts while it does, such as the hosts your npm settings or a registry redirect name. Harness Forge's check covers the packages recorded in the result: each must be a tarball from that registry, with an integrity.

### What a source may do before you confirm

Nothing fetched runs before you confirm: no hook, script, git setting or install step of the plugin or its marketplace. What you confirm is what gets installed. If the downloaded files change after you saw them, or an update's revision differs from the one **Check for updates** found, Harness Forge refuses to install them.

- **A marketplace names only public HTTPS sources.** Its git entries must use `https://` URLs on public addresses, with redirects not followed. An `archive` is downloaded over HTTPS. An `npm` entry may name only npm's registry or yours. A marketplace cannot point Harness Forge at this computer, your local network, `ssh`, `file:` or other git transports. Sources you paste yourself may use any host and `https`, `http`, `ssh`, `git` or `file`. A redirect, though, even from an address you pasted, must lead to a public address.
- **Without a proxy, each connection goes to the address that was checked.** Harness Forge's own downloads (marketplace files, GitHub archives, npm documents and tarballs) connect to the address it checked. For a marketplace's git URL, git is held to that address too, which needs git 2.37 or later; without a suitable git, GitHub sources come as archives and other hosts are refused.
- **Behind a proxy, only known hosts.** Harness Forge uses the proxy set in `HTTPS_PROXY`, `HTTP_PROXY` or `ALL_PROXY` (an `http://` or `https://` proxy, with a user name and password if needed), and skips the hosts in `NO_PROXY`, as git and npm do. Because the proxy resolves host names, Harness Forge can't tell where a name leads. Through a proxy it therefore reaches only `github.com`, `codeload.github.com`, `api.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`, `registry.npmjs.org`, your configured npm registry, and the hosts of sources you paste yourself. A marketplace entry or a redirect that leads to any other host is refused, with the host named. To install from such a host, paste that source yourself, or add the host to `NO_PROXY` if it can be reached directly. This relies on your proxy: it resolves host names and connects, so Harness Forge trusts its answers for the hosts above. Certificates are still checked against the host's name, also through the proxy. git gets the same route Harness Forge chose (proxy or direct), not its own reading of the proxy variables (a proxy password goes to git through its environment, which needs git 2.31 or later), and follows no HTTP redirect, so a repository that moved has to be pasted at its new address.
- **No links.** Plugins are plain files and folders. An archive that contains a link, a hard link or a device file isn't unpacked, and a plugin copied from a repository leaves its links out (the confirmation says which).
- **git runs without your git configuration.** It skips your global and system settings, hooks, templates, credential helpers and `GIT_*` variables, and doesn't fetch submodules or LFS files. As a result, private repositories over HTTPS aren't supported. A private repository you paste as an `ssh` URL (`git@host:owner/repo.git`) works with your own SSH keys.
- **Bounded.** Each operation stops after 10 minutes. A download, clone or install also stops once it writes more than the size limit, even if the server ignores the request for a partial clone. A pinned commit is fetched on its own; if the server doesn't allow that, Harness Forge reports it rather than downloading the whole history.

## Workspace trust

A project brings its own parts: `.claude/` and `.mcp.json` for Claude Code, `.codex/` for Codex. Some of them run code on your computer or reach the network the moment a session starts, so, as in Claude Code, they wait until you trust the workspace:

- hooks (`.claude/settings.json`, `settings.local.json`, `.codex/hooks.json`);
- MCP servers from `.mcp.json` and `.codex/config.toml`;
- commands and skills with a `` !`command` `` or ```` ```! ```` line, frontmatter `hooks`, or `allowed-tools`;
- agents with frontmatter `hooks` or `mcpServers`;
- the parts of a settings file that grant: `permissions.allow`, `env`, and `disableAllHooks: false`. Restrictions never wait: its `permissions.deny` and `permissions.ask` rules and `disableAllHooks: true` apply at once, even when the same file also has `allow` rules or `env`.

Plain skills, agents and commands load at once. MCP servers you added yourself for the folder (`claude mcp add --scope local`) are yours and do not wait.

The workspace is the repository root (a worktree's main checkout), or the working directory outside a repository. It is trusted when any of these holds:

- you accepted Claude Code's trust dialog for it: `projects["<workspace>"].hasTrustDialogAccepted` in `~/.claude.json`. Outside a repository, a trusted parent folder covers it, except your home directory, which covers only itself;
- Codex marks it trusted: `[projects."<workspace>"] trust_level = "trusted"` in `~/.codex/config.toml`;
- you trusted it in Harness Forge. Sessions in an untrusted workspace that has such parts show a **Trust this folder?** banner on the Discover and Migrated screens, listing what waits. **Trust this folder** saves the choice for this DSH profile, in `.harness-forge/trust.json` beside the ledger, and mounts the waiting parts in the sessions already open there. **Not now** hides the banner for that workspace for good: it is saved as `dismissed` in the same file, and trusting later ends it. **More → Settings → Trust settings** lists the workspaces you trusted or dismissed, with **Trust this folder** and **Revoke trust**; revoking withdraws the parts that run code from the sessions already open there (its `deny` and `ask` rules stay), and the banner returns. The same is available as the Remote methods `harnessCompat.workspaceTrust({ cwd })`, `harnessCompat.trustWorkspace({ cwd, trusted })` (it returns `{ decision, stillLive }`: parts whose withdrawal failed are still live, and calling it again retries), `harnessCompat.trustDecisions()` and `harnessCompat.dismissTrust({ cwd, dismissed })`.

A project `.mcp.json` server also needs approval, as in Claude Code: `disabledMcpjsonServers` in any settings file always rejects it. When only Claude Code's trust covers the workspace, it needs `enabledMcpjsonServers` or `enableAllProjectMcpServers` too. Those approvals come from `~/.claude.json` or your `~/.claude/settings.json`, and the project's own settings count only once the folder is trusted. Trusting the folder in Harness Forge approves its servers. A server that is not mounted is never started, so none of its environment variables are expanded into its command, headers or URL.

## Commands and skills: arguments, `!` and `@file`

Shell lines (`` !`…` ``, ```` ```! ````) and `@file` references are found in the command or skill as it is written, before any argument goes in. Command output is never scanned again. Three things differ from Claude Code on purpose:

- **Arguments in a shell line are data.** Claude Code pastes the argument text into the command, so an argument like `"; rm -rf ~"` becomes shell syntax. Harness Forge never puts a value into the command text. Each value (an argument or a path variable such as `${CLAUDE_PLUGIN_ROOT}`) goes into an environment variable, `HF_ARG_0`, `HF_ARG_1`, …, and the placeholder is replaced by a reference to it only where that reference is certain to stay plain data. In bash that means unquoted (`"${HF_ARG_0}"`) or inside plain double quotes (`${HF_ARG_0}`). In PowerShell it means outside quotes or inside plain double quotes (`${env:HF_ARG_0}`). A placeholder anywhere else stops that shell line from running, and a `[Harness Forge: this shell command was not run: …]` note takes its place. "Anywhere else" covers single quotes, `$'…'`, here-documents, PowerShell here-strings, backticks, `$(…)`, `${…}`, arithmetic (`((…))`, `let`, `$[…]`), `[[ … ]]` and comments. The reference must also be an argument of a simple command, and the line runs only if it is. A placeholder may not be the command itself (the first word of a line or after `;`, `&`, `&&`, `||`, `|`, `(`, `{`, `if`, `then`, `do`, `else`, `!` and the like), part of an assignment (`X=$1 cmd`), or an argument of a command that runs, evaluates or names what it is given: in bash `eval`, `exec`, `source`, `.`, `command`, `builtin`, `trap`, `declare`/`export`/`read`/`unset` and every other builtin except `echo`, `printf` (after a fixed format, without `-v`), `cd`, `pushd`, `pwd`, `true`, `false`, `:` and `test`/`[` (right after an operator such as `-f` or `=`, not `-v`); programs that run a command or code, such as `env`, `sudo`, `xargs`, `nohup`, `timeout`, `ssh`, `sh`/`bash`, `python`, `perl`, `node`, `awk`, `sed` and `find … -exec`; in PowerShell `&`, `.`, `Invoke-Expression`/`iex`, `Invoke-Command`, `Start-Process`, `Start-Job`, `Add-Type`, `ForEach-Object` and any command after a `-Command`/`-c`/`-EncodedCommand`/`-ScriptBlock` parameter. A line that defines a function or alias does not run either. The program still receives the value as one ordinary argument, so a value starting with `-` may read as an option. A command that writes `'$1'` therefore works in Claude Code but not here; write `"$1"` instead. These rules cannot know every program: a program not listed above may still treat an argument as an instruction (for example `git --upload-pack=…`). When the model can choose a skill's or command's arguments, migrate only plugins whose shell lines you are comfortable running with model-chosen values.
- **`@file` stays inside known places.** A reference in the command's or skill's own text attaches a file only from places that template may reach, with symbolic links resolved first. A project's command or skill reaches only the workspace. An installed plugin's reaches its own directory and the workspace. Only your own commands and skills (in `~/.claude`, or roots you configured) also reach `~/.claude`. Anything else is not attached, and a `[Harness Forge: @… was not attached …]` note says so. An `@path` you type in the arguments is plain text; DSH handles your own attachments.
- **Trust is checked on what actually runs.** Each time a project's command or skill is rendered, Harness Forge reads its current text and checks the workspace's trust again. If the workspace is not trusted (or no longer is), none of its shell lines run, even ones added after it was loaded, and a note in their place explains why.

## Models

A `model:` in an agent, skill or command can name a Claude alias (`haiku`, `sonnet`, `opus`, or a `claude-…` id). Model names do not say which DSH model is stronger, so without a `modelAliases` entry ([quick start](quickstart.md#configuration)) the session's model answers it. A skill's `model` or `effort` applies to the turn it runs in and is switched back afterwards.

## Instruction files

DSH's own instruction loader already reads `AGENTS.md`, `CLAUDE.md` and their `.local.md` files from the repository root down to the working directory, so Harness Forge does not add those again. The **Instructions** row adds only what DSH does not read, to the system prompt:

- `~/.claude/CLAUDE.md`, and `.claude/CLAUDE.md` in each directory from the repository root (the nearest `.git`) down to the working directory. Without a repository: up to your home directory when the working directory is inside it, otherwise the working directory alone.
- `@path` imports in those files and in the `CLAUDE.md` / `CLAUDE.local.md` files DSH loads: relative to the importing file, `~/`-relative or absolute; at most 5 levels; each file once; never inside a code block or inline code. Imports in a project's files (every `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md`) stay inside the workspace: the repository root, or without a repository the working directory, with symbolic links resolved first. Files are still *found* up to your home directory, but a file found above the working directory cannot import from there either, so a cloned repository cannot pull a file like `~/.ssh/id_rsa`, or another project's files, into the prompt. The exception is a workspace whose external imports you approved in Claude Code (`hasClaudeMdExternalIncludesApproved` in `~/.claude.json`); then, as in Claude Code, its imports may point anywhere, `~/.claude` included. Your own `~/.claude/CLAUDE.md` may import from anywhere. A project instruction file that is itself a symbolic link to a file outside the workspace is not read at all.
- Codex's `~/.codex/AGENTS.override.md` (or `AGENTS.md`), unless your Codex setup is migrated and already carries it.

The total is capped at 65536 bytes: the broadest files are left out first, then the most specific one is cut, with a note saying so. When [Recollect](https://github.com/kirkchinese/DSH-Recollect) is installed, the row steps aside entirely. Switch the row off to stop adding instruction files.
