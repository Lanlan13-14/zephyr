#!/bin/sh
# Start zephyr-ai (Go) then Node control plane. Same container, loopback AI.
set -eu

DATA_DIR="${ZEPHYR_DATA_DIR:-/app/data}"
AI_DATA="${ZEPHYR_AI_DATA:-$DATA_DIR/zephyr-ai}"
AI_LISTEN="${ZEPHYR_AI_LISTEN:-127.0.0.1:8450}"
TOKEN_FILE="$AI_DATA/admin.token"

mkdir -p "$AI_DATA"

if [ -z "${ZEPHYR_AI_ADMIN_TOKEN:-}" ]; then
  if [ -f "$TOKEN_FILE" ]; then
    ZEPHYR_AI_ADMIN_TOKEN="$(cat "$TOKEN_FILE")"
  else
    ZEPHYR_AI_ADMIN_TOKEN="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
    umask 077
    printf '%s' "$ZEPHYR_AI_ADMIN_TOKEN" > "$TOKEN_FILE"
  fi
  export ZEPHYR_AI_ADMIN_TOKEN
fi

export ZEPHYR_AI_PLATFORM_HOST_TOKEN="${ZEPHYR_AI_PLATFORM_HOST_TOKEN:-$ZEPHYR_AI_ADMIN_TOKEN}"
export ZEPHYR_AI_URL="${ZEPHYR_AI_URL:-http://127.0.0.1:8450}"
export ZEPHYR_AI_LISTEN="$AI_LISTEN"
export ZEPHYR_AI_DATA="$AI_DATA"
# Platform host must reach Node. Prefer loopback HTTPS only if Node listens there;
# default HTTP internal is set by Dockerfile; override when Node port differs.
# Platform tool RPC target (Node). Prefer explicit env. Defaults try HTTPS :3443
# then HTTP :3080 — Go client skips TLS verify only for loopback HTTPS.
if [ -z "${ZEPHYR_AI_PLATFORM_HOST_URL:-}" ]; then
  if [ "${HTTPS_ENABLED:-true}" != "false" ]; then
    export ZEPHYR_AI_PLATFORM_HOST_URL="https://127.0.0.1:${HTTPS_PORT:-3443}"
  else
    export ZEPHYR_AI_PLATFORM_HOST_URL="http://127.0.0.1:${PORT:-3080}"
  fi
fi

echo "[entrypoint] starting zephyr-ai on $AI_LISTEN data=$AI_DATA"
/usr/local/bin/zephyr-ai &
AI_PID=$!

cleanup() {
  kill "$AI_PID" 2>/dev/null || true
  wait "$AI_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Wait for AI health (best-effort)
i=0
while [ "$i" -lt 50 ]; do
  if curl -fsS "http://${AI_LISTEN}/healthz" >/dev/null 2>&1; then
    echo "[entrypoint] zephyr-ai healthy"
    break
  fi
  i=$((i + 1))
  sleep 0.1
done

echo "[entrypoint] starting node server.js"
exec node server.js
