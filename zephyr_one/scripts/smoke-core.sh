#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
CORE="$ROOT/zephyr-core"
DATA="/tmp/zephyr-one-smoke-$$"
PORT=3921
LOG="/tmp/zephyr-one-smoke-$$.log"
mkdir -p "$DATA"
cd "$CORE"
ZEPHYR_DATA_DIR="$DATA" HTTP_ENABLED=true HTTPS_ENABLED=false PORT="$PORT" \
PUBLIC_ORIGIN="http://127.0.0.1:$PORT" ZEPHYR_ONE_EMBEDDED=1 \
node server.js >"$LOG" 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; }
trap cleanup EXIT
i=0
while [ "$i" -lt 40 ]; do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/tmp/zephyr-one-health.json 2>/dev/null; then
    echo "health ok"
    cat /tmp/zephyr-one-health.json
    echo
    code=$(curl -sS -o /tmp/zephyr-one-app.html -w '%{http_code}' "http://127.0.0.1:$PORT/app.html?zephyrOne=1" || true)
    echo "app.html status=$code"
    grep -n 'zephyr-one-embed\|仪表盘' /tmp/zephyr-one-app.html | head
    exit 0
  fi
  i=$((i+1))
  sleep 0.5
done
echo "FAILED to start; log:"
cat "$LOG"
exit 1
