#!/usr/bin/env sh
# Install and exercise a real Zephyr One APK in an Android emulator.
# This proves more than APK layout: the Tauri activity, libnode child, streamed
# CommonJS core, direct base.apk static reads, and loopback WebView server all run.
set -eu

APK="${1:?usage: android-emulator-smoke.sh <apk> [package] [output-dir]}"
PACKAGE="${2:-com.zephyr.one}"
OUT="${3:-dist-emulator-smoke}"
DATA_DIR="/data/user/0/$PACKAGE/files"
NODE_LOG="$DATA_DIR/zephyr-data/zephyr-node.log"

[ -f "$APK" ] || { echo "APK not found: $APK" >&2; exit 1; }
command -v adb >/dev/null 2>&1 || { echo "adb is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
mkdir -p "$OUT"

# AOSP CI images are userdebug. Root lets the test read a release app's private
# log and verify that no first-launch core directory was expanded.
adb root >/dev/null 2>&1 || true
adb wait-for-device
adb install -r "$APK"
adb logcat -c
adb shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 >/dev/null

ready=0
attempt=0
while [ "$attempt" -lt 36 ]; do
  attempt=$((attempt + 1))
  PID="$(adb shell pidof "$PACKAGE" 2>/dev/null | tr -d '\r' || true)"
  if [ -z "$PID" ]; then
    echo "Zephyr One app process exited during startup" >&2
    adb logcat -d >"$OUT/logcat.txt" || true
    exit 1
  fi
  if adb shell test -s "$NODE_LOG" 2>/dev/null; then
    adb shell cat "$NODE_LOG" >"$OUT/zephyr-node.log" || true
    if grep -F 'Zephyr HTTP' "$OUT/zephyr-node.log" >/dev/null 2>&1; then
      ready=1
      break
    fi
    if grep -E '\[startup\] Zephyr|uncaughtException|unhandledRejection' "$OUT/zephyr-node.log" >/dev/null 2>&1; then
      echo "Embedded Zephyr core reported a startup error" >&2
      cat "$OUT/zephyr-node.log" >&2
      adb logcat -d >"$OUT/logcat.txt" || true
      exit 1
    fi
  fi
  sleep 5
done

if [ "$ready" -ne 1 ]; then
  echo "Embedded Zephyr core did not become ready" >&2
  adb shell cat "$NODE_LOG" >"$OUT/zephyr-node.log" 2>/dev/null || true
  {
    echo "---- zephyr-node.log ----"
    cat "$OUT/zephyr-node.log" 2>/dev/null || true
    echo "---- app files (maxdepth 3) ----"
    adb shell "find '$DATA_DIR' -maxdepth 3 -type f 2>/dev/null | head -n 80" || true
    echo "---- pidof ----"
    adb shell "pidof $PACKAGE; ps -A | grep -E 'zephyr|libnode' || true" || true
  } | tee "$OUT/diagnostics.txt" >&2
  adb logcat -d >"$OUT/logcat.txt" || true
  exit 1
fi

PORT="$(sed -n 's/.*Zephyr HTTP.*localhost:\([0-9][0-9]*\).*/\1/p' "$OUT/zephyr-node.log" | tail -n 1)"
[ -n "$PORT" ] || { echo "Could not parse embedded HTTP port" >&2; cat "$OUT/zephyr-node.log" >&2; exit 1; }
adb forward tcp:39091 "tcp:$PORT" >/dev/null
curl --fail --silent --show-error 'http://127.0.0.1:39091/healthz' >"$OUT/healthz.json"
curl --fail --silent --show-error 'http://127.0.0.1:39091/' >"$OUT/index.html"
curl --fail --silent --show-error 'http://127.0.0.1:39091/zephyr-one-embed.css' >"$OUT/zephyr-one-embed.css"

# The only app files should be mutable data and logs. A core/archive/marker here
# means a first-run extraction path silently came back.
EXPANDED=$(adb shell "find '$DATA_DIR' -maxdepth 3 \\( -name 'zephyr-core' -o -name 'zephyr-core.*' -o -name '.zephyr-one-app-version' \\) 2>/dev/null" | tr -d '\r' || true)
if [ -n "$EXPANDED" ]; then
  echo "Unexpected first-run extracted core files:" >&2
  printf '%s\n' "$EXPANDED" >&2
  exit 1
fi

# Stay alive and healthy after the initial navigation, catching delayed WebView
# or child-process crashes rather than accepting a one-shot successful launch.
for _ in 1 2 3 4 5 6; do
  sleep 5
  PID="$(adb shell pidof "$PACKAGE" 2>/dev/null | tr -d '\r' || true)"
  [ -n "$PID" ] || { echo "Zephyr One app process exited after startup" >&2; exit 1; }
  curl --fail --silent 'http://127.0.0.1:39091/healthz' >/dev/null
done

adb exec-out screencap -p >"$OUT/screen.png" || true
adb logcat -d >"$OUT/logcat.txt" || true
if grep -A20 -B2 'FATAL EXCEPTION' "$OUT/logcat.txt" | grep -F "$PACKAGE" >/dev/null 2>&1; then
  echo "Android logcat contains a Zephyr One fatal exception" >&2
  grep -A20 -B2 'FATAL EXCEPTION' "$OUT/logcat.txt" >&2 || true
  exit 1
fi

echo "Android emulator smoke passed: pid=$PID port=$PORT, no first-run extraction"
