#!/usr/bin/env bash
# Foolproof Claude2DSH installer: default is a headed (browser UI) profile.
# Headless is available with CLAUDE2DSH_HEADLESS=1 for automation.
set -euo pipefail

PROFILE="${CLAUDE2DSH_PROFILE:-claude2dsh}"
PLUGIN_VERSION="${CLAUDE2DSH_VERSION:-0.2.0-rc.1}"
WEB_APP_VERSION="${CLAUDE2DSH_WEB_APP_VERSION:-0.1.0-rc.6}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
HEADLESS="${CLAUDE2DSH_HEADLESS:-}"

if [ "$HEADLESS" != "" ]; then
  echo "== installing headless profile '$PROFILE' =="
  dsh plugin --profile "$PROFILE" add "@claude2dsh/plugin@$PLUGIN_VERSION"
  echo "OK. Run: dsh --profile $PROFILE"
  exit 0
fi

echo "== installing headed profile '$PROFILE' (base + dsh-web-app + claude2dsh) =="
set +e
dsh plugin --profile "$PROFILE" add \
  "@claude2dsh/plugin@$PLUGIN_VERSION" \
  "@deepseek-ai/dsh-web-app@$WEB_APP_VERSION"
pnpm_exit=$?
set -e

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
if [ "$pnpm_exit" -ne 0 ]; then
  echo "== pnpm exited $pnpm_exit (commonly ignored koffi build script); checking installed state =="
fi

node - "$PROFILE_DIR" "$PROFILE" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const dir = process.argv[2]
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
const deps = Object.keys(pkg.dependencies ?? {})
const required = ['@claude2dsh/plugin', '@deepseek-ai/dsh-web-app']
for (const name of required) {
  if (!deps.includes(name)) {
    console.error(`missing dependency ${name}; run: dsh plugin --profile ${process.argv[3]} add ${name}`)
    process.exit(1)
  }
}
const bundles = pkg.dsh?.profile?.bundles ?? []
for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@claude2dsh/plugin']) {
  if (!bundles.includes(name)) bundles.push(name)
}
pkg.dsh = { ...pkg.dsh, profile: { ...pkg.dsh?.profile, bundles } }
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
console.log('profile manifest bundles:', bundles.join(', '))
NODE

if ! DSH_HOME="$DSH_HOME" dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -q 'id: claude2dsh-import'; then
  echo "ERROR: profile $PROFILE did not compose claude2dsh-import" >&2
  exit 1
fi

PORT="${CLAUDE2DSH_PORT:-18781}"
if [ "$PORT" = "0" ]; then
  PORT=$(node -e "const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
fi
PIDFILE="$PROFILE_DIR/claude2dsh-web.pid"
LOG="$PROFILE_DIR/claude2dsh-web.log"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running: $(cat "$PIDFILE")"
else
  echo "== starting web UI on http://127.0.0.1:$PORT =="
  (nohup env DSH_HOME="$DSH_HOME" dsh --profile "$PROFILE" --host 127.0.0.1 --port "$PORT" >"$LOG" 2>&1 &
    echo $! >"$PIDFILE")
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/plugins/claude2dsh/settings" >/dev/null 2>&1; then
      echo "OK: Settings endpoint is live"
      break
    fi
    sleep 0.5
  done
  if ! curl -fsS "http://127.0.0.1:$PORT/plugins/claude2dsh/settings" >/dev/null 2>&1; then
    echo "ERROR: web UI did not become reachable; see $LOG" >&2
    tail -20 "$LOG" >&2 || true
    exit 1
  fi
fi

echo
echo "打开浏览器: http://127.0.0.1:$PORT"
echo "进入 设置 → Claude2DSH。停止: kill \$(cat \"$PIDFILE\")"
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://127.0.0.1:$PORT" >/dev/null 2>&1 || true
fi
