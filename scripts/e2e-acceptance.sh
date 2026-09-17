#!/usr/bin/env bash
# End-to-end acceptance against one installed DSH CLI, in an isolated DSH_HOME.
#
# Proves, on the DSH release named by DSH_BIN, that Claude2DSH:
#   1. imports a Claude Code transcript into a current-format DSH session,
#   2. re-reads it through the persistence handle API and derives model history,
#   3. re-imports idempotently,
#   4. exports it back to Claude JSONL,
#   5. detects two-sided growth as a conflict, merges it into a new session,
#   6. appends later DSH turns to the exported Claude copy.
#
# Usage: scripts/e2e-acceptance.sh [dsh-binary]
#   dsh-binary   CLI to test; defaults to `dsh` on PATH.
#
# The real ~/.claude tree is never read or written: the source is synthetic.
set -euo pipefail

DSH_BIN="${1:-${DSH_BIN:-dsh}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAB="$(mktemp -d "${TMPDIR:-/tmp}/claude2dsh-acceptance.XXXXXX")"
HOME_DIR="$LAB/home"
PROFILE_DIR="$HOME_DIR/profiles/acceptance"
SOURCE="$LAB/source/projects/demo-project"
SESSION_UUID="11111111-2222-4333-8444-555555555555"
SESSION_ID="claude-$SESSION_UUID"

cleanup() { rm -rf "$LAB"; }
trap cleanup EXIT

echo "== dsh under test =="
"$DSH_BIN" --version

echo "== build =="
(cd "$ROOT" && CI=true pnpm -r build >/dev/null)

echo "== acceptance profile =="
mkdir -p "$PROFILE_DIR" "$SOURCE"
cat > "$PROFILE_DIR/package.json" <<JSON
{
  "name": "dsh-profile-claude2dsh-acceptance",
  "private": true,
  "type": "module",
  "dependencies": {
    "@claude2dsh/plugin": "link:$ROOT/packages/plugin"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@claude2dsh/plugin"]
    }
  }
}
JSON
printf '[]\n' > "$PROFILE_DIR/cordis.patch.yml"
printf '[]\n' > "$PROFILE_DIR/cordis.yml"
printf 'packages:\n  - .\n' > "$PROFILE_DIR/pnpm-workspace.yaml"
(cd "$PROFILE_DIR" && CI=true pnpm install ${PNPM_STORE_DIR:+--store-dir "$PNPM_STORE_DIR"} >/dev/null)

