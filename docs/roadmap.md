# Post-release roadmap

Priorities are judged against the project mainline: Claude users should be able to move into DSH with minimal configuration and near-native continuity.

## Verified fact: DSH already reads CLAUDE.md

Before implementing any CLAUDE.md → AGENTS.md converter, the actual DSH mechanism was checked in the installed package
`@deepseek-ai/dsh-agent-instructions`:

- Default project candidates are exactly `['AGENTS.md', 'CLAUDE.md']`.
- Project root is the nearest ancestor containing `.git`.
- The user-global file is always `$DSH_HOME/AGENTS.md`.
- Sibling files whose trimmed content is identical are deduplicated; distinct `AGENTS.md` and `CLAUDE.md` are both loaded.
- Refresh is touch-driven (filesystem tools/resume), not a watcher.

Consequence: **do not copy project CLAUDE.md to AGENTS.md**. DSH already reads project CLAUDE.md natively. The only useful conversion is the user-global `~/.claude/CLAUDE.md` (when present) → `$DSH_HOME/AGENTS.md`, with preview/conflict rules. There is no need for a self-made injection channel; the mechanism to use is `dsh-agent-instructions` itself.

## Candidate list

| # | Candidate | Effort | Priority | Notes |
| --- | --- | --- | --- | --- |
| 1 | Claude context migration: user-global `~/.claude/CLAUDE.md` → `$DSH_HOME/AGENTS.md` (preview, never overwrite), project CLAUDE.md left untouched because DSH reads it | 0.5–1 day | High | First release already ships session/skill migration; context is the biggest remaining "out-of-box" gap. |
| 2 | Claude memory migration: `<project>/memory/*.md` and `MEMORY.md` → generated DSH skills or project-level instruction bundle | 1–2 days | High | Memory is project-scoped and non-skill-shaped; choose skill packaging over prompt injection to keep DSH-native discovery. |
| 3 | Tool-result text sidecar migration: copy 368 `.txt` files and replace path references with safe placeholders or inline under a size cap | 2–3 days | Medium | 102 MiB source data; default should preserve references and copy, not inline everything. |
| 4 | Import performance and progress: streaming parse + batch persistence + tool progress for full `~/.claude/projects` | 2–3 days | Medium | Current full import is seconds for 783 files, but UX needs progress and memory-bounded parsing for very large transcripts. |
| 5 | Bidirectional concurrent conflict merge: when both sides append concurrently, merge complete turns instead of refusing | 3–5 days + tests | Medium | Explicit-tool path is already safe; auto-mirror beta must not enable this until merge exists. |
| 6 | Auto-mirror hardening and exit beta | 2–4 days | Medium | Add live-session skip, queue persistence, observability, and failure injection tests. |
| 7 | Hook semantic expansion (upstream or fork): add more of the 23 unsupported events / handler types | 0.5–2 days per event | Low | Value is real but bounded; command-only 7/30 is already documented. |
| 8 | Vision model real acceptance: verify native image path with an actual image-capable DSH route | 0.5 day when route exists | Low now, high later | Blocked on a vision-capable route. |
| 9 | Codex session-source adapter | 3–5 days | Low | Reuses the existing adapter contract and IR; good test of the multi-tool claim. |
| 10 | Plugin directory inclusion | PR prep: 0.5 day | Low | Official DSH channel does not exist (re-verified 2026-08-16). Community `awesome-dsh-plugin` accepts PRs; our repo meets all requirements; PR draft in `docs/research-plugin-directory.md`, submission submitted: awesome-dsh-plugin PR #968 (pending review). |
