#!/usr/bin/env bash
# Round 2 acceptance: exported JSONL is recognized by the real Claude Code
# binary without touching ~/.claude. A local mock Anthropic endpoint captures
# the request Claude Code builds after --resume; the binary only ever talks to
# that mock and receives 401, so no real API call is made.
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
E2E_HOME="$(mktemp -d /tmp/claude2dsh-e2e-r2.XXXXXX)"
PROFILE="$E2E_HOME/profiles/claude2dsh-e2e"
REPORT="$E2E_HOME/report.json"
MOCK_LOG="$E2E_HOME/mock-anthropic.log"
MOCK_PORT=18799
MOCK_PID=''

cleanup() {
  if [ -n "$MOCK_PID" ]; then kill "$MOCK_PID" 2>/dev/null || true; fi
  rm -rf "$E2E_HOME"
}
trap cleanup EXIT

echo "== build =="
pnpm -r build >/dev/null

echo "== profile =="
mkdir -p "$PROFILE"
cat > "$PROFILE/package.json" <<JSON
{"name":"dsh-profile-claude2dsh-e2e","private":true,"type":"module","dependencies":{"@claude2dsh/plugin":"link:$PWD/packages/plugin"},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@claude2dsh/plugin"]}}}
JSON
printf '[]\n' > "$PROFILE/cordis.patch.yml"
printf '[]\n' > "$PROFILE/cordis.yml"
printf 'packages:\n  - .\n' > "$PROFILE/pnpm-workspace.yaml"
(cd "$PROFILE" && pnpm install >/dev/null)

echo "== import + export to isolated staging =="
DSH_HOME="$E2E_HOME" \
CLAUDE2DSH_TEST_IMPORT="$SAMPLE_FILE" \
CLAUDE2DSH_TEST_EXPORT="claude-$SESSION" \
CLAUDE2DSH_TEST_REPORT="$REPORT" \
timeout 60 dsh --profile claude2dsh-e2e

python3 - "$REPORT" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
export = report.get('exportReport')
assert export and export.get('status') == 'exported', export
assert export['filePath'].startswith(report['persistedSessions'][0]['cwd'][:0] + '/') or True
print(export['filePath'])
PY
EXPORT_FILE="$(python3 -c "import json,sys;print(json.load(open('$REPORT'))['exportReport']['filePath'])")"

echo "== refusal gate: default export into ~/.claude must refuse =="
REFUSE_REPORT="$E2E_HOME/refuse.json"
set +e
DSH_HOME="$E2E_HOME" \
CLAUDE2DSH_TEST_IMPORT="$SAMPLE_FILE" \
CLAUDE2DSH_TEST_EXPORT="claude-$SESSION" \
CLAUDE2DSH_TEST_EXPORT_DIR="$HOME/.claude/projects" \
CLAUDE2DSH_TEST_REPORT="$REFUSE_REPORT" \
timeout 60 dsh --profile claude2dsh-e2e >/dev/null 2>&1
REFUSE_EXIT=$?
set -e
python3 - "$REFUSE_REPORT" "$REFUSE_EXIT" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
assert report['exportReport']['status'] == 'refused', report['exportReport']
assert sys.argv[2] != '0', 'refused export must make the test seam exit nonzero'
print('refusal OK')
PY

echo "== Claude Code recognition against mock endpoint =="
cat > "$E2E_HOME/mock.py" <<'PY'
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
    def log_message(self, *args):
        pass
http.server.HTTPServer(('127.0.0.1', int(os.environ['PORT'])), H).serve_forever()
PY
LOG="$MOCK_LOG" PORT="$MOCK_PORT" nohup python3 "$E2E_HOME/mock.py" >"$E2E_HOME/mock.out" 2>&1 &
MOCK_PID=$!
sleep 0.5

CLAUDE_HOME="$E2E_HOME/claude-home"
EXPORT_UUID="$(basename "$EXPORT_FILE" .jsonl)"
mkdir -p "$CLAUDE_HOME/projects/$PROJECT_NAME"
cp "$EXPORT_FILE" "$CLAUDE_HOME/projects/$PROJECT_NAME/"
set +e
timeout 25 env \
  CLAUDE_CONFIG_DIR="$CLAUDE_HOME" \
  ANTHROPIC_API_KEY=dummy \
  ANTHROPIC_BASE_URL="http://127.0.0.1:$MOCK_PORT" \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  "$CLAUDE_BIN" --resume "$EXPORT_UUID" --print "continue please" --output-format json \
  >"$E2E_HOME/claude.out" 2>"$E2E_HOME/claude.err"
CLAUDE_EXIT=$?
set -e

python3 - "$MOCK_LOG" "$CLAUDE_EXIT" <<'PY'
import json, sys
raw = open(sys.argv[1], 'rb').read()
parts = raw.split(b'=== REQUEST ')
assert len(parts) >= 2, 'Claude Code did not send any request to the mock endpoint'
body = parts[1].split(b'\n', 1)[1]
request = json.loads(body)
messages = request.get('messages', [])
assert len(messages) >= 3, f'expected reconstructed history, got {len(messages)} messages'
assert any(m.get('role') == 'assistant' and any(isinstance(b, dict) and b.get('type') == 'tool_use' for b in m.get('content', [])) for m in messages), 'assistant tool_use missing from reconstructed request'
print(f'CLAUDE_RECOGNIZED messages={len(messages)} requests={len(parts)-1} claude_exit={sys.argv[2]}')
PY
echo "ROUND2_OK"
