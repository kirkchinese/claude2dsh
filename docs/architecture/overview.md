# Architecture

English · [中文](overview.zh.md)

## Packages

```text
packages/
  core/     @kirkchinese/harness-forge-core: pure logic, no DSH runtime
  plugin/   @kirkchinese/harness-forge: the DSH plugin, one package with several rows
  testkit/  private end-to-end smoke test against a real DSH
```

**core** depends on Node's standard library and a few pure libraries (`yaml`, `smol-toml`, `ajv`). It holds:

- **dialects** (`src/dialects/`): one folder per harness behind one `Dialect` interface and a registry. A dialect names its markers (manifest, bare layout or common-format fallback), scans a plugin root, and optionally lists default discovery folders, the user's own assets, the plugins its harness records, project assets and a session source. Built in, in detection order: Claude Code (`.claude-plugin/plugin.json`, `~/.claude`, `.claude/`, transcripts), Codex (`.codex-plugin/plugin.json`, `~/.codex`, `.codex/`), OpenCode (`opencode.json`, code plugins), and two common formats: Agent Plugins (a portable `plugin.json`) and Agent Skills (a listed folder of `<name>/SKILL.md` with an optional `.mcp.json`, by default Gemini CLI's `~/.gemini/skills`). `discoverPlugins`, `detectSource` and `scanRoot` only go through the registry; `registerDialect` adds another;
- the **component model** (`ForeignPlugin`, `ForeignComponent`): every part as a skill, command, agent, hooks, MCP server, settings, code, UI or "other" component. A part that cannot be mapped stays in the model with its gap instead of being dropped;
- **planning** (`planPlugin`) and **assessment** (`assess`, `collectGaps`): what a plugin needs, what was achieved, and the gaps;
- **instruction discovery** (`loadInstructions`): the instruction files DSH does not read itself;
- **session parsing**: Claude Code transcripts read into a normalized model and written as DSH session logs;
- **port briefs** (`portBrief`): the Markdown task for **Fill with AI**;
- marketplaces, naming, licenses, fingerprints.

**plugin** depends on core and on DSH's services. **testkit** packs both and runs them in a real DSH.

## Rows

