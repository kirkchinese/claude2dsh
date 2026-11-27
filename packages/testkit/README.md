# Harness Forge end-to-end test

A small smoke test that boots a **real DSH** with the **packed** plugin installed and a **scripted model**, and checks
what Harness Forge visibly does. It exists to catch DSH upgrades that break the plugin: DSH's plugin surface is pre-1.0,
and the plugin relies on two DSH internals (see the
[architecture](../../docs/architecture/overview.md#dsh-surface)). There is no third-party download and no model key: every fixture is in `fixtures/`.

## Run

```sh
pnpm install
pnpm e2e            # all checks
pnpm e2e hook       # only checks whose name contains "hook"
```

It uses the `dsh` on `PATH` (CI runs DSH `0.2.2-rc.5` and the floor `0.2.2-rc.3`), needs network for `pnpm`
to install the plugin's dependencies, takes about a minute, prints a pass/fail table and exits non-zero on a failure.
`pnpm --filter @kirkchinese/harness-forge-testkit test` runs the unit tests of the pure helpers.

Environment: `E2E_KEEP=1` keeps the sandbox directory (its path is printed); `E2E_LOGS=<dir>` copies every session's
model requests, events and stderr there.

## What happens

1. A sandbox is made in the OS temp directory: its own `DSH_HOME` and `HOME`. Nothing under your real `~/.dsh`,
   `~/.claude` or a running `dsh web` is read or touched; the only server is the scripted model on a random port.
2. `core` and `plugin` are built and packed, a fresh profile is created from DSH's headless template, and the tarballs
   are installed with `dsh plugin add`, so the plugin's own `cordis.patch.yml` decides what is enabled.
3. The Web agent plane (agent presets and delegation) is layered on the headless profile, plus `lab-plugin`, a
   test-only DSH plugin that gives the scripted model `lab_command` (run a slash command) and `lab_remote` (call a
   Remote method, as the browser does).
4. Each check runs one headless session: the model's replies are scripted, and the check asserts what was observed.
5. The sandbox and every child process are removed, also after a failure.

## Checks

| Check | Observed behaviour |
| --- | --- |
| `skill` | the plugin skill is in the model's skill catalog and `skill` loads its body |
| `command` | `/e2e-claude-e2e-greet World` is dispatched and its expanded body, with the argument, reaches the model |
| `agent` | the plugin agent is offered by the `agent` tool, runs under its own prompt, and its answer returns to the parent |
| `hook-runs` | the `PreToolUse` hook (`${CLAUDE_PLUGIN_ROOT}` script) ran: it logged the tool call, which still executed |
| `hook-deny` | the hook's deny decision blocked the tool call, its reason reached the model, and the command did not run |
| `mcp` | the stdio MCP server's tool is offered to the model and a call returns its result |
| `user-setup` | a `~/.claude` skill loads and its `settings.json` hook runs |
| `codex-plugin` | a Codex plugin's skill loads |
| `instructions` | `~/.claude/CLAUDE.md`, `.claude/CLAUDE.md` and an `@import` reach the system prompt; the project `CLAUDE.md` is left to DSH and not added twice |
| `session-import` | a Claude Code transcript imports through the plugin's Remote API, is live at once (opens without a restart) in the workspace of its directory, and continues in DSH with its history |
| `plugin-install` | a session installs a local bundle (`fixtures/noop-bundle`) with `plugin_manager` `install_bundle`, as Fill with AI's agent does: the call returns, the bundle is applied live (HMR on) and listed enabled. pnpm 11 can finish the first install in the profile and not exit; the check bounds that with a 20 s `idleTimeoutMs` and retries once, as the port prompt tells the agent |

## Layout

- `fixtures/claude-plugin`, `fixtures/codex-plugin`, `fixtures/claude-home/.claude`, `fixtures/sessions`, `fixtures/noop-bundle`: the inputs.
- `lab-plugin`: the test-only DSH plugin.
- `src/main.ts` the entry; `src/dsh.ts` sandbox, packing, profile and sessions; `src/checks.ts` the checks;
  `src/mock-llm.ts` the scripted model; `src/helpers.ts` the pure helpers.

## When a check fails after a DSH upgrade

Run it with `E2E_KEEP=1`, read `logs/<session>.json` in the sandbox: it holds the tools and messages the model
received, DSH's JSON events, and stderr. Names the checks rely on are constants at the top of `src/checks.ts` and
`src/dsh.ts` (command and agent naming, the MCP tool name, the Remote namespace, the plugin's loader row).
