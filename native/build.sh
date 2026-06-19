#!/bin/sh
# Build native helper: zephyr-xinput (X11/XTest input proxy)
# Must run inside the Docker build stage or a machine with gcc + libx11 + libxtst
set -e

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-/usr/local/bin}"

cc -O2 -o "${OUT_DIR}/zephyr-xinput" "${SRC_DIR}/zephyr-xinput.c" -lX11 -lXtst -lpthread
echo "Built ${OUT_DIR}/zephyr-xinput"
