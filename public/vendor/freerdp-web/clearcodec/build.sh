#!/bin/bash
# Build script for ClearCodec decoder WASM module
# Requires Emscripten SDK (emsdk) to be activated

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
OUTPUT_DIR="$SCRIPT_DIR"

echo "=== Building ClearCodec Decoder WASM ==="

# Check for emcc
if ! command -v emcc &> /dev/null; then
    echo "Error: emcc not found. Please activate Emscripten SDK first:"
    echo "  source /path/to/emsdk/emsdk_env.sh"
    exit 1
fi

# Create build directory
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# Configure with Emscripten
echo "Configuring..."
emcmake cmake .. -DCMAKE_BUILD_TYPE=Release

# Build
echo "Building..."
emmake make -j$(nproc 2>/dev/null || echo 4)

# Copy outputs
echo "Copying outputs to $OUTPUT_DIR..."
cp clearcodec_decoder.js "$OUTPUT_DIR/"
cp clearcodec_decoder.wasm "$OUTPUT_DIR/"

echo "=== Build complete ==="
echo "Output files:"
echo "  - $OUTPUT_DIR/clearcodec_decoder.js"
echo "  - $OUTPUT_DIR/clearcodec_decoder.wasm"
