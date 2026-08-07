#!/usr/bin/env sh
# Install and exercise a real Zephyr One APK in an Android emulator.
# Proves: Tauri activity, libnode child, streamed CommonJS core, base.apk
# static reads, loopback HTTP — and that filesDir is not used for core extract.
set -eu

APK="${1:?usage: android-emulator-smoke.sh <apk> [package] [output-dir]}"
PACKAGE="${2:-com.zephyr.one}"
OUT="${3:-dist-emulator-smoke}"
DATA_DIR="/data/user/0/$PACKAGE/files"
NODE_LOG="$DATA_DIR/zephyr-data/zephyr-node.log"
ACTIVITY="$PACKAGE/.MainActivity"

[ -f "$APK" ] || { echo "APK not found: $APK" >&2; exit 1; }
command -v adb >/dev/null 2>&1 || { echo "adb is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
mkdir -p "$OUT"

dump_fail() {
  reason="$1"
  echo "$reason" >&2
  {
    echo "==== reason: $reason ===="
    echo "---- adb devices ----"
    adb devices -l || true
    echo "---- pidof / ps ----"
    adb shell "pidof $PACKAGE || true; ps -A | grep -E 'zephyr|libnode|one' || true" || true
    echo "---- zephyr-node.log ----"
    adb shell "cat '$NODE_LOG' 2>/dev/null || true" || true
    echo "---- app files (maxdepth 4) ----"
    adb shell "find '$DATA_DIR' -maxdepth 4 2>/dev/null | head -n 120" || true
    echo "---- dumpsys activity (package) ----"
    adb shell "dumpsys activity activities | grep -A3 -E '$PACKAGE|ACTIVITY' | head -n 80" || true
    echo "---- tombstones (names) ----"
    adb shell "ls -la /data/tombstones 2>/dev/null | head -n 20" || true
  } | tee "$OUT/diagnostics.txt" >&2
  adb logcat -d -v threadtime >"$OUT/logcat.txt" 2>/dev/null || true
  # Keep filtered views for humans; full logcat stays in logcat.txt
  grep -nE 'FATAL EXCEPTION|AndroidRuntime|RustPanic|DEBUG|libc|signal|tombstone|zephyr|libnode|MainActivity|Abort' \
    "$OUT/logcat.txt" >"$OUT/logcat-filtered.txt" 2>/dev/null || true
  exit 1
}

# userdebug images: root so we can read the release app's private filesDir.
# adbd restarts after root — always re-wait.
adb wait-for-device
adb root >/dev/null 2>&1 || true
adb wait-for-device
# Settle after adbd restart (the long-standing "device not found" overlay spam
# from skin profiles is separate; this avoids racing install/launch).
sleep 2

adb install -r -g "$APK" || dump_fail "adb install failed"
adb wait-for-device
adb logcat -c || true
# Prefer explicit activity start over monkey (monkey is flaky and noisy on CI).
adb shell am force-stop "$PACKAGE" >/dev/null 2>&1 || true
adb shell am start -W -n "$ACTIVITY" -a android.intent.action.MAIN -c android.intent.category.LAUNCHER \
  >"$OUT/am-start.txt" 2>&1 || true
cat "$OUT/am-start.txt" >&2 || true

# Give Zygote + nativeloader time before the first liveness check. Immediate
# pidof after launch caused false "exited during startup" with a truncated log.
sleep 3

ready=0
attempt=0
missed_pid=0
while [ "$attempt" -lt 40 ]; do
  attempt=$((attempt + 1))
  PID="$(adb shell pidof "$PACKAGE" 2>/dev/null | tr -d '\r' || true)"
  if [ -z "$PID" ]; then
    missed_pid=$((missed_pid + 1))
    # Require several consecutive misses so a single adb blip is not fatal.
    if [ "$missed_pid" -ge 3 ]; then
      dump_fail "Zephyr One app process exited during startup (pidof empty x$missed_pid)"
    fi
    sleep 2
    continue
  fi
  missed_pid=0

  if adb shell test -s "$NODE_LOG" 2>/dev/null; then
    adb shell cat "$NODE_LOG" >"$OUT/zephyr-node.log" || true
    if grep -F 'Zephyr HTTP' "$OUT/zephyr-node.log" >/dev/null 2>&1; then
      ready=1
      break
    fi
    if grep -E '\[startup\] Zephyr|uncaughtException|unhandledRejection' "$OUT/zephyr-node.log" >/dev/null 2>&1; then
      dump_fail "Embedded Zephyr core reported a startup error"
    fi
  fi
  sleep 5
done

if [ "$ready" -ne 1 ]; then
  dump_fail "Embedded Zephyr core did not become ready"
fi

PORT="$(sed -n 's/.*Zephyr HTTP.*localhost:\([0-9][0-9]*\).*/\1/p' "$OUT/zephyr-node.log" | tail -n 1)"
[ -n "$PORT" ] || dump_fail "Could not parse embedded HTTP port from zephyr-node.log"
adb forward tcp:39091 "tcp:$PORT" >/dev/null
curl --fail --silent --show-error 'http://127.0.0.1:39091/healthz' >"$OUT/healthz.json"
curl --fail --silent --show-error 'http://127.0.0.1:39091/' >"$OUT/index.html"
curl --fail --silent --show-error 'http://127.0.0.1:39091/zephyr-one-embed.css' >"$OUT/zephyr-one-embed.css"

EXPANDED=$(adb shell "find '$DATA_DIR' -maxdepth 3 \\( -name 'zephyr-core' -o -name 'zephyr-core.*' -o -name '.zephyr-one-app-version' \\) 2>/dev/null" | tr -d '\r' || true)
if [ -n "$EXPANDED" ]; then
  printf '%s\n' "$EXPANDED" >"$OUT/unexpected-extract.txt"
  dump_fail "Unexpected first-run extracted core files"
fi

for _ in 1 2 3 4 5 6; do
  sleep 5
  PID="$(adb shell pidof "$PACKAGE" 2>/dev/null | tr -d '\r' || true)"
  [ -n "$PID" ] || dump_fail "Zephyr One app process exited after startup"
  curl --fail --silent 'http://127.0.0.1:39091/healthz' >/dev/null
done

adb exec-out screencap -p >"$OUT/screen.png" || true
adb logcat -d -v threadtime >"$OUT/logcat.txt" || true
if grep -A20 -B2 'FATAL EXCEPTION' "$OUT/logcat.txt" | grep -F "$PACKAGE" >/dev/null 2>&1; then
  dump_fail "Android logcat contains a Zephyr One fatal exception"
fi

echo "Android emulator smoke passed: pid=$PID port=$PORT, no first-run extraction"