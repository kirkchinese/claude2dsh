#!/usr/bin/env bash
# Round 3 acceptance: continued conversations are recognized in both directions.
# A: a Claude Code transcript grows -> re-import appends to the same DSH log.
# B: a DSH session grows -> sync appends to the exported Claude JSONL, and the
#    real Claude Code binary recognizes the appended turn through a mock endpoint.
set -euo pipefail

SOURCE_BACKUP="${CLAUDE2DSH_SOURCE_BACKUP:-/tmp/claude2dsh-source-backup}"
SAMPLE_FILE="${CLAUDE2DSH_SAMPLE_FILE:-$(python3 - "$SOURCE_BACKUP/projects" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
for p in sorted(root.rglob('*.jsonl')):
    if 'subagents' in p.parts or 'workflows' in p.parts or p.name == 'journal.jsonl': continue
    try:
        lines = p.read_text(errors='replace').splitlines()
    except Exception:
        continue
    for line in lines[:3]:
        if '"type":"user"' in line or '"type": "user"' in line:
            print(p)
            raise SystemExit
print(sorted(root.rglob('*.jsonl'))[0])
PY
)}"
SESSION="$(basename "$SAMPLE_FILE" .jsonl)"
PROJECT_NAME="$(basename "$(dirname "$SAMPLE_FILE")")"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
WORK="$(mktemp -d /tmp/claude2dsh-e2e-r3.XXXXXX)"
MOCK_PID=''

