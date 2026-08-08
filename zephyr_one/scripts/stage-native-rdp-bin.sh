#!/usr/bin/env sh
# Build, verify, and stage the native FreeRDP helper for the Tauri bundle.
#
# Required for packaged builds on Windows/macOS/Linux:
#   PKG_CONFIG_PATH       vcpkg static triplet's lib/pkgconfig
#   ZEPHYR_ONE_RDP_STATIC=1
# Local Linux development may instead use distro freerdp3-dev/freerdp2-dev.
#
# Optional environment (used by tests/CI cross-target probes):
#   ZEPHYR_ONE_RDP_CRATE   helper crate directory
#   ZEPHYR_ONE_RDP_OUT     destination resource directory
#   ZEPHYR_ONE_RDP_TARGET  cargo target triple
#   ZEPHYR_ONE_RDP_PROFILE release (default) or debug
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
CRATE="${ZEPHYR_ONE_RDP_CRATE:-$ROOT/native/zephyr-one-rdp}"
OUT="${ZEPHYR_ONE_RDP_OUT:-$ROOT/native-bin}"
PROFILE="${ZEPHYR_ONE_RDP_PROFILE:-release}"
TARGET="${ZEPHYR_ONE_RDP_TARGET:-}"

case "$PROFILE" in
  release) PROFILE_FLAG="--release" ;;
  debug) PROFILE_FLAG="" ;;
  *) echo "ERROR: unsupported ZEPHYR_ONE_RDP_PROFILE=$PROFILE" >&2; exit 2 ;;
esac

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) EXE="zephyr-one-rdp.exe" ;;
  *) EXE="zephyr-one-rdp" ;;
esac

TARGET_ARGS=""
TARGET_DIR=""
if [ -n "$TARGET" ]; then
  TARGET_ARGS="--target $TARGET"
  TARGET_DIR="$TARGET/"
fi

printf 'Building native RDP helper (%s%s)\n' "$PROFILE" "${TARGET:+, $TARGET}"
# shellcheck disable=SC2086
cargo build --locked --manifest-path "$CRATE/Cargo.toml" $PROFILE_FLAG $TARGET_ARGS

SRC="$CRATE/target/${TARGET_DIR}${PROFILE}/$EXE"
if [ ! -f "$SRC" ]; then
  echo "ERROR: cargo succeeded but helper is missing: $SRC" >&2
  exit 1
fi
mkdir -p "$OUT"
cp "$SRC" "$OUT/$EXE"
chmod +x "$OUT/$EXE" 2>/dev/null || true

# Native-host smoke: prove the staged file can be executed and speaks the
# actual framed protocol. A helper missing .so/.dylib dependencies fails before
# it can emit the first `hello` event, so this also catches green-build / broken-
# install packaging errors.
if [ -z "$TARGET" ]; then
  python3 "$ROOT/scripts/smoke-native-rdp-helper.py" "$OUT/$EXE"
fi

BYTES=$(wc -c < "$OUT/$EXE" | tr -d ' ')
if [ "$BYTES" -lt 100000 ]; then
  echo "ERROR: staged helper is implausibly small ($BYTES bytes)" >&2
  exit 1
fi
printf 'Native RDP helper staged: %s (%s bytes)\n' "$OUT/$EXE" "$BYTES"