The plugin package exposes one [Cordis](https://www.npmjs.com/package/@deepseek-ai/cordis) plugin per row; [`cordis.patch.yml`](../../packages/plugin/cordis.patch.yml) inserts them all into the profile when the package is installed. Each row is an `exports` entry of the package and shows as its own row in DSH's **Plugins** page, where it can be switched off.

| Row id | Export | Source | Role |
|---|---|---|---|
| `harness-forge` | `.` | `src/index.ts` | Provides the shared service: ledger, imported settings, project assets, turn effects; `/harness`, the `harness_*` model tools and the bundled skill |
| `harness-forge-skills` | `./skills` | `src/skills/row.ts` | One DSH skill provider for imported `SKILL.md` bundles; frontmatter at invocation |
| `harness-forge-commands` | `./commands` | `src/commands/row.ts` | Imported slash commands and output styles |
| `harness-forge-agents` | `./agents` | `src/agents/row.ts` | Imported agents as DSH agent presets behind one delegation tool |
| `harness-forge-hooks` | `./hooks` | `src/hooks/row.ts` | The hook broker; Codex `notify` and global instructions |
| `harness-forge-mcp` | `./mcp` | `src/mcp/row.ts` | MCP servers: stdio, Streamable HTTP, SSE, OAuth |
| `harness-forge-mods` | `./mods` | `src/mods/row.ts` | Claude Code mods engine |
| `harness-forge-opencode` | `./opencode` | `src/opencode/row.ts` | OpenCode plugins in Bun |
| `harness-forge-context` | `./context` | `src/context/row.ts` | Instruction files in the system prompt; yields to Recollect |
| `harness-forge-sessions` | `./sessions` | `src/sessions/row.ts` | Session import; yields to dsh-chat-import when it runs |
| `harness-forge-porter` | `./porter` | `src/porting/row.ts` | Port briefs and creation-mode sessions |
| `harness-forge-workbench` | `./workbench` | `src/workbench/row.ts` | The Remote methods (`harnessCompat` namespace) the workbench page calls |

Two more exports, `./preset-tool-filter` and `./preset-fs-search`, are not profile rows: they are mounted inside the agent presets generated for imported agents, to enforce an agent's tool list.

The workbench page itself is a DSH Web client (`./client`, built with tsdown). It calls the host only through the `harnessCompat` Remote namespace and registers no HTTP route of its own.

## Source layout

Each row has one folder in `packages/plugin/src`, holding its entry (`row.ts`) and everything only it uses:

```text
index.ts     the main row (harness-forge): the shared service, /harness, model tools
forge/       the shared service, contract, ledger, state, row helpers (rowEffect, Parts), turns, marketplace install
skills/      skills row: the skill provider, the bundled skill
commands/    commands row: command definitions, output styles
agents/      agents row: agent presets, the delegation tool, agent profiles
hooks/       hooks row: the broker, runner, vocabulary; Codex notify and instructions
mcp/         mcp row: mounting, remote (HTTP/SSE) servers, OAuth, the capability catalog
mods/        mods row: the Claude Code mods engine
opencode/    opencode row: the Bun runtime
context/     context row: instruction files
sessions/    sessions row: Claude Code, Codex and OpenCode session import, registered with the running DSH; yields to dsh-chat-import
porting/     porter row: port briefs and creation-mode sessions
workbench/   workbench row: the Remote service, overview, settings, adapter coverage, model tools
presets/     the ./preset-tool-filter and ./preset-fs-search exports
shared/      used by several rows: util, body rendering, invocation (frontmatter directives)
dsh/         everything taken from DSH (see below)
client/      the workbench page (browser bundle)
```

## The shared contract

Rows never import each other. They meet through the shared service `harnessForge` ([`src/forge/service.ts`](../../packages/plugin/src/forge/service.ts)) and the contract in [`src/forge/contract.ts`](../../packages/plugin/src/forge/contract.ts):

- **Mounters.** Each kind of component (`skill`, `command`, `output-style`, `mcp`, `hooks`, `agent`, `claude-mod`, `opencode-plugin`, …) has one mounter, registered by the row that owns it (`registerMounter`). The ledger maps each planned action to a mount kind (`mountKindOf`) and calls that mounter.
- **Row APIs.** What one row may ask of another is a small optional API (`HooksApi`, `SkillsApi`, `AgentsApi`, `CommandsApi`, `McpApi`, `ModsApi`, `SessionsApi`, `ContextApi`, `PorterApi`). A row offers it with `provide`; others read it with `lookup` (which returns `undefined` while the row is off) or `watch` (run now and each time the row starts, released when it stops). For example, the mods row adds `tool.check` to the hooks row's permission decision, and the OpenCode row adds `shell.env`, only while the hooks row runs.
- **Evidence.** Rows report runs with `observe(componentId, signal, ok, detail)`; the ledger turns them into each part's state.

## Isolation

- A row starts inside `rowEffect` ([`src/forge/row.ts`](../../packages/plugin/src/forge/row.ts)): if it throws while starting, the error is logged and recorded as that row's fault, and the other rows go on. Listener failures are recorded the same way.
- Inside a row, `Parts` starts each piece separately, so one failing piece does not stop the rest; teardown runs every disposer, last started first, each isolated too.
- A component whose row is off waits as `inactive` and mounts as soon as the row's mounter is registered; a row that stops withdraws its components back to `inactive`.
- Recorded faults appear in the workbench's **Diagnostics**.

## State

Harness Forge keeps its own state in the profile directory under `.harness-forge/`: the ledger (`state.json`), receipts for undo, and a `data/` directory (plugin data, MCP sign-in tokens, the Bun install). It does not change the profile's configuration or installed packages, and it runs plugins from where their own harness installed them.

## DSH surface

DSH is pre-1.0 and its plugin surface changes between releases. Everything Harness Forge takes from DSH goes through [`src/dsh/`](../../packages/plugin/src/dsh), so a DSH upgrade is checked there:

| Module | What it holds |
|---|---|
| `host.ts` | Every DSH service and event the plugin uses, each with the DSH package that declares it. Rows read services and subscribe to events only through it |
| `session-records.ts` | Records written to a session log: plugin records and hook records (the same `hook/invoked` / `hook/result` records DSH's own hooks write) |
| `subagents.ts` | Starting a delegated agent through DSH's `subagents` service |
| `model-route.ts` | Switching an agent's model for a skill's or agent's `model:` / `effort:` |
| `commands.ts` | The slash-command interception chain |

Two dependencies are on DSH internals rather than its declared surface:

1. **Command interception** (`commands.ts`). DSH's `commands` service has no hook around `execute`, yet Harness Forge needs one: a typed command must wait while imported plugins are still mounting, and a Claude Code mod's `command.run` hooks see, answer or replace typed commands. So `execute` is wrapped once and every user adds an interceptor to one ordered chain. When DSH offers a hook, only this module changes.
2. **Shutdown detection** (`hostShuttingDown` in `host.ts`). DSH has no public "exiting" signal, but Harness Forge must tell DSH exiting (end every live session, running its `SessionEnd` hooks) from its own reload (an upgrade or config change while sessions go on). It reads Cordis 4's fiber states (`DISPOSED`, `UNLOADING`) of the fibers above its own; the numbers are type-checked against Cordis's enum.

The package declares `engines.dsh: ">=0.2.2-rc.3"`; DSH packages are optional peer dependencies, so the host's own copies are used. CI's e2e job runs on the newest supported DSH (0.2.2-rc.5) and the oldest (0.2.2-rc.3).

## Optional integrations

- With the [capability catalog](https://github.com/kirkchinese/dsh-capability-catalog) installed, stdio MCP servers are served through its index (`src/mcp/catalog.ts`), and agent tool lists understand its calls.
- With [Recollect](https://github.com/kirkchinese/DSH-Recollect) installed (service `recollect`), the context row yields.

Both are looked up as optional services; neither is a dependency.
