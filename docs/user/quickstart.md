# Quick start

English · [中文](quickstart.zh.md)

## Install

Requirements: DSH 0.2.2-rc.3 or later, Node.js 22.19+ or 24+. On Windows, hooks need Git Bash (it comes with Git for Windows), as in Claude Code. OpenCode code plugins need Bun: one on `PATH` or in `~/.bun` is used, otherwise Harness Forge installs one into its own data directory the first time it is needed (or set `BUN_PATH` to a Bun executable). Claude Code mods (hooks modules) are bundled with rolldown, which Harness Forge likewise installs with npm into its data directory when the first mod loads.

In DSH, open **Plugins › Add plugin**, enter `@kirkchinese/harness-forge` and install. It goes into the profile you are using.

Or from a terminal, for the main profile that `dsh web` runs:

```sh
dsh plugin --profile web add @kirkchinese/harness-forge
```

then start DSH again. For another profile, put its name in place of `web`; the desktop app installs through **Plugins › Add plugin** only.

**Harness Forge** now appears in the DSH sidebar. The workbench follows DSH's language (English or Chinese).

## Discover & migrate

![Discover & migrate with your own settings expanded](../assets/discover.en.jpg)

The first screen lists, per harness (Claude Code, Codex, OpenCode), what this computer has:

- **Your own settings**: skills, commands, agents, MCP servers, hooks and settings under `~/.claude` and `~/.codex`.
- **Every installed plugin**, with each of its parts marked as **works**, **partly works** or **not possible**, and the reason. Before you migrate, this is a prediction from the plugin's files; after it runs, a part is marked as checked.

Press **Migrate all** to migrate everything not migrated yet, or migrate one plugin. Migrating changes nothing in the original harness: plugins run from where they are installed.

From the same screen you can **browse a marketplace**: enter a folder with a `.claude-plugin/marketplace.json` (for example one under `~/.claude/plugins/marketplaces`) to see its plugins and install them.

## Migrated

Everything active in DSH, plugin by plugin. Switch single parts off, sign in to remote MCP servers that need it, or remove a plugin to undo its migration.

![Migrated: a plugin expanded, one part switched off and one inactive because its row is off](../assets/migrated.en.jpg)

## Gaps

Every part that cannot fully run in DSH, and why. Where an adapter could fill the gap, **Fill with AI** starts a creation-mode session that writes the adapter and opens it right away; the part shows **In progress** until the agent has verified the adapter, then **Done — verified**. See [porting](porting.md).

![Gaps: a status line part being ported, In progress](../assets/gaps.en.jpg)

## More

| Screen | What it is for |
|---|---|
| Import sessions | Import Claude Code, Codex and OpenCode sessions as DSH sessions and open them at once to continue them in DSH. Importing one again opens the session it became. While [dsh-chat-import](https://github.com/Nwflower/dsh-chat-import) is installed, this screen points to its **Import sessions** button in the sidebar instead |
| Settings | Extra folders to search for plugins, whether to discover automatically, and which CLAUDE.md / AGENTS.md files are added to new sessions |
| Diagnostics | Rows that failed, parts that failed to mount, the shell hooks run in, Bun, and the Harness Forge, DSH and Node.js versions: what to include in a bug report |

![A Claude Code session imported into DSH and continued](../assets/continue-session.jpg)

**Works well with dsh-chat-import.** For more sources (40+ agents) and options, install [dsh-chat-import](https://github.com/Nwflower/dsh-chat-import): **Install** on the first-run banner or on the Import sessions screen asks first, then installs it through DSH's plugin manager. Without the plugin manager, run `dsh plugin --profile web add dsh-chat-import`.

## In a conversation

The model can use Harness Forge directly through its tools: `harness_status`, `harness_discover`, `harness_capabilities`, `harness_scan`, `harness_plan`, `harness_install` and `harness_mcp_login`. A bundled skill, `harness-forge`, tells it when to use them. You can also type:

```text
/harness status | list | roots
/harness scan <path> [source] | plan <path> [source] | import <path> [source]
/harness undo <receipt-id> | remove <plugin-id> | login <server>
```

## Configuration

All optional. The main row (`harness-forge`):

| Field | Meaning |
|---|---|
| `modelAliases` | Which model a Claude alias (`haiku`, `sonnet`, `opus`) runs on, as `provider/model`. Without an entry the session's model is used |
| `preload` | Plugin folders migrated at startup |
| `debug` | Write lifecycle diagnostics to `debug.log` next to Harness Forge's state (`<profile>/.harness-forge/`) |

The skills row (`harness-forge-skills`) takes `skillRoots`: extra folders scanned for `SKILL.md` skills. Every skill in such a folder is served as it is, without import or review. An imported plugin's skills are different: only the skills that were imported and are switched on are served, even when other skills sit in the same folder.

```yaml
- id: harness-forge
  config:
    modelAliases:
      opus: deepseek-official/deepseek-flash
- id: harness-forge-skills
  config:
    skillRoots: [/home/me/shared-skills]
```

## Safety

Migrated hooks, MCP servers and plugin code run with your permissions, as they do in their original harness. Migrate only plugins you trust.
