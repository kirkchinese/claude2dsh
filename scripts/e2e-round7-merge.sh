#!/usr/bin/env bash
# Round 7 acceptance: explicit three-way merge after double-side growth.
# Fixtures are synthesized in a temporary directory; no real ~/.claude is read.
set -euo pipefail

E2E_HOME="$(mktemp -d /tmp/claude2dsh-e2e-r7.XXXXXX)"
PROFILE="$E2E_HOME/profiles/claude2dsh-e2e"
WORK="$E2E_HOME/work"
REPORT1="$E2E_HOME/report1.json"
REPORT2="$E2E_HOME/report2.json"
REPORT3="$E2E_HOME/report3.json"
cleanup() { rm -rf "$E2E_HOME"; }
trap cleanup EXIT

echo "== build =="
pnpm -r build >/dev/null

mkdir -p "$PROFILE" "$WORK"
cat > "$PROFILE/package.json" <<JSON
{"name":"dsh-profile-claude2dsh-e2e","private":true,"type":"module","dependencies":{"@claude2dsh/plugin":"link:$PWD/packages/plugin"},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@claude2dsh/plugin"]}}}
JSON
printf '[]\n' > "$PROFILE/cordis.patch.yml"
printf '[]\n' > "$PROFILE/cordis.yml"
printf 'packages:\n  - .\n' > "$PROFILE/pnpm-workspace.yaml"
(cd "$PROFILE" && pnpm install >/dev/null)

python3 - "$WORK" <<'PY'
import json, sys
from pathlib import Path
work = Path(sys.argv[1])
sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
rows = [
    {'type': 'mode', 'mode': 'normal', 'sessionId': sid},
    {'type': 'user', 'uuid': 'u1', 'parentUuid': None, 'isSidechain': False, 'cwd': '/tmp/p', 'sessionId': sid, 'timestamp': '2026-01-01T00:00:00.000Z', 'message': {'role': 'user', 'content': 'base prompt'}},
    {'type': 'assistant', 'uuid': 'a1', 'parentUuid': 'u1', 'isSidechain': False, 'cwd': '/tmp/p', 'sessionId': sid, 'timestamp': '2026-01-01T00:00:01.000Z', 'message': {'role': 'assistant', 'model': 'm', 'content': [{'type': 'text', 'text': 'base answer'}]}},
]
(work / f'{sid}.jsonl').write_text('\n'.join(json.dumps(r) for r in rows) + '\n')
# DSH growth: turn 2 with a different answer.
events = [
    {'type': 'turn/start', 'seq': 0, 'time': 20, 'data': {'turn': 2}},
    {'type': 'step/start', 'seq': 1, 'time': 20, 'data': {'turn': 2, 'step': 1}},
    {'type': 'user/message', 'seq': 2, 'time': 20, 'data': {'id': 'u2', 'role': 'user', 'content': [{'type': 'text', 'text': 'dsh continuation'}], 'source': {'kind': 'user'}}, 'surfaceOp': 'append'},
    {'type': 'assistant/message', 'seq': 3, 'time': 20, 'data': {'turn': 2, 'step': 1, 'message': {'id': 'a2', 'role': 'assistant', 'content': [{'type': 'text', 'text': 'dsh-version'}], 'source': {'kind': 'model', 'provider': 'claude-code', 'model': 'claude-code'}}}, 'surfaceOp': 'append'},
    {'type': 'step/end', 'seq': 4, 'time': 20, 'data': {'turn': 2, 'step': 1}},
    {'type': 'turn/end', 'seq': 5, 'time': 20, 'data': {'turn': 2, 'reason': {'kind': 'completed'}}},
]
(work / 'dsh-turn2.json').write_text(json.dumps(events))
# Claude growth: same turn number with a different answer.
(work / f'{sid}.extra.jsonl').write_text(
    '\n'.join(json.dumps(r) for r in [
        {'type': 'user', 'uuid': 'x0', 'parentUuid': 'a1', 'isSidechain': False, 'cwd': '/tmp/p', 'sessionId': sid, 'timestamp': '2026-01-01T00:00:02.000Z', 'message': {'role': 'user', 'content': 'claude continuation'}},
        {'type': 'assistant', 'uuid': 'x1', 'parentUuid': 'x0', 'isSidechain': False, 'cwd': '/tmp/p', 'sessionId': sid, 'timestamp': '2026-01-01T00:00:03.000Z', 'message': {'role': 'assistant', 'model': 'm', 'content': [{'type': 'text', 'text': 'claude-version'}]}},
    ]) + '\n'
)
PY

echo "== import base + inject DSH growth =="
DSH_HOME="$E2E_HOME" \
CLAUDE2DSH_TEST_IMPORT="$WORK/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl" \
CLAUDE2DSH_TEST_REPORT="$REPORT1" \
CLAUDE2DSH_TEST_APPEND_EVENTS="$WORK/dsh-turn2.json" \
timeout 120 dsh --profile claude2dsh-e2e

cat "$WORK/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.extra.jsonl" >> "$WORK/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl"

echo "== explicit merge (same-turn dual edit) =="
DSH_HOME="$E2E_HOME" \
CLAUDE2DSH_TEST_IMPORT="$WORK/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl" \
CLAUDE2DSH_TEST_MERGE=1 \
CLAUDE2DSH_TEST_MERGE_SESSION="claude-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" \
CLAUDE2DSH_TEST_REPORT="$REPORT2" \
timeout 120 dsh --profile claude2dsh-e2e

echo "== export merged copy =="
MERGED_ID="$(node -e "const r=require('$REPORT2'); console.log(r.mergeReport.mergedSessionId)")"
DSH_HOME="$E2E_HOME" \
CLAUDE2DSH_TEST_IMPORT="$WORK/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl" \
CLAUDE2DSH_TEST_EXPORT="$MERGED_ID" \
CLAUDE2DSH_TEST_REPORT="$REPORT3" \
timeout 120 dsh --profile claude2dsh-e2e

node - "$REPORT1" "$REPORT2" "$REPORT3" <<'NODE'
const fs = require('node:fs')
const [r1, r2, r3] = process.argv.slice(2).map((path) => JSON.parse(fs.readFileSync(path, 'utf8')))
const first = r1.report.items[0]
if (first.status !== 'imported') throw new Error(`expected imported, got ${first.status}`)
if (r2.report.items[0].status !== 'conflict') throw new Error('expected conflict on re-import')
const m = r2.mergeReport
if (m.status !== 'merged') throw new Error(`expected merged, got ${m.status}`)
if (m.conflicts !== 1) throw new Error(`expected one conflict, got ${m.conflicts}`)
if (!Number.isInteger(m.mergedEventCount) || m.mergedEventCount <= first.events) throw new Error(`bad merged event count ${m.mergedEventCount}`)
if (!Number.isInteger(m.mergedDerivedMessages) || m.mergedDerivedMessages < 2) throw new Error(`bad derived messages ${m.mergedDerivedMessages}`)
const exp = r3.exportReport
if (exp.status !== 'exported') throw new Error(`export failed: ${exp.status}`)
const text = fs.readFileSync(exp.filePath, 'utf8')
const lines = text.trim().split('\n').filter((line) => line.length > 0)
const seen = new Set()
for (const line of lines) {
  const rec = JSON.parse(line)
  if (rec.uuid !== undefined) {
    if (seen.has(rec.uuid)) throw new Error(`duplicate uuid ${rec.uuid}`)
    seen.add(rec.uuid)
    if (rec.parentUuid !== undefined && rec.parentUuid !== null && !seen.has(rec.parentUuid)) throw new Error(`orphan parent ${rec.parentUuid}`)
  }
}
if (!text.includes('dsh-version')) throw new Error('merged export is missing DSH version')
if (!text.includes('claude-version')) throw new Error('merged export is missing Claude version')
console.log(`ROUND7_OK conflicts=${m.conflicts} events=${m.mergedEventCount} messages=${m.mergedDerivedMessages} exported=${exp.recordCount}`)
NODE
