# @kirkchinese/harness-forge-core

The pure core of [Harness Forge](https://github.com/kirkchinese/harness-forge): it reads Claude Code, Codex, OpenCode and portable agent plugins into one component model and assesses what a host can run. No DSH runtime dependency.

## What it exports

- **Scanning**: `detectManifest`, `scanPlugin`, `discoverPlugins`, `detectSource`, user assets (`scanClaudeUserAssets`, `scanCodexUserAssets`), OpenCode projects (`scanOpenCodeProject`).
- **Component model**: `ForeignPlugin`, `ForeignComponent` and their kinds (skill, command, agent, hooks, MCP, settings, code, UI, other).
- **Planning and assessment**: `planPlugin`, `assess`, `collectGaps`, `estimateContextCost`; the hook events and handler types a DSH broker serves.
- **Instructions**: `loadInstructions`, `renderInstructions` for `CLAUDE.md` files, `@path` imports and Codex's global `AGENTS.md`.
- **Sessions**: `claudeCodeAdapter`, `readClaudeSession`, `synthesizeDshSession`.
- **Port briefs**: `portBrief`, the Markdown task for writing an adapter.
- **Utilities**: marketplaces (`readMarketplace`), naming (`kebabCase`, `pluginId`, `childId`, `uniqueName`), `detectLicense`, `fingerprintPlugin`, `HarnessError`.

## Development

```sh
pnpm --filter @kirkchinese/harness-forge-core build
pnpm --filter @kirkchinese/harness-forge-core test
```

## License

MIT
