#!/usr/bin/env bash
# Build the vendored @wterm/dom v0.3.0 fork from source.
#
# 1. Compile Zig sources (wterm/src/*.zig) -> wterm.wasm
# 2. Inline the WASM as base64 into public/vendor/wterm-fork/core/wasm-inline.js
# 3. Transpile @wterm/core and @wterm/dom TypeScript sources to JS in
#    public/vendor/wterm-fork/ (browser-ready, no bundler/import-map needed)
#
# Requires: zig 0.16.0+ on PATH, node 18+, npx tsc (typescript 5.x) or esbuild.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WTERM_DIR="$ROOT/wterm"
VENDOR_DIR="$ROOT/public/vendor/wterm-fork"
OPTIMIZE="${1:-ReleaseSmall}"

echo "==> [1/4] Compiling Zig -> WASM ($OPTIMIZE)"
cd "$WTERM_DIR"
zig build "-Doptimize=$OPTIMIZE"
WASM="$WTERM_DIR/zig-out/bin/wterm.wasm"
if [ ! -s "$WASM" ]; then
  echo "ERROR: $WASM not produced" >&2
  exit 1
fi
echo "    produced: $(wc -c < "$WASM") bytes"

echo "==> [2/4] Inlining WASM -> wasm-inline.js"
mkdir -p "$VENDOR_DIR/core"
node -e '
  const fs = require("fs");
  const wasm = fs.readFileSync(process.argv[1]);
  const b64 = wasm.toString("base64");
  fs.writeFileSync(process.argv[2],
    "// Auto-generated - do not edit. Run `scripts/build-wterm.sh` to regenerate.\n" +
    "// Source: wterm/src/*.zig (vendored from vercel-labs/wterm v0.3.0)\n" +
    "export const WASM_BASE64 = \"" + b64 + "\";\n");
' "$WASM" "$VENDOR_DIR/core/wasm-inline.js"
echo "    wrote $VENDOR_DIR/core/wasm-inline.js"

echo "==> [3/4] Transpiling @wterm/core TS -> JS"
# core: strip types, rewrite imports to relative .js, keep ESM
node "$ROOT/scripts/transpile-wterm.mjs" core
echo "==> [4/4] Transpiling @wterm/dom TS -> JS"
node "$ROOT/scripts/transpile-wterm.mjs" dom

echo "==> Done. Vendored @wterm v0.3.0 fork built into $VENDOR_DIR"
