#!/usr/bin/env bash
# Round 4 acceptance: subagent/workflow transcripts are discoverable,
# importable as child DSH sessions, and readable by DSH native persistence.
set -euo pipefail

SOURCE_BACKUP="${CLAUDE2DSH_SOURCE_BACKUP:-/tmp/claude2dsh-source-backup}"
E2E_HOME="$(mktemp -d /tmp/claude2dsh-e2e-r4.XXXXXX)"
PROFILE="$E2E_HOME/profiles/claude2dsh-e2e"
REPORT="$E2E_HOME/report.json"
cleanup() { rm -rf "$E2E_HOME"; }
trap cleanup EXIT

echo "== build =="
pnpm -r build >/dev/null
mkdir -p "$PROFILE"
cat > "$PROFILE/package.json" <<JSON
{"name":"dsh-profile-claude2dsh-e2e","private":true,"type":"module","dependencies":{"@claude2dsh/plugin":"link:$PWD/packages/plugin"},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@claude2dsh/plugin"]}}}
JSON
printf '[]\n' > "$PROFILE/cordis.patch.yml"
printf '[]\n' > "$PROFILE/cordis.yml"
printf 'packages:\n  - .\n' > "$PROFILE/pnpm-workspace.yaml"
(cd "$PROFILE" && pnpm install >/dev/null)

echo "== import main + subagent transcripts =="
DSH_HOME="$E2E_HOME" \
CLAUDE2DSH_TEST_IMPORT="$SOURCE_BACKUP/projects" \
CLAUDE2DSH_TEST_INCLUDE_SUBAGENTS=1 \
CLAUDE2DSH_TEST_REPORT="$REPORT" \
timeout 300 dsh --profile claude2dsh-e2e

python3 - "$REPORT" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))['report']
assert report['imported'] == 782, report
assert report['failed'] == 0, report
data = json.load(open(sys.argv[1]))
assert len(data['persistedSessions']) == 782
assert len(data['inspected']) == 782
assert all(v.get('error') is None for v in data['inspected'].values())
assert any(v['header'].get('origin') == 'subagent' and v['header'].get('parentSession') for v in data['inspected'].values())
print(f"R4_OK imported={report['imported']} skipped={report['skipped']} inspected={len(data['inspected'])}")
PY
