# AGENTS.md

Claude2DSH is a DeepSeek Harness (DSH) plugin for migrating Claude Code sessions, skills and plugin assets into DSH, and for exporting/syncing DSH sessions back to Claude Code JSONL.

## Repository layout

```
src/                                 root bundle: sessionSources registry plugin
packages/core/                       normalized session-source IR + DSH event synthesis
packages/adapters/claude-code/       Claude Code adapter
packages/plugin/                     @claude2dsh/plugin (published DSH bundle)
scripts/e2e-round*.sh                end-to-end acceptance scripts
docs/                                research, validation and release records
```

## Commands

```sh
pnpm install
pnpm run check                        # format, lint, typecheck, test, build, package dry-run
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

Every behavioral change must keep the four `scripts/e2e-round*.sh` green. They use the experimental source copy from `CLAUDE2DSH_SOURCE_BACKUP` and never touch the real `~/.claude`.

## Safety boundaries

- Real `~/.claude` is read-only for migration. Export/sync never write it by default.
- Auto-mirror is beta and default off; when enabled it only writes the safe export copy.
- Never commit credentials, real user transcripts, or personal paths.

## Coding conventions

- TypeScript strict mode; ESM only; Node >= 22.19.
- Every package has one aggregate source face and publishes only built `lib/` artifacts.
- Runtime versions are checked against the installed DSH version before migration runs.
- Registry and sidecar writes below `$DSH_HOME` use atomic write helpers and validate path segments.
