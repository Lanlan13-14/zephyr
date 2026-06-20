#!/bin/sh
# Build native helpers:
# - zephyr-xinput: X11/XTest input proxy
# - zephyr-file-clip: X11 text/uri-list clipboard owner for RDP CLIPRDR file virtualization
# Must run inside the Docker build stage or a machine with gcc + libx11 + libxtst
set -e

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-/usr/local/bin}"
mkdir -p "$OUT_DIR"

cc -O2 -o "${OUT_DIR}/zephyr-xinput" "${SRC_DIR}/zephyr-xinput.c" -lX11 -lXtst -lpthread
cc -O2 -o "${OUT_DIR}/zephyr-file-clip" "${SRC_DIR}/zephyr-file-clip.c" -lX11

echo "Built ${OUT_DIR}/zephyr-xinput"
echo "Built ${OUT_DIR}/zephyr-file-clip"