cleanup() {
  if [ -n "$MOCK_PID" ]; then kill "$MOCK_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

make_profile() {
  local home="$1"
  mkdir -p "$home/profiles/claude2dsh-e2e"
  cat > "$home/profiles/claude2dsh-e2e/package.json" <<JSON
{"name":"dsh-profile-claude2dsh-e2e","private":true,"type":"module","dependencies":{"@claude2dsh/plugin":"link:$PWD/packages/plugin"},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@claude2dsh/plugin"]}}}
JSON
  printf '[]\n' > "$home/profiles/claude2dsh-e2e/cordis.patch.yml"
  printf '[]\n' > "$home/profiles/claude2dsh-e2e/cordis.yml"
  printf 'packages:\n  - .\n' > "$home/profiles/claude2dsh-e2e/pnpm-workspace.yaml"
  (cd "$home/profiles/claude2dsh-e2e" && pnpm install >/dev/null)
}

echo "== build =="
pnpm -r build >/dev/null

echo "== A: Claude Code side grows, DSH appends natively =="
SRC_COPY="$WORK/claude-src"
mkdir -p "$SRC_COPY/projects/$PROJECT_NAME"
cp "$SAMPLE_FILE" "$SRC_COPY/projects/$PROJECT_NAME/$SESSION.jsonl"
SRC_FILE="$SRC_COPY/projects/$PROJECT_NAME/$SESSION.jsonl"
HOME_A="$WORK/home-a"
make_profile "$HOME_A"
REPORT_A1="$WORK/report-a1.json"
DSH_HOME="$HOME_A" CLAUDE2DSH_TEST_IMPORT="$SRC_FILE" CLAUDE2DSH_TEST_REPORT="$REPORT_A1" timeout 60 dsh --profile claude2dsh-e2e >/dev/null
python3 - "$SRC_FILE" <<'PY'
import json, sys, uuid
path = sys.argv[1]
lines = [line for line in open(path).read().split('\n') if line.strip()]
recs = [json.loads(line) for line in lines]
last = [r for r in recs if r.get('type') in ('user','assistant') and r.get('isSidechain') is not True and isinstance(r.get('uuid'), str)][-1]
u1, a1 = str(uuid.uuid4()), str(uuid.uuid4())
now = '2026-08-15T15:00:00.000Z'
base = {'sessionId': last.get('sessionId'), 'cwd': last.get('cwd', '/tmp/p'), 'version': last.get('version', '0.0.0'), 'gitBranch': last.get('gitBranch', ''), 'entrypoint': last.get('entrypoint', 'claude2dsh-test'), 'userType': 'external'}
recs.append({**base, 'type': 'user', 'uuid': u1, 'parentUuid': last['uuid'], 'isSidechain': False, 'timestamp': now, 'message': {'role': 'user', 'content': 'Incremental prompt appended by Claude Code test'}})
recs.append({**base, 'type': 'assistant', 'uuid': a1, 'parentUuid': u1, 'isSidechain': False, 'timestamp': now, 'message': {'id': 'msg_test_append', 'role': 'assistant', 'model': last.get('message', {}).get('model', 'claude-test'), 'content': [{'type': 'text', 'text': 'Incremental assistant reply appended by Claude Code test'}], 'usage': {'input_tokens': 0, 'output_tokens': 0}}})
open(path, 'w').write('\n'.join(json.dumps(r) for r in recs) + '\n')
PY
REPORT_A2="$WORK/report-a2.json"
DSH_HOME="$HOME_A" CLAUDE2DSH_TEST_IMPORT="$SRC_FILE" CLAUDE2DSH_TEST_REPORT="$REPORT_A2" timeout 60 dsh --profile claude2dsh-e2e >/dev/null
EXPECTED_EVENTS="$(python3 - "$REPORT_A2" <<'PY'
import json, sys
a2 = json.load(open(sys.argv[1]))
item = a2['report']['items'][0]
print(a2['inspected'][item['sessionId']]['eventCount'])
PY
)"
python3 - "$REPORT_A1" "$REPORT_A2" <<'PY'
import json, sys
a1 = json.load(open(sys.argv[1]))
a2 = json.load(open(sys.argv[2]))
item = a2['report']['items'][0]
assert item['status'] == 'appended', item
assert item['turns'] == a1['report']['items'][0]['turns'] + 1, item
inspected = a2['inspected'][item['sessionId']]
assert inspected['eventCount'] == item['events'], inspected
print(f"A_OK appended turns={item['turns']} events={inspected['eventCount']}")
PY

echo "== A guard: shrunken source refuses rewrite =="
python3 - "$SRC_FILE" <<'PY'
import json, sys
path = sys.argv[1]
lines = [line for line in open(path).read().split('\n') if line.strip()]
open(path, 'w').write('\n'.join(lines[:3]) + '\n')
PY
REPORT_A3="$WORK/report-a3.json"
DSH_HOME="$HOME_A" CLAUDE2DSH_TEST_IMPORT="$SRC_FILE" CLAUDE2DSH_TEST_REPORT="$REPORT_A3" timeout 60 dsh --profile claude2dsh-e2e >/dev/null
python3 - "$REPORT_A3" "$EXPECTED_EVENTS" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
expected = int(sys.argv[2])
item = data['report']['items'][0]
assert item['status'] == 'source-shrunk', item
inspected = data['inspected'][item['sessionId']]
assert inspected['eventCount'] == expected, inspected
print(f"A_GUARD_OK status={item['status']} native-events-unchanged={inspected['eventCount']}")
PY

echo "== B: DSH side grows, exported Claude JSONL receives append =="
HOME_B="$WORK/home-b"
make_profile "$HOME_B"
cat > "$WORK/append-turn.json" <<'JSON'
[
  {"type":"turn/start","time":1786990000000,"data":{"turn":7}},
  {"type":"step/start","time":1786990000000,"data":{"turn":7,"step":1}},
  {"type":"user/message","time":1786990000000,"surfaceOp":"append","data":{"id":"claude2dsh:append:u7","role":"user","content":[{"type":"text","text":"Please continue from DSH side."}],"source":{"kind":"user"}}},
  {"type":"assistant/message","time":1786990001000,"surfaceOp":"append","data":{"turn":7,"step":1,"message":{"id":"claude2dsh:append:a7","role":"assistant","content":[{"type":"text","text":"This turn was appended by the DSH side and must appear on the Claude side after sync."}],"source":{"kind":"model","provider":"claude-code","model":"claude-code"}}}},
  {"type":"step/end","time":1786990001000,"data":{"turn":7,"step":1}},
  {"type":"turn/end","time":1786990001000,"data":{"turn":7,"reason":{"kind":"completed"}}}
]
JSON
REPORT_B="$WORK/report-b.json"
DSH_HOME="$HOME_B" \
CLAUDE2DSH_TEST_IMPORT="$SAMPLE_FILE" \
CLAUDE2DSH_TEST_EXPORT="claude-$SESSION" \
CLAUDE2DSH_TEST_APPEND_EVENTS="$WORK/append-turn.json" \
CLAUDE2DSH_TEST_APPEND_AFTER_EXPORT=1 \
CLAUDE2DSH_TEST_SYNC=1 \
CLAUDE2DSH_TEST_REPORT="$REPORT_B" \
timeout 60 dsh --profile claude2dsh-e2e >/dev/null
python3 - "$REPORT_B" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
sync = report['syncReport']
assert sync['status'] == 'synced', sync
assert sync['appendedTurns'] == 1 and sync['appendedEvents'] == 6, sync
file_path = report['exportReport']['filePath']
recs = [json.loads(line) for line in open(file_path).read().split('\n') if line.strip()]
assert any('This turn was appended by the DSH side' in json.dumps(r) for r in recs)
print(f"B_OK synced records={sync['appendedRecords']} events={sync['appendedEvents']} anchor={sync['writeback']['anchorUuid']}")
open(sys.argv[1].replace('report-b.json','export-path'), 'w').write(file_path)
PY
EXPORT_FILE="$(cat "$WORK/export-path")"

echo "== B recognition by real Claude Code (mock endpoint, no real API) =="
cat > "$WORK/mock.py" <<'PY'
import http.server, json, os
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('content-length', '0')))
        with open(os.environ['LOG'], 'ab') as f:
            f.write(b'=== REQUEST ' + self.path.encode() + b' ===\n' + body + b'\n')
        payload = json.dumps({'type': 'error', 'error': {'type': 'authentication_error', 'message': 'mock'}}).encode()
        self.send_response(401)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
    def log_message(self, *args): pass
http.server.HTTPServer(('127.0.0.1', 18798), H).serve_forever()
PY
MOCK_LOG="$WORK/mock.log"
LOG="$MOCK_LOG" PORT=18798 nohup python3 "$WORK/mock.py" >"$WORK/mock.out" 2>&1 &
MOCK_PID=$!
sleep 0.5
CLAUDE_HOME="$WORK/claude-home"
UUID="$(basename "$EXPORT_FILE" .jsonl)"
mkdir -p "$CLAUDE_HOME/projects/$PROJECT_NAME"
cp "$EXPORT_FILE" "$CLAUDE_HOME/projects/$PROJECT_NAME/"
set +e
timeout 25 env CLAUDE_CONFIG_DIR="$CLAUDE_HOME" ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:18798 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 "$CLAUDE_BIN" --resume "$UUID" --print "continue please" --output-format json >"$WORK/claude.out" 2>"$WORK/claude.err"
set -e
python3 - "$MOCK_LOG" <<'PY'
import json, sys
raw = open(sys.argv[1], 'rb').read()
parts = raw.split(b'=== REQUEST ')
assert len(parts) >= 2
body = parts[1].split(b'\n', 1)[1]
request = json.loads(body)
assert 'This turn was appended by the DSH side' in json.dumps(request['messages'])
print(f"B_RECOGNIZED messages={len(request['messages'])} requests={len(parts)-1}")
PY
echo "ROUND3_OK"