echo "== synthetic Claude source (no ~/.claude access) =="
cat > "$SOURCE/$SESSION_UUID.jsonl" <<JSONL
{"type":"mode","mode":"normal","sessionId":"$SESSION_UUID"}
{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"cwd":"/tmp/demo","sessionId":"$SESSION_UUID","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":"list the working directory"}}
{"type":"assistant","uuid":"a1","parentUuid":"u1","isSidechain":false,"cwd":"/tmp/demo","sessionId":"$SESSION_UUID","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"I will list it."},{"type":"tool_use","id":"call_1","name":"Bash","input":{"command":"ls"}}]}}
{"type":"user","uuid":"t1","parentUuid":"a1","isSidechain":false,"cwd":"/tmp/demo","sessionId":"$SESSION_UUID","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":[{"type":"text","text":"README.md"}]}]}}
{"type":"assistant","uuid":"a2","parentUuid":"t1","isSidechain":false,"cwd":"/tmp/demo","sessionId":"$SESSION_UUID","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"Only README.md is present."}]}}
JSONL

echo "== round 1: import + native read =="
DSH_HOME="$HOME_DIR" \
CLAUDE2DSH_TEST_IMPORT="$LAB/source/projects" \
CLAUDE2DSH_TEST_PREPARE=1 \
CLAUDE2DSH_TEST_REPORT="$LAB/report1.json" \
timeout 300 "$DSH_BIN" --profile acceptance

echo "== round 2: export + DSH growth + merge + sync =="
cat > "$LAB/append-events.json" <<'JSON'
[
  { "type": "turn/start", "time": 1767225610000, "data": { "turn": 2 } },
  { "type": "step/start", "time": 1767225610000, "data": { "turn": 2, "step": 1 } },
  { "type": "user/message", "time": 1767225610000, "data": { "id": "claude2dsh:test:u2", "role": "user", "content": [{ "type": "text", "text": "and now?" }], "source": { "kind": "user" } }, "surfaceOp": "append" },
  { "type": "step/end", "time": 1767225610000, "data": { "turn": 2, "step": 1 } },
  { "type": "turn/end", "time": 1767225610000, "data": { "turn": 2, "reason": { "kind": "completed" } } }
]
JSON
DSH_HOME="$HOME_DIR" \
CLAUDE2DSH_TEST_IMPORT="$LAB/source/projects" \
CLAUDE2DSH_TEST_PREPARE=1 \
CLAUDE2DSH_TEST_EXPORT="$SESSION_ID" \
CLAUDE2DSH_TEST_EXPORT_DIR="$LAB/exports" \
CLAUDE2DSH_TEST_APPEND_EVENTS="$LAB/append-events.json" \
CLAUDE2DSH_TEST_SYNC=1 \
CLAUDE2DSH_TEST_REPORT="$LAB/report2.json" \
timeout 300 "$DSH_BIN" --profile acceptance

echo "== round 3: two-sided growth conflict + three-way merge =="
cat >> "$SOURCE/$SESSION_UUID.jsonl" <<JSONL
{"type":"user","uuid":"u2","parentUuid":"a2","isSidechain":false,"cwd":"/tmp/demo","sessionId":"$SESSION_UUID","timestamp":"2026-01-01T00:00:10.000Z","message":{"role":"user","content":"claude side new turn"}}
{"type":"assistant","uuid":"a3","parentUuid":"u2","isSidechain":false,"cwd":"/tmp/demo","sessionId":"$SESSION_UUID","timestamp":"2026-01-01T00:00:11.000Z","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"claude side answer"}]}}
JSONL
DSH_HOME="$HOME_DIR" \
CLAUDE2DSH_TEST_IMPORT="$LAB/source/projects" \
CLAUDE2DSH_TEST_MERGE=1 \
CLAUDE2DSH_TEST_MERGE_SESSION="$SESSION_ID" \
CLAUDE2DSH_TEST_REPORT="$LAB/report3.json" \
timeout 300 "$DSH_BIN" --profile acceptance

echo "== round 4: agents, commands and MCP servers =="
mkdir -p "$LAB/source/agents" "$LAB/source/commands/git"
cat > "$LAB/source/agents/reviewer.md" <<'MD'
---
name: reviewer
description: Reviews a diff for correctness
tools: Read, Bash
---
You review diffs.
MD
cat > "$LAB/source/commands/git/commit.md" <<'MD'
---
description: Commit staged changes
argument-hint: "[message]"
---
Create a commit.
MD
cat > "$LAB/source/claude.json" <<'JSON'
{
  "mcpServers": {
    "demo": { "command": "node", "args": ["-e", "process.exit(0)"] },
    "docs": { "type": "http", "url": "https://example.test/mcp" },
    "legacy-sse": { "type": "sse", "url": "https://example.test/sse" }
  }
}
JSON
DSH_HOME="$HOME_DIR" \
CLAUDE2DSH_TEST_IMPORT="$LAB/source/projects" \
CLAUDE2DSH_TEST_AGENTS="$LAB/source/agents" \
CLAUDE2DSH_TEST_COMMANDS="$LAB/source/commands" \
CLAUDE2DSH_TEST_MCP="$LAB/source/claude.json" \
CLAUDE2DSH_TEST_MCP_APPLY=1 \
CLAUDE2DSH_TEST_REPORT="$LAB/report4.json" \
timeout 300 "$DSH_BIN" --profile acceptance

echo "== round 5: the generated MCP layer composes in a real profile =="
DSH_HOME="$HOME_DIR" timeout 180 "$DSH_BIN" --profile acceptance \
  --patch "$HOME_DIR/claude2dsh/mcp.patch.yml" --dump-config > "$LAB/dump-config.txt" 2>&1
grep -q 'dsh-mcp-client' "$LAB/dump-config.txt"
grep -q 'serverName: demo' "$LAB/dump-config.txt"
grep -q 'serverName: docs' "$LAB/dump-config.txt"

echo "== assert =="
node "$ROOT/scripts/assert-acceptance.mjs" "$HOME_DIR" "$LAB/report1.json" "$LAB/report2.json" "$LAB/report3.json" "$LAB/report4.json" "$SESSION_ID" "$LAB/exports"
echo "ACCEPTANCE_OK $("$DSH_BIN" --version)"
