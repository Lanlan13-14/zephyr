#!/usr/bin/env sh
#
# Build and run the C-level shim tests against the system FreeRDP 3 libraries.
#
# These are separate from `cargo test` on purpose: they link the shim directly,
# so a failure points at the C ABI rather than at the Rust binding layer. CI runs
# both; a mismatch between them localises the fault immediately.
#
# Requires FreeRDP 3 development files:
#   Debian/Ubuntu : apt-get install freerdp3-dev
#   macOS         : brew install freerdp
set -eu

HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
OUT="${TMPDIR:-/tmp}/zephyr-one-rdp-ctest"
mkdir -p "$OUT"

# The shipped desktop ABI is FreeRDP 3 only. Keep consumers before providers:
# GNU ld scans static archives from left to right, and freerdp-client3 contains
# channel objects whose definitions live in the other FreeRDP/WinPR archives.
PKGS="freerdp-client3 freerdp3 winpr3"
PKG_CONFIG_BIN="${PKG_CONFIG:-pkg-config}"
if ! "$PKG_CONFIG_BIN" --atleast-version=3.0.0 $PKGS 2>/dev/null; then
    echo "ERROR: FreeRDP >= 3.0.0 was not found via freerdp3, freerdp-client3, and winpr3." >&2
    echo "Install FreeRDP 3 development files (see header comment)." >&2
    exit 1
fi

if [ "${ZEPHYR_ONE_REQUIRE_PATCHED_FREERDP:-0}" = "1" ]; then
    PREFIX="$("$PKG_CONFIG_BIN" --variable=prefix freerdp3)"
    HEADER="$PREFIX/include/freerdp3/freerdp/client/channels.h"
    STAMP="$PREFIX/.zephyr-freerdp-tag"
    [ -f "$HEADER" ] &&
    grep -q '^#define FREERDP_ZEPHYR_CLIPRDR_REASSEMBLY_LIMIT 1$' "$HEADER" &&
    [ -f "$STAMP" ] &&
    [ "$(cat "$STAMP")" = "3.30.0+cliprdr-reassembly-limit-v1" ] || {
        echo "ERROR: CI requires the pinned FreeRDP 3.30 clipboard-limit patch marker" >&2
        exit 1
    }
fi

CFLAGS_PKG="$("$PKG_CONFIG_BIN" --cflags $PKGS)"
# PKG_CONFIG_ALL_STATIC is consumed by Rust's pkg-config crate, not by the
# pkg-config CLI. --static is therefore mandatory here: it pulls in the private
# channel, OpenSSL, and cJSON dependencies of the pinned static archives.
LIBS_PKG="$("$PKG_CONFIG_BIN" --libs --static $PKGS)"
case "$LIBS_PKG" in
    *freerdp2*|*freerdp-client2*|*winpr2*)
        echo "ERROR: FreeRDP 3 pkg-config metadata resolved a forbidden v2 library: $LIBS_PKG" >&2
        exit 1
        ;;
esac

echo "Building shim tests against: $PKGS"

# FreeRDP's static core, client, channel, and WinPR archives have cyclic edges.
# GNU ld's archive group resolves those edges without hard-coding an install
# path or duplicating a dependency list. Other linkers use pkg-config's
# consumer-first order directly.
case "$(uname -s)" in
    Linux) LIBS_LINK="-Wl,--start-group $LIBS_PKG -Wl,--end-group" ;;
    *)     LIBS_LINK="$LIBS_PKG" ;;
esac

# -Wmissing-prototypes / -Wstrict-prototypes are not decoration: they are what
# caught three exported test helpers that had no header declaration, which would
# have been unbindable from Rust.
# shellcheck disable=SC2086
cc -std=c11 -O1 -g -D_POSIX_C_SOURCE=200809L -DZEPHYR_RDP_TESTING \
   -Wall -Wextra -Werror \
   -Wno-error=deprecated-declarations -Wmissing-prototypes -Wstrict-prototypes \
   -I"$HERE" $CFLAGS_PKG \
   "$HERE/zephyr_rdp.c" "$HERE/tests/zephyr_rdp_test.c" \
   -o "$OUT/zephyr_rdp_test" $LIBS_LINK

"$OUT/zephyr_rdp_test"
