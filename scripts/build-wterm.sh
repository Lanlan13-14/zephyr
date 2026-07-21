#!/usr/bin/env bash
# Build the vendored terminal stack:
#   - DOM layer: wterm/packages/@wterm/dom (Zephyr fork)
#   - Core adapters: wterm/packages/@wterm/core (XtermBridge + optional WasmBridge)
#   - VT engine (default): @xterm/headless → public/vendor/wterm-fork/core/xterm-headless.js
#   - Optional legacy Zig WASM core (engine:"wasm")
#
# Requires: node 18+, esbuild (devDep). Zig only needed for the wasm engine path.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WTERM_DIR="$ROOT/wterm"
VENDOR_DIR="$ROOT/public/vendor/wterm-fork"
OPTIMIZE="${1:-ReleaseSmall}"
BUILD_WASM="${BUILD_WASM:-0}"

mkdir -p "$VENDOR_DIR/core"

echo "==> [1/4] Bundling @xterm/headless for browser"
node "$ROOT/scripts/build-xterm-headless.mjs"

if [ "$BUILD_WASM" = "1" ] || [ "${2:-}" = "wasm" ]; then
  echo "==> [2/4] Compiling Zig -> WASM ($OPTIMIZE) [optional legacy engine]"
  if ! command -v zig >/dev/null 2>&1; then
    echo "ERROR: zig not on PATH (needed for BUILD_WASM=1)" >&2
    exit 1
  fi
  cd "$WTERM_DIR"
  zig build "-Doptimize=$OPTIMIZE"
  WASM="$WTERM_DIR/zig-out/bin/wterm.wasm"
  if [ ! -s "$WASM" ]; then
    echo "ERROR: $WASM not produced" >&2
    exit 1
  fi
  echo "    produced: $(wc -c < "$WASM") bytes"
  node -e '
    const fs = require("fs");
    const wasm = fs.readFileSync(process.argv[1]);
    const b64 = wasm.toString("base64");
    fs.writeFileSync(process.argv[2],
      "// Auto-generated - do not edit. Run `scripts/build-wterm.sh wasm` to regenerate.\n" +
      "// Source: wterm/src/*.zig (legacy engine)\n" +
      "export const WASM_BASE64 = \"" + b64 + "\";\n");
  ' "$WASM" "$VENDOR_DIR/core/wasm-inline.js"
  echo "    wrote $VENDOR_DIR/core/wasm-inline.js"
else
  echo "==> [2/4] Skipping Zig WASM (default engine is xterm). Set BUILD_WASM=1 to rebuild."
  if [ ! -f "$VENDOR_DIR/core/wasm-inline.js" ]; then
    # Keep a stub so optional wasm imports don't 404 during transition.
    printf '%s\n' \
      '// Stub: legacy Zig engine not built. Use engine:"xterm" (default) or BUILD_WASM=1.' \
      'export const WASM_BASE64 = "";' \
      > "$VENDOR_DIR/core/wasm-inline.js"
  fi
fi

echo "==> [3/4] Transpiling @wterm/core TS -> JS"
node "$ROOT/scripts/transpile-wterm.mjs" core
echo "==> [4/4] Transpiling @wterm/dom TS -> JS"
node "$ROOT/scripts/transpile-wterm.mjs" dom

echo "==> Done. Terminal vendor stack at $VENDOR_DIR"
echo "    engine default: xterm headless + wterm DOM"
echo "    source trees:   xterm/ (MIT, fork freely)  wterm/packages/@wterm/dom (DOM)"
