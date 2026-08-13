#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
CORE="$ROOT/zephyr-core"
MODE="${1:-core}"
SHELL_PID=""
CORE_PID=""

umask 077
RUN_DIR="$(mktemp -d "$ROOT/.smoke-core.XXXXXX")"
DATA="$RUN_DIR/data"
TMP="$RUN_DIR/tmp"
LOG="$RUN_DIR/core.log"
HEALTH="$RUN_DIR/health.json"
HEADERS="$RUN_DIR/headers.txt"
APP_HTML="$RUN_DIR/app.html"
mkdir -p "$DATA" "$TMP"
chmod 700 "$RUN_DIR" "$DATA" "$TMP"

terminate_tree() {
  for child_pid in $(pgrep -P "$1" 2>/dev/null || true); do
    terminate_tree "$child_pid"
  done
  kill "$1" 2>/dev/null || true
}

descendant_pids() {
  for child_pid in $(pgrep -P "$1" 2>/dev/null || true); do
    printf '%s\n' "$child_pid"
    descendant_pids "$child_pid"
  done
}

process_executable() {
  case "$(uname -s)" in
    Linux) readlink "/proc/$1/exe" 2>/dev/null || true ;;
    Darwin) /usr/sbin/lsof -a -p "$1" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 ;;
    *) return 1 ;;
  esac
}

capture_bundled_node_pid() {
  expected_node="$1"
  matched_pid=""
  matched_count=0
  for candidate_pid in $(descendant_pids "$SHELL_PID"); do
    candidate_executable=$(process_executable "$candidate_pid")
    if [ "$candidate_executable" = "$expected_node" ]; then
      matched_pid="$candidate_pid"
      matched_count=$((matched_count+1))
    fi
  done
  if [ "$matched_count" -gt 1 ]; then
    echo "FAIL: packaged shell process tree contains multiple exact bundled Node children" >&2
    return 2
  fi
  [ "$matched_count" -eq 1 ] || return 1
  PACKAGED_CORE_PID="$matched_pid"
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$CORE_PID" ]; then
    kill "$CORE_PID" 2>/dev/null || true
    wait "$CORE_PID" 2>/dev/null || true
  fi
  if [ -n "$SHELL_PID" ]; then
    terminate_tree "$SHELL_PID"
    wait "$SHELL_PID" 2>/dev/null || true
  fi
  case "$RUN_DIR" in
    "$ROOT"/.smoke-core.*) rm -rf -- "$RUN_DIR" ;;
    *) echo "REFUSING unsafe smoke cleanup path: $RUN_DIR" >&2 ;;
  esac
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

