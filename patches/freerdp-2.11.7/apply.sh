#!/bin/sh
set -eu
ROOT=${FREERDP_ROOT:-/tmp/FreeRDP}
PATCH_DIR=${ZEPHYR_FREERDP_PATCH_DIR:-/tmp/zephyr-freerdp-patches}
cd "$ROOT"
patch -p1 < "$PATCH_DIR/zephyr-h264-export.patch"
patch -p1 < "$PATCH_DIR/zephyr-fix-graphics-wlog.patch"
patch -p1 < "$PATCH_DIR/zephyr-fix-info-pointer-cast.patch"
patch -p1 < "$PATCH_DIR/zephyr-clipboard-file-download.patch"
