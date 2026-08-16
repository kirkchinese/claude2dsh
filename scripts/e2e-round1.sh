#!/usr/bin/env bash
# Round 1 acceptance: Claude Code sessions + skills -> DSH native read.
# Runs against the experimental backup only; ~/.claude is never touched.
set -euo pipefail

SOURCE_BACKUP="${CLAUDE2DSH_SOURCE_BACKUP:-/tmp/claude2dsh-source-backup}"
E2E_HOME="$(mktemp -d /tmp/claude2dsh-e2e-home.XXXXXX)"
PROFILE="$E2E_HOME/profiles/claude2dsh-e2e"
REPORT="$E2E_HOME/report.json"
REPORT_RERUN="$E2E_HOME/report-rerun.json"

cleanup() {
  rm -rf "$E2E_HOME"
}
trap cleanup EXIT

echo "== build =="
pnpm -r build >/dev/null

echo "== profile =="
mkdir -p "$PROFILE"
cat > "$PROFILE/package.json" <<JSON
{
  "name": "dsh-profile-claude2dsh-e2e",
  "private": true,
  "type": "module",
  "dependencies": {
    "@claude2dsh/plugin": "link:$PWD/packages/plugin"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@claude2dsh/plugin"]
    }
  }
}
JSON
printf '[]\n' > "$PROFILE/cordis.patch.yml"
printf '[]\n' > "$PROFILE/cordis.yml"
printf 'packages:\n  - .\n' > "$PROFILE/pnpm-workspace.yaml"
(cd "$PROFILE" && pnpm install >/dev/null)

echo "== import (full backup projects + skills) =="
DSH_HOME="$E2E_HOME" \
CLAUDE2DSH_TEST_IMPORT="$SOURCE_BACKUP/projects" \
CLAUDE2DSH_TEST_SKILLS=1 \
CLAUDE2DSH_TEST_SKILLS_ROOT="$SOURCE_BACKUP/skills" \
CLAUDE2DSH_TEST_PREPARE=1 \
CLAUDE2DSH_TEST_REPORT="$REPORT" \
timeout 180 dsh --profile claude2dsh-e2e

echo "== assert =="
node "$PWD/scripts/assert-round1.mjs" "$REPORT" 57

echo "== idempotency re-run =="
DSH_HOME="$E2E_HOME" \
CLAUDE2DSH_TEST_IMPORT="$SOURCE_BACKUP/projects" \
CLAUDE2DSH_TEST_SKILLS=1 \
CLAUDE2DSH_TEST_SKILLS_ROOT="$SOURCE_BACKUP/skills" \
CLAUDE2DSH_TEST_PREPARE=1 \
CLAUDE2DSH_TEST_REPORT="$REPORT_RERUN" \
timeout 180 dsh --profile claude2dsh-e2e

node "$PWD/scripts/assert-round1.mjs" "$REPORT_RERUN" 0 --already-imported 57 --skills-skipped 39
echo "ROUND1_OK"