smoke_packaged_shell() {
  [ "$#" -eq 1 ] || {
    echo "usage: $0 --packaged-shell <absolute-shell-executable>" >&2
    exit 2
  }
  shell_executable="$1"
  case "$shell_executable" in
    /*) ;;
    *) echo "packaged shell executable must be an absolute path" >&2; exit 2 ;;
  esac
  [ -x "$shell_executable" ] || {
    echo "packaged shell executable is not executable: $shell_executable" >&2
    exit 2
  }

  HOME="$RUN_DIR/home"
  XDG_DATA_HOME="$RUN_DIR/xdg-data"
  XDG_CONFIG_HOME="$RUN_DIR/xdg-config"
  XDG_CACHE_HOME="$RUN_DIR/xdg-cache"
  LAUNCH_DIR="$RUN_DIR/launch"
  mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$LAUNCH_DIR"
  chmod 700 "$HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$LAUNCH_DIR"

  case "$(uname -s)" in
    Darwin) UI_DATA_DIR="$HOME/Library/Application Support/com.zephyr.one/zephyr-data" ;;
    Linux) UI_DATA_DIR="$XDG_DATA_HOME/com.zephyr.one/zephyr-data" ;;
    *) echo "packaged shell UI-ready smoke supports only macOS and Linux" >&2; exit 2 ;;
  esac
  UI_READY_NONCE="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
  UI_READY_MARKER="$UI_DATA_DIR/zephyr-one-ui-ready.json"
  UI_READY_VERIFIER="$ROOT/scripts/verify-ui-ready-marker.mjs"
  mkdir -p "$UI_DATA_DIR"
  chmod 700 "$UI_DATA_DIR"
  rm -f -- "$UI_READY_MARKER"

  (
    cd "$LAUNCH_DIR"
    HOME="$HOME" XDG_DATA_HOME="$XDG_DATA_HOME" XDG_CONFIG_HOME="$XDG_CONFIG_HOME" \
      XDG_CACHE_HOME="$XDG_CACHE_HOME" TMPDIR="$TMP" ZEPHYR_ONE_AUTOSTART_RUNTIME=1 \
      ZEPHYR_ONE_UI_READY_MARKER="$UI_READY_MARKER" \
      ZEPHYR_ONE_UI_READY_NONCE="$UI_READY_NONCE" \
      "$shell_executable" >"$RUN_DIR/shell.log" 2>&1
  ) &
  SHELL_PID=$!

  i=0
  runtime_ready=0
  port=""
  PACKAGED_CORE_PID=""
  while [ "$i" -lt 180 ]; do
    autostart_log=$(find "$RUN_DIR" -type f -name zephyr-autostart.log -print 2>/dev/null | head -n 1 || true)
    if [ -n "$autostart_log" ]; then
      ready_line=$(grep 'runtime ready port=[0-9][0-9]* node=' "$autostart_log" | tail -n 1 || true)
      if [ -n "$ready_line" ]; then
        port=$(printf '%s\n' "$ready_line" | sed -n 's/.*runtime ready port=\([0-9][0-9]*\) node=.*/\1/p')
        node_path=${ready_line#* node=}
        case "$node_path" in
          *desktop-runtime/node) ;;
          *)
            echo "FAIL: packaged shell used a non-packaged Node: $node_path" >&2
            cat "$autostart_log" >&2
            exit 1
            ;;
        esac
        node_path=$(CDPATH= cd -- "$(dirname "$node_path")" && printf '%s/%s\n' "$(pwd -P)" "$(basename "$node_path")")
        previous_core_pid="$PACKAGED_CORE_PID"
        if capture_bundled_node_pid "$node_path"; then
          if [ -n "$previous_core_pid" ] && [ "$PACKAGED_CORE_PID" != "$previous_core_pid" ]; then
            echo "FAIL: packaged shell bundled Node child PID changed" >&2
            exit 1
          fi
          if [ -z "$previous_core_pid" ]; then
            echo "packaged Node child pid: $PACKAGED_CORE_PID"
          fi
        else
          capture_status=$?
          [ "$capture_status" -ne 2 ] || exit 1
          if [ -n "$previous_core_pid" ]; then
            echo "FAIL: captured bundled Node child exited or left the shell process tree" >&2
            exit 1
          fi
        fi
        if [ -n "$port" ] && curl -fsS "http://127.0.0.1:$port/healthz" >"$HEALTH" 2>/dev/null; then
          if [ "$runtime_ready" -eq 0 ]; then
            echo "packaged shell runtime ready on port $port"
            echo "packaged Node: $node_path"
            cat "$HEALTH"
            echo
            runtime_ready=1
          fi
          if [ -n "$PACKAGED_CORE_PID" ] && [ -f "$UI_READY_MARKER" ]; then
            if ui_ready_output=$("$node_path" "$UI_READY_VERIFIER" \
              --marker "$UI_READY_MARKER" \
              --nonce "$UI_READY_NONCE" \
              --port "$port" \
              --core-pid "$PACKAGED_CORE_PID" \
              --health "$HEALTH" 2>&1); then
              echo "$ui_ready_output"
              echo "PACKAGED SHELL UI-READY SMOKE PASSED"
              exit 0
            fi
            echo "FAIL: packaged shell emitted an invalid UI-ready marker" >&2
            echo "$ui_ready_output" >&2
            cat "$UI_READY_MARKER" >&2 || true
            exit 1
          fi
        fi
      fi
      if grep -q 'runtime start failed:' "$autostart_log"; then
        echo "FAIL: packaged shell could not start its runtime" >&2
        cat "$autostart_log" >&2
        cat "$RUN_DIR/shell.log" >&2
        exit 1
      fi
    fi
    if ! kill -0 "$SHELL_PID" 2>/dev/null; then
      if [ "$runtime_ready" -eq 1 ]; then
        echo "FAIL: packaged shell exited before local-app became UI-ready" >&2
      else
        echo "FAIL: packaged shell exited before its runtime became ready" >&2
      fi
      [ -z "$autostart_log" ] || cat "$autostart_log" >&2
      cat "$RUN_DIR/shell.log" >&2
      exit 1
    fi
    i=$((i+1))
    sleep 0.5
  done

  if [ "$runtime_ready" -eq 1 ]; then
    echo "FAIL: local-app did not emit its authenticated top-level UI-ready marker" >&2
    echo "expected marker: $UI_READY_MARKER" >&2
  else
    echo "FAIL: packaged shell runtime did not become ready" >&2
  fi
  find "$RUN_DIR" -type f -name zephyr-autostart.log -exec cat {} \; >&2
  [ ! -f "$UI_READY_MARKER" ] || cat "$UI_READY_MARKER" >&2
  cat "$RUN_DIR/shell.log" >&2
  exit 1
}

if [ "$MODE" = "--packaged-shell" ]; then
  shift
  smoke_packaged_shell "$@"
fi
[ "$MODE" = "core" ] || {
  echo "usage: $0 [--packaged-shell <absolute-shell-executable>]" >&2
  exit 2
}

PORT="${ZEPHYR_ONE_SMOKE_PORT:-3921}"
CHALLENGE="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
cd "$CORE"
TMPDIR="$TMP" ZEPHYR_DATA_DIR="$DATA" HTTP_ENABLED=true HTTPS_ENABLED=false PORT="$PORT" \
PUBLIC_ORIGIN="http://127.0.0.1:$PORT" ZEPHYR_ONE_EMBEDDED=1 \
ZEPHYR_ONE_USE_BUILTIN_SQLITE=1 \
ZEPHYR_ONE_STARTUP_CHALLENGE="$CHALLENGE" \
node server.js >"$LOG" 2>&1 &
CORE_PID=$!

i=0
while [ "$i" -lt 40 ]; do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >"$HEALTH" 2>/dev/null; then
    echo "health ok"
    cat "$HEALTH"
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
      -D "$HEADERS" -o /dev/null -w '%{http_code}')
    echo "bootstrap status=$boot_code (expect 204)"
    [ "$boot_code" = "204" ] || { echo "FAIL: bootstrap returned $boot_code"; exit 1; }
    COOKIE=$(grep -i '^set-cookie:' "$HEADERS" | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1)
    code=$(curl -sS -o "$APP_HTML" -w '%{http_code}' -b "$COOKIE" "http://127.0.0.1:$PORT/app.html?zephyrOne=1" || true)
    echo "app.html (authed) status=$code (expect 200)"
    [ "$code" = "200" ] || { echo "FAIL: authenticated app.html returned $code"; exit 1; }
    grep -n 'zephyr-one-embed' "$APP_HTML" | head
    echo "ALL SMOKE CHECKS PASSED"
    exit 0
  fi
  i=$((i+1))
  sleep 0.5
done
echo "FAILED to start; log:"
cat "$LOG"
exit 1
