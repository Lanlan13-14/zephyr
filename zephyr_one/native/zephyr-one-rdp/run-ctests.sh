#!/usr/bin/env sh
#
# Build and run the C-level shim tests against the system FreeRDP.
#
# These are separate from `cargo test` on purpose: they link the shim directly,
# so a failure points at the C ABI rather than at the Rust binding layer. CI runs
# both; a mismatch between them localises the fault immediately.
#
# Requires FreeRDP development files:
#   Alpine  : apk add freerdp-dev
#   Debian  : apt-get install libfreerdp-dev libwinpr-dev
#   macOS   : brew install freerdp
set -eu

HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
OUT="${TMPDIR:-/tmp}/zephyr-one-rdp-ctest"
mkdir -p "$OUT"

# FreeRDP 3 first, then 2. The shim is written against the accessor API, which
# both expose, so whichever is installed is the one we test against — and the
# reported major version in the test banner records which it was.
if pkg-config --exists freerdp3 2>/dev/null; then
    PKGS="freerdp3 freerdp-client3 winpr3"
elif pkg-config --exists freerdp2 2>/dev/null; then
    PKGS="freerdp2 freerdp-client2 winpr2"
else
    echo "ERROR: neither freerdp3 nor freerdp2 found via pkg-config." >&2
    echo "Install FreeRDP development files (see header comment)." >&2
    exit 1
fi

CFLAGS_PKG="$(pkg-config --cflags $PKGS)"
LIBS_PKG="$(pkg-config --libs $PKGS)"

echo "Building shim tests against: $PKGS"

# -Wmissing-prototypes / -Wstrict-prototypes are not decoration: they are what
# caught three exported test helpers that had no header declaration, which would
# have been unbindable from Rust.
# shellcheck disable=SC2086
cc -std=c11 -O1 -g -Wall -Wextra -Werror \
   -Wmissing-prototypes -Wstrict-prototypes \
   -I"$HERE/csrc" $CFLAGS_PKG \
   "$HERE/csrc/zephyr_rdp.c" "$HERE/csrc/zephyr_rdp_test.c" \
   -o "$OUT/zephyr_rdp_test" $LIBS_PKG

"$OUT/zephyr_rdp_test"
