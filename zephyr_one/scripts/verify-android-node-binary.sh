#!/usr/bin/env sh
# Verify the Android Node binary has the runtime capability One requires.
set -eu
NODE_BIN="${1:?usage: verify-android-node-binary.sh <android-node-binary>}"
[ -f "$NODE_BIN" ] || { echo "Node binary not found: $NODE_BIN" >&2; exit 1; }
command -v file >/dev/null 2>&1 || { echo "file is required" >&2; exit 1; }
INFO="$(file "$NODE_BIN")"
printf '%s\n' "$INFO"
printf '%s' "$INFO" | grep -E 'ARM aarch64|aarch64' >/dev/null || {
  echo "Node binary is not Android arm64" >&2; exit 1;
}
command -v strings >/dev/null 2>&1 || { echo "strings is required" >&2; exit 1; }
strings "$NODE_BIN" | grep -F 'DatabaseSync' >/dev/null || {
  echo "Node binary lacks built-in node:sqlite DatabaseSync" >&2; exit 1;
}
echo "Android Node binary verified: arm64 + node:sqlite"
