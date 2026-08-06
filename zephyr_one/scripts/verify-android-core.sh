#!/usr/bin/env sh
# Verify the staged Android core using the actual Android Node binary when one
# is supplied. This is intentionally short and standalone for remote builders.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
CORE="${1:-$ROOT/zephyr-core}"
NODE_BIN="${2:-}"

[ -f "$CORE/server.js" ] || { echo "missing $CORE/server.js" >&2; exit 1; }
[ -d "$CORE/public" ] || { echo "missing $CORE/public" >&2; exit 1; }
[ ! -e "$CORE/node_modules/better-sqlite3" ] || { echo "Android core retains better-sqlite3" >&2; exit 1; }
[ ! -e "$CORE/node_modules/sharp" ] || { echo "Android core retains sharp" >&2; exit 1; }
[ ! -e "$CORE/node_modules/@img" ] || { echo "Android core retains @img" >&2; exit 1; }
[ "$(find "$CORE/node_modules" -type f -name '*.node' | wc -l | tr -d ' ')" = "0" ] || {
  echo "Android core retains .node addon" >&2; exit 1;
}

test -n "$NODE_BIN" || { echo "core layout valid (no Android Node binary provided)"; exit 0; }
[ -x "$NODE_BIN" ] || { echo "Android Node is not executable: $NODE_BIN" >&2; exit 1; }

# On an Android device this proves node:sqlite loads before boot. On a Linux
# builder the Android ELF cannot execute, so APK asset/static verification is
# the correct available check.
"$NODE_BIN" -e "require('node:sqlite'); console.log('node:sqlite OK')"
