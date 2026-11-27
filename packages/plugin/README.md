# Harness Forge

Use your Claude Code, Codex and OpenCode plugins and settings in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): skills, slash commands, subagents, hooks, MCP servers (stdio, HTTP, SSE, OAuth), Claude Code mods and OpenCode code plugins, your `~/.claude` and `~/.codex` setup, instruction files DSH does not read itself, and session history you can continue. It converts at run time and leaves the original installation untouched.

In DSH: **Plugins › Add plugin** and enter `@kirkchinese/harness-forge`. From a terminal, for the main profile that `dsh web` runs:

```sh
dsh plugin --profile web add @kirkchinese/harness-forge
```

Requires DSH 0.2.2-rc.3 or later and Node.js 22.19+ or 24+; on Windows, hooks run in Git Bash.

## Use

Open **Harness Forge** in the DSH sidebar:

- **Discover & migrate** lists the plugins found on this computer and your own settings, marks each part as working, partly working or not possible with the reason, and migrates them (**Migrate all**). You can also browse a marketplace here.
- **Migrated** switches single parts off and undoes migrations.
- **Gaps** lists what cannot fully run and why. **Fill with AI** opens a session in DSH's creation mode that builds a local adapter plugin (`dsh-adapter-<plugin>-<part>`); publishing it is optional and under your own npm scope.

Also: **Import sessions**, **Settings**, **Diagnostics**. The model can use the `harness_*` tools, and you can type `/harness status | list | scan | plan | import | undo | remove | roots | login`.

## Rows

This package installs one DSH plugin row per capability: Harness Forge (required by the others), skills, commands, agents, hooks, MCP servers, Claude Code mods, OpenCode plugins, instructions, sessions, porting and workbench. Each can be switched off in DSH's **Plugins** page without affecting the rest.

## Safety

Migrated hooks, MCP servers and plugin code run with your permissions, as in their original harness. Migrate only plugins you trust.

## Documentation

- [Quick start](https://github.com/kirkchinese/harness-forge/blob/main/docs/user/quickstart.md)
- [Compatibility](https://github.com/kirkchinese/harness-forge/blob/main/docs/user/compatibility.md)
- [Porting (Fill with AI)](https://github.com/kirkchinese/harness-forge/blob/main/docs/user/porting.md)
- [Architecture](https://github.com/kirkchinese/harness-forge/blob/main/docs/architecture/overview.md)
- [Changelog](https://github.com/kirkchinese/harness-forge/blob/main/CHANGELOG.md)

Chinese documentation: [README](https://github.com/kirkchinese/harness-forge/blob/main/README.zh.md).

## License

MIT
