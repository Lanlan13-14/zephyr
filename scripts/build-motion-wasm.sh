#!/bin/sh
# Build zephyr_motion.wasm (the Go spring/physics engine).
#
#   scripts/build-motion-wasm.sh            TinyGo → committed artifact
#                                           (public/vendor/zephyr-motion/)
#   scripts/build-motion-wasm.sh --local    standard Go → /tmp verification
#                                           build (big; never committed)
#
# CI (`.github/workflows/motion-wasm.yml`) runs the TinyGo path on every
# motion-affecting push and commits the rebuilt artifact. Local development
# never needs TinyGo: the JS runtime falls back to spring.js, and --local
# exists only to verify the wasm ABI against the real Go toolchain.
set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
ARTIFACT="$ROOT/public/vendor/zephyr-motion/zephyr_motion.wasm"

if [ "${1:-}" = "--local" ]; then
  OUT="${2:-/tmp/zephyr_motion_stdgo.wasm}"
  (cd "$ROOT/motion-wasm" && GOOS=js GOARCH=wasm go build -o "$OUT" .)
  echo "stdgo verification build -> $OUT"
  echo "ABI-test it with:"
  echo "  ZEPHYR_MOTION_WASM=$OUT \\"
  echo "  ZEPHYR_WASM_EXEC=$(go env GOROOT)/lib/wasm/wasm_exec.js \\"
  echo "  node --test tests/motion-abi.test.mjs"
  exit 0
fi

if ! command -v tinygo >/dev/null 2>&1; then
  echo "error: tinygo not found." >&2
  echo "  CI installs it automatically; locally use '$0 --local' for a" >&2
  echo "  verification build, or install https://tinygo.org/getting-started/" >&2
  exit 1
fi

(cd "$ROOT/motion-wasm" && tinygo build \
  -target wasm -opt=2 -panic=trap -scheduler=none -gc=leaking -no-debug \
  -o "$ARTIFACT" .)

echo "tinygo artifact -> $ARTIFACT ($(wc -c < "$ARTIFACT") bytes)"
