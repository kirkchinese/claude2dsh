# Claude2DSH

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

Migrate Claude Code conversations, skills, memory and plugin assets into DeepSeek Harness (DSH) as native, resumable sessions — then export and sync DSH sessions back into Claude Code JSONL transcripts. Claude Code is the first session-source adapter of a multi-tool migration layer.

Included in the community [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) list under **Sessions & Messages**. The automatic [awesome-dsh-plugins](https://github.com/AdamPlatin123/awesome-dsh-plugins) radar has not marked this project as runtime-verified; this badge only reports the curated-list inclusion.

## Design principle: foolproof out-of-box

Every default must work without reading this document: install one command, open a browser, see the UI, complete the first migration. Safety defaults are never weakened — writing the real `~/.claude` stays refused unless the user explicitly enables it in a clearly labelled switch. Full criteria are in `docs/design-philosophy.md`.

## Quickstart (empty machine)

Requirements: Node.js `>=22.19.0`, pnpm, and the `dsh` CLI.

### Recommended: use DSH's built-in web profile

```sh
# 1. Install the plugin into the built-in headed profile
dsh plugin --profile web add @claude2dsh/plugin@0.2.0-rc.1

# 2. Start the browser UI (prints http://127.0.0.1:3080)
dsh web
```

Open the printed URL, then go to **Settings → Claude2DSH**. The first screen is the migration guide: choose language (Chinese default), paste or keep the Claude sessions directory, click **Preview import**, inspect the report, then click **Run import**.

### Alternative: one command, isolated headed profile

Clone this repository and run:

```sh
bash scripts/install-claude2dsh.sh
```

The script installs the plugin into your main `web` profile and starts the browser UI on `http://127.0.0.1:18781`. It never creates an isolated profile unless you set `CLAUDE2DSH_PROFILE`; for an explicit custom profile it also installs `dsh-web-app` and repairs the profile manifest if pnpm reports the harmless ignored `koffi` build script.

### Headless (advanced only)

Automation that has no browser can use the tools directly:

```sh
dsh plugin --profile claude2dsh add @claude2dsh/plugin@0.2.0-rc.1
CLAUDE2DSH_TEST_IMPORT=~/.claude/projects dsh --profile claude2dsh
```

**Headed vs headless in one sentence:** headed profiles include `@deepseek-ai/dsh-web-app` and show the browser UI; headless profiles run the same tools without a browser. The old tutorial created only a headless profile, which is why “nothing visible” happened — the plugin was working, but there was no UI to show.

## Capabilities: what, when, and where

| Capability       | When to use it                                                                  | Where                                                                        |
| ---------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Session import   | First migration, or whenever Claude Code gained new turns                       | Settings → Claude2DSH → First-run migration, or the `claude2dsh_import` tool |
| Skill import     | Bring Claude skills into DSH discovery                                          | `claude2dsh_import_skills` tool                                              |
| Global context   | Move user-global `~/.claude/CLAUDE.md` to DSH global instructions               | `claude2dsh_import_context` tool                                             |
| Project memory   | Make one project's `MEMORY.md`/`memory/*.md` discoverable as a DSH skill bundle | `claude2dsh_import_memory` tool                                              |
| Export to Claude | Resume the migrated session in Claude Code again                                | `claude2dsh_export` tool                                                     |
| Sync back        | Write DSH-side turns into the exported Claude copy                              | `claude2dsh_sync` tool                                                       |
| Auto mirror      | Continuous two-way mirroring with conflict pause                                | Settings → Auto mirror (`autoSync.enabled`)                                  |
| Conflict merge   | Both sides grew after the sync point and neither may be lost                    | `claude2dsh_merge` tool                                                      |
| Sidecar files    | Locate large tool outputs copied during import                                  | `claude2dsh_sidecars` tool                                                   |
| Session sources  | Tell which sessions came from Claude (main/subagent/merged)                     | Settings → Session sources, or `claude2dsh_session_sources` tool             |
| Plugin inventory | Inspect installed Claude plugins without executing their code                   | `claude2dsh_plugin_inventory` tool                                           |
| Image policy     | Images in old transcripts should survive into DSH safely                        | Automatic (`imageMode:"auto"`); override in Settings → Import defaults       |

Import is read-only for `~/.claude` and idempotent: a second run says “already imported” instead of duplicating. Preview is always available before writing. Every action returns a JSON report the UI renders as numbers (`imported/already/skipped/failed`).

## FAQ

**I followed the old tutorial and saw no UI.**
That profile only had `@deepseek-ai/dsh-base + @claude2dsh/plugin`: it is headless. Add the plugin to `dsh plugin --profile web`, or use `scripts/install-claude2dsh.sh`. The UI is under **Settings → Claude2DSH**.

**`dsh plugin add @deepseek-ai/dsh-web-app` failed with “Ignored build scripts: koffi”.**
pnpm refused to run koffi's build script; dependencies are installed but dsh did not finish the bundle patch. The installer script detects this state and repairs `dsh.profile.bundles`. Do not approve arbitrary build scripts.

**What is a profile?**
A named folder under `$DSH_HOME/profiles` that lists bundles and overrides. You normally only need `web` (browser) or `claude2dsh` (the script's isolated headed profile).

**Will it write my real ~/.claude?**
No. Import is read-only. Export/sync write a safe copy under `$DSH_HOME/claude2dsh/exports`; writing the original `~/.claude` requires `allowOriginalClaudeDir:true` and is refused by default.

**Why are auto mirror and hook bridge off?**
Auto mirror and hook bridge are opt-in so surprises cannot happen before the user understands them. Turn them on in Settings; auto mirror never writes the real `~/.claude`, and the hook bridge only supports the documented 7/30 command subset.

## Current limitations (honest status)

- Claude hook bridge is **opt-in and default off**: the wrapper around the upstream `@deepseek-ai/dsh-hooks-claude-code` bridge validates config before boot and fails loud on invalid `hooks.json`. The upstream bridge supports **7 of Claude Code's 30 hook events** and only `type:"command"` handlers, with partial semantics per event; hook runs are recorded in the session log as `hook/invoked` + `hook/result` event pairs. Full hook compatibility is a roadmap goal, not a current claim.
- Native image path is implemented but has not been validated against a real vision-capable DSH model route; the shipped DeepSeek adapter declares text-only input.
- Auto mirror is **opt-in and default off**. Enable with `autoSync.enabled: true` in the plugin row. It watches Claude transcripts and mirrors DSH turns to the safe export copy; it never writes the real `~/.claude`. When both sides grew after the sync point it pauses and reports a conflict instead of overwriting either side; use `claude2dsh_autosync` to inspect/resume.
- Full plugin-runtime compatibility is a roadmap goal. Automatic conflict merging is now an explicit opt-in tool; the automatic mirror still pauses and reports rather than guessing.

## Interop

- `claude2dsh_session_move_inspect` talks to `dsh-session-move` when it is mounted; it never moves anything itself. After migration, use dsh-session-move for cold-session workspace moves. Full move capability depends on that project's DSH patch series; see `docs/session-move-interop.md`.

## Safety boundaries

- `~/.claude` is read-only for migration. Export/sync never write the original Claude directory by default.
- DSH writes go only through host persistence (`$DSH_HOME/sessions`), the DSH-native skill root (`$DSH_HOME/skills`), and the sidecar registry (`$DSH_HOME/claude2dsh`).
- Validation always uses an experimental copy of source data, never the live original.

## Repository layout

```
src/                                 root bundle: sessionSources registry plugin
packages/core/                       normalized session IR + DSH event synthesis + tail logic
packages/adapters/claude-code/       Claude Code adapter
packages/plugin/                     DSH plugin bundle: @claude2dsh/plugin
scripts/e2e-round*.sh                reproducible acceptance runs
docs/                                design notes, surveys and validation records
```

## Development validation

```sh
pnpm install
pnpm run check
pnpm -r build && pnpm -r typecheck && pnpm -r test

CLAUDE2DSH_SOURCE_BACKUP=/tmp/claude2dsh-source-backup bash scripts/e2e-round1.sh
CLAUDE2DSH_SOURCE_BACKUP=/tmp/claude2dsh-source-backup bash scripts/e2e-round2-claude-recognition.sh
CLAUDE2DSH_SOURCE_BACKUP=/tmp/claude2dsh-source-backup bash scripts/e2e-round3-bidirectional.sh
CLAUDE2DSH_SOURCE_BACKUP=/tmp/claude2dsh-source-backup bash scripts/e2e-round4-subagents.sh
bash scripts/e2e-round7-merge.sh
```

Round 2 and round 3 use the real `claude` binary against a local mock Anthropic endpoint; no real API request is made in those scripts.

## License and acknowledgements

MIT. The design was benchmarked against `dsh-chat-import` (MIT) and `dsh-claude-move` (Apache-2.0); thanks to both projects for their useful reference points. Hook compatibility delegates to the official DeepSeek Harness hook bridge package.
