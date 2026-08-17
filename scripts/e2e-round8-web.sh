#!/usr/bin/env bash
# Round 8 acceptance: empty-environment headed install yields a reachable web UI.
set -euo pipefail

E2E_HOME="$(mktemp -d /tmp/claude2dsh-e2e-r8.XXXXXX)"
PORT="${CLAUDE2DSH_E2E_PORT:-$(node -e "const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")}"
SOURCE_BACKUP="${CLAUDE2DSH_SOURCE_BACKUP:-/tmp/claude2dsh-source-backup}"
cleanup() {
  pid="${E2E_HOME}/profiles/web/claude2dsh-web.pid"
  if [ -f "$pid" ]; then kill "$(cat "$pid")" 2>/dev/null || true; fi
  rm -rf "$E2E_HOME"
}
trap cleanup EXIT

echo "== headed installer (real npm packages, isolated DSH_HOME) =="
DSH_HOME="$E2E_HOME" CLAUDE2DSH_PORT="$PORT" CLAUDE2DSH_PLUGIN_SPEC="${CLAUDE2DSH_PLUGIN_SPEC:-link:$PWD/packages/plugin}" bash scripts/install-claude2dsh.sh >"$E2E_HOME/install.log" 2>&1

curl -fsS "http://127.0.0.1:$PORT/plugins/claude2dsh/settings" >"$E2E_HOME/settings.json"
curl -fsS "http://127.0.0.1:$PORT/" >"$E2E_HOME/index.html"

SAMPLE="$(find "$SOURCE_BACKUP/projects" -name '*.jsonl' -not -path '*/subagents/*' -print -quit)"
[ -n "$SAMPLE" ] || { echo "no sample session" >&2; exit 1; }
curl -fsS -X POST -H 'content-type: application/json' \
  --data "{\"path\":\"$SAMPLE\",\"preview\":true}" \
  "http://127.0.0.1:$PORT/plugins/claude2dsh/import" >"$E2E_HOME/import-preview.json"

node - "$E2E_HOME/settings.json" "$E2E_HOME/index.html" "$E2E_HOME/import-preview.json" <<'NODE'
const fs = require('node:fs')
const [settingsPath, htmlPath, importPath] = process.argv.slice(2)
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
if (settings.autoSync?.enabled !== false) throw new Error('autoSync must stay off by default')
const html = fs.readFileSync(htmlPath, 'utf8')
if (!html.includes('@claude2dsh/plugin')) throw new Error('boot graph does not include @claude2dsh/plugin client')
const report = JSON.parse(fs.readFileSync(importPath, 'utf8'))
if (report.items?.[0]?.status !== 'preview') throw new Error(`expected preview import, got ${report.items?.[0]?.status}`)
console.log(`ROUND8_OK settings=${settings.autoSync.enabled} client-entry=yes preview=${report.items[0].status}`)
NODE
