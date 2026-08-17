#!/usr/bin/env bash
# Foolproof Claude2DSH installer.
# Default: install into your main `web` profile and start the browser UI.
# No isolated profile is created unless you explicitly ask for one.
set -euo pipefail

PROFILE="${CLAUDE2DSH_PROFILE:-web}"
PLUGIN_VERSION="${CLAUDE2DSH_VERSION:-0.2.0-rc.4}"
PLUGIN_SPEC="${CLAUDE2DSH_PLUGIN_SPEC:-@claude2dsh/plugin@$PLUGIN_VERSION}"
WEB_APP_VERSION="${CLAUDE2DSH_WEB_APP_VERSION:-0.1.0-rc.6}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

if [ "$PROFILE" = "web" ]; then
  echo "== installing @claude2dsh/plugin into your main web profile =="
  dsh plugin --profile web add "$PLUGIN_SPEC"
else
  echo "== installing into explicit profile '$PROFILE' (base + dsh-web-app + claude2dsh) =="
  set +e
  dsh plugin --profile "$PROFILE" add \
    "$PLUGIN_SPEC" \
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

  PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
  DSH_HOME="$DSH_HOME" dsh --profile "$PROFILE" --dump-config >"$PROFILE_DIR/dump-config.txt" 2>&1 || true
  if ! grep -q 'id: claude2dsh-import' "$PROFILE_DIR/dump-config.txt"; then
    echo "ERROR: profile $PROFILE did not compose claude2dsh-import" >&2
    tail -20 "$PROFILE_DIR/dump-config.txt" >&2 || true
    exit 1
  fi
fi

PORT="${CLAUDE2DSH_PORT:-3080}"
if [ "$PORT" = "0" ]; then
  PORT=$(node -e "const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
fi
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PIDFILE="$PROFILE_DIR/claude2dsh-web.pid"
LOG="$PROFILE_DIR/claude2dsh-web.log"

if curl -fsS "http://127.0.0.1:$PORT/plugins/claude2dsh/settings" >/dev/null 2>&1; then
  echo "main web profile already serves Claude2DSH on $PORT"
elif node -e "const net=require('node:net');const s=net.connect({host:'127.0.0.1',port:Number(process.argv[1])},()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1))" "$PORT"; then
  echo "ERROR: port $PORT is already in use by another process." >&2
  echo "Stop that dsh web process and restart it so the new plugin composition loads, or set CLAUDE2DSH_PORT=0 for a free port." >&2
  exit 1
elif [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running: $(cat "$PIDFILE")"
else
  echo "== starting your web UI on http://127.0.0.1:$PORT =="
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
