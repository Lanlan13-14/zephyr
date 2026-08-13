#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
CORE="$ROOT/zephyr-core"
DATA="/tmp/zephyr-one-smoke-$$"
PORT=3921
LOG="/tmp/zephyr-one-smoke-$$.log"
CHALLENGE="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
mkdir -p "$DATA"
cd "$CORE"
ZEPHYR_DATA_DIR="$DATA" HTTP_ENABLED=true HTTPS_ENABLED=false PORT="$PORT" \
PUBLIC_ORIGIN="http://127.0.0.1:$PORT" ZEPHYR_ONE_EMBEDDED=1 \
ZEPHYR_ONE_STARTUP_CHALLENGE="$CHALLENGE" \
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
    # Redirect loop guard: / with no session must NOT bounce to /app.html
    root_code=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
    echo "/ status=$root_code (expect 200, not 302)"
    [ "$root_code" = "200" ] || { echo "FAIL: / returned $root_code (redirect loop not broken)"; exit 1; }

    # Unauthenticated /app.html must redirect home (not loop)
    app_code=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/app.html" || true)
    echo "/app.html status=$app_code (expect 302)"
    [ "$app_code" = "302" ] || { echo "FAIL: /app.html returned $app_code (expected 302)"; exit 1; }

    # The recovery document must be served at /
    curl -sS "http://127.0.0.1:$PORT/" | grep -q 'zephyr-one-recovery' || {
      echo "FAIL: / did not serve the recovery document"
      exit 1
    }

    # The embedded app surface must load with a bootstrap session
    boot_code=$(curl -sS -X POST "http://127.0.0.1:$PORT/__zephyr_one/bootstrap" \
      -H "x-zephyr-one-bootstrap-challenge: $CHALLENGE" \
      -D /tmp/zephyr-one-headers.txt -o /dev/null -w '%{http_code}')
    echo "bootstrap status=$boot_code (expect 204)"
    [ "$boot_code" = "204" ] || { echo "FAIL: bootstrap returned $boot_code"; exit 1; }
    COOKIE=$(grep -i '^set-cookie:' /tmp/zephyr-one-headers.txt | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1)
    code=$(curl -sS -o /tmp/zephyr-one-app.html -w '%{http_code}' -b "$COOKIE" "http://127.0.0.1:$PORT/app.html?zephyrOne=1" || true)
    echo "app.html (authed) status=$code (expect 200)"
    [ "$code" = "200" ] || { echo "FAIL: authenticated app.html returned $code"; exit 1; }
    grep -n 'zephyr-one-embed' /tmp/zephyr-one-app.html | head
    echo "ALL SMOKE CHECKS PASSED"
    exit 0
  fi
  i=$((i+1))
  sleep 0.5
done
echo "FAILED to start; log:"
cat "$LOG"
exit 1
