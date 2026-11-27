# Development

English · [中文](development.zh.md)

## Setup

- Node.js 22.19+ or 24+, pnpm 11 (the version is pinned in `package.json`'s `packageManager`), Git. On Windows, Git Bash for hooks.
- [Bun](https://bun.sh): the OpenCode runtime tests load a real plugin in it.
- For the end-to-end test only: DSH 0.2.2-rc.3 or later installed globally, so `dsh` is on `PATH`.

```sh
git clone https://github.com/kirkchinese/harness-forge.git
cd harness-forge
pnpm install
```

## Build, typecheck, test

```sh
pnpm build        # core, then plugin, then the workbench client bundle
pnpm typecheck    # core, plugin (host and client), testkit
pnpm test         # unit tests of core, plugin and testkit (vitest)
```

The plugin resolves core through its built `lib/`, so build core once (`pnpm --filter @kirkchinese/harness-forge-core build`) before typechecking or testing the plugin on a fresh clone. One package at a time:

```sh
pnpm --filter @kirkchinese/harness-forge-core test
pnpm --filter @kirkchinese/harness-forge test
pnpm --filter @kirkchinese/harness-forge test -- hooks   # files matching "hooks"
```

CI ([`ci.yml`](../../.github/workflows/ci.yml)) runs these on Linux, Windows and macOS.

## End-to-end test

```sh
pnpm e2e            # every check
pnpm e2e hook       # checks whose name contains "hook"
```

It boots the `dsh` on `PATH` in a sandbox (its own `DSH_HOME` and `HOME`; your real setup is not touched), installs the packed plugin, and drives headless sessions with a scripted model and in-repo fixtures: no model key and no third-party downloads. It checks skills, commands, agents, hooks, MCP, a `~/.claude` setup, a Codex plugin, instruction files and session import. CI ([`e2e.yml`](../../.github/workflows/e2e.yml)) runs it on DSH 0.2.2-rc.5 and 0.2.2-rc.3. See [`packages/testkit`](../../packages/testkit/README.md) for the options and how to debug a failure.

## Trying it in your own DSH

The quickest way to see a change in a real DSH is `E2E_KEEP=1 pnpm e2e`, which keeps the sandbox profile. To install a local build into a profile of your own, use a scratch profile and do what the e2e test does (`createProfile` in [`packages/testkit/src/dsh.ts`](../../packages/testkit/src/dsh.ts)): pack core and plugin with `pnpm --filter <package> pack`, point the profile's `@kirkchinese/harness-forge-core` at the core tarball (the plugin depends on core by version), and `dsh plugin --profile <name> add` both tarballs. Restart DSH after reinstalling.

## Conventions

- **core stays pure**: no DSH import, no process-wide state. Anything that needs DSH lives in the plugin.
- **Everything from DSH goes through `packages/plugin/src/dsh/`.** A new service or event is added to the list in `dsh/host.ts` with the DSH package that declares it. See [architecture](../architecture/overview.md#dsh-surface).
- **Rows do not import each other.** They meet through the shared service and [`forge/contract.ts`](../../packages/plugin/src/forge/contract.ts).
- **Gaps are never dropped.** A part that cannot be mapped stays in the component model with a gap that says why.
- **The workbench calls the host only through `harnessCompat` Remote methods.** A new method goes into `REMOTE_METHODS` in `src/workbench/remote.ts` (`test/typert.test.ts` checks the list against the service).
- **User-facing text is bilingual.** Row titles and descriptions live in `packages/plugin/locale/<row>/{en,zh}.json`; the workbench's strings in the client's locale files. Code and comments are in English.

## Adding a dialect

A dialect is a harness whose plugins Harness Forge reads.

1. **core: write the dialect.** Add `packages/core/src/dialects/<id>/index.ts` exporting a `Dialect` (`src/dialects/types.ts`): its `id` and `label`, the `markers` that tell its plugin roots (a manifest, a bare layout, or a common-format fallback), and `scan`, which maps each part onto the component model (skills, commands, agents, hooks, MCP, settings, code, UI). Anything without a mapping becomes an `other` component, so it shows up as a gap. If its plugins fit an existing layout, `scan` can call `scanPlugin` (`src/manifest.ts`), with a `manifest` override when the folder has none; add a new convention to `ManifestKind` (`src/types.ts`). Optional members give where it installs plugins (`discoveryRoots`), the user's own assets (`user`), the plugins it records (`harnessPlugins`), project assets (`projectAssets`) and a session source (`sessions`).
2. **core: register it.** Add it to the list in `src/dialects/registry.ts` (built in) or call `registerDialect` (from outside). Discovery, `detectSource`, `scanRoot`, the ledger, the model tools and the workbench pick it up from the registry.
3. **core: assess it.** If it has parts DSH cannot run, make sure `collectGaps` (`src/assess.ts`) reports them with a clear summary.
4. **plugin: run what differs.** If its hooks use their own tool names, add a dialect to `src/hooks/vocabulary.ts`. If it has a code runtime, it needs a mount kind and a row (below).
5. **Sessions (optional).** A session source implements the adapter in `core/src/sessions/adapter.ts` and is offered through the sessions row's API.
6. **Tests.** Add scanner tests in `packages/core/test` (they build small plugin trees in a temporary directory); for a first-class dialect, also an e2e check with a fixture in `packages/testkit/fixtures`.

## Adding a row

1. Write `packages/plugin/src/<row>/row.ts` with `name` (`harness-forge-<row>`), `inject = [FORGE_SERVICE]` and an `apply` that calls `rowEffect(ctx, '<row>', forge => start…(ctx, forge))`. Start each piece with `Parts.add`, so one failing piece does not stop the others, and return the teardown.
2. If it mounts a kind of component, add the kind to `MountKind` and `ROW_OF_KIND`, map the planned action to it in `mountKindOf` (all in `forge/contract.ts`), and register the mounter with `forge.registerMounter`. A mount returns `mounted` at most; only run evidence (`forge.observe`) makes a part verified.
3. If other rows need something from it, add an API interface to `RowApis` and `forge.provide` it. Consumers use `forge.lookup` or `forge.watch` and must work when it is absent.
4. Export it in `packages/plugin/package.json` (`./<row>` and `./<row>/locale/*.json`), insert it in `cordis.patch.yml`, and add `locale/<row>/en.json` and `zh.json` with its `meta.title` and `meta.description`.
5. Add it to the table in `test/rows.test.ts`, which mounts a plugin with every row on and then with each row off in turn, checking that the other rows keep working.
6. Document it in the rows table of both READMEs and the [architecture](../architecture/overview.md) page.

## Releasing

The plugin depends on core as `"workspace:*"`. **Publish with pnpm, never with `npm publish`**: `pnpm publish` replaces `workspace:*` with core's real version in the packed manifest, while `npm publish` would ship the literal `workspace:*` and the install would fail.

1. Bump `version` in `packages/core/package.json` and `packages/plugin/package.json` (keep them equal), add the release to [`CHANGELOG.md`](../../CHANGELOG.md), and merge to `main` with CI green.
2. Check what would ship: `pnpm build && pnpm check:pack`. It packs both packages and fails if the plugin's packed manifest still has a `workspace:` range, names a core version other than the one packed, or an `exports` target is missing from a tarball. CI runs the same check (the `pack` job in [`ci.yml`](../../.github/workflows/ci.yml)).
3. Run `pnpm e2e` against the DSH versions you support.
4. Publish both packages in dependency order, core first: `pnpm publish -r --access public` (pnpm publishes dependencies before their dependents; add `--dry-run` first, and `--tag next` for a prerelease).
5. Tag the release (`git tag v<version>`) and push the tag.
6. When a package is renamed, deprecate the old names so installs point at the new one:

```sh
npm deprecate @kirkchinese/dsh-harness-compat "renamed to @kirkchinese/harness-forge"
npm deprecate @kirkchinese/dsh-harness-compat-core "renamed to @kirkchinese/harness-forge-core"
npm deprecate @kirkchinese/dsh-claude-suite "replaced by @kirkchinese/harness-forge; the capability catalog and Recollect are separate plugins"
```

## Pull requests

Keep a change focused, run `pnpm typecheck` and `pnpm test`, and add a test for behaviour you change. For a plugin that does not work, a minimal fixture reproducing it is the most useful thing you can send.
