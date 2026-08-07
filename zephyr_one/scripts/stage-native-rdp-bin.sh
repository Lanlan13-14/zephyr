#!/usr/bin/env sh
#
# Build the native FreeRDP helper and stage it where the Tauri bundle picks it
# up as a resource (`native-bin/`, listed in tauri.conf.json).
#
# Why a plain resource rather than Tauri's `externalBin`:
#   externalBin requires the file to be named with the target triple suffix
#   (zephyr-one-rdp-x86_64-pc-windows-msvc.exe) and is meant for sidecars the
#   *shell* spawns through the shell plugin. Here the spawner is the Node core,
#   which just needs a path — so a resource plus ZEPHYR_ONE_RDP_HELPER is both
#   simpler and avoids granting the WebView a shell-execute capability it would
#   otherwise need.
#
# FreeRDP development files must be present:
#   Alpine  : apk add freerdp-dev
#   Debian  : apt-get install libfreerdp-dev libwinpr-dev
#   macOS   : brew install freerdp
#   Windows : vcpkg install freerdp:x64-windows-static-md  (set VCPKG_ROOT)
#
# The build is intentionally *not* silent about a missing FreeRDP: build.rs
# panics with install instructions, because a Zephyr One built without the
# helper would install cleanly and then fail only when a user opens an RDP tab.
set -eu

HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
ONE="$(CDPATH= cd -- "$HERE/.." && pwd)"
CRATE="$ONE/native/zephyr-one-rdp"
OUT="$ONE/native-bin"

if [ ! -f "$CRATE/Cargo.toml" ]; then
    echo "ERROR: helper crate missing at $CRATE" >&2
    exit 1
fi

echo "Building native RDP helper (release) ..."
# Separate target dir from src-tauri's so a helper rebuild never invalidates the
# shell's incremental cache (and vice versa).
( cd "$CRATE" && cargo build --release )

mkdir -p "$OUT"

# Windows produces .exe; everything else is extensionless.
if [ -f "$CRATE/target/release/zephyr-one-rdp.exe" ]; then
    cp -f "$CRATE/target/release/zephyr-one-rdp.exe" "$OUT/zephyr-one-rdp.exe"
    STAGED="$OUT/zephyr-one-rdp.exe"
elif [ -f "$CRATE/target/release/zephyr-one-rdp" ]; then
    cp -f "$CRATE/target/release/zephyr-one-rdp" "$OUT/zephyr-one-rdp"
    chmod +x "$OUT/zephyr-one-rdp"
    STAGED="$OUT/zephyr-one-rdp"
else
    echo "ERROR: cargo build produced no zephyr-one-rdp binary" >&2
    exit 1
fi

echo "Staged native RDP helper: $STAGED"
ls -l "$STAGED"
