#!/bin/bash
# Build script for Progressive decoder WASM module with pthread support
# Requires Emscripten SDK (emsdk) to be activated

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
OUTPUT_DIR="$SCRIPT_DIR"

echo "=== Building Progressive Decoder WASM with pthread support ==="

# Check for emcc
if ! command -v emcc &> /dev/null; then
    echo "Error: emcc not found. Please activate Emscripten SDK first:"
    echo "  source /path/to/emsdk/emsdk_env.sh"
    exit 1
fi

# Create build directory
mkdir -p "$BUILD_DIR"
mkdir -p "$OUTPUT_DIR"
cd "$BUILD_DIR"

# Configure with Emscripten
echo "Configuring..."
emcmake cmake .. -DCMAKE_BUILD_TYPE=Release

# Build
echo "Building..."
emmake make -j$(nproc 2>/dev/null || echo 4)

# Copy outputs (including pthread worker)
echo "Copying outputs to $OUTPUT_DIR..."
cp progressive_decoder.js "$OUTPUT_DIR/"
cp progressive_decoder.wasm "$OUTPUT_DIR/"
if [ -f "progressive_decoder.worker.js" ]; then
    cp progressive_decoder.worker.js "$OUTPUT_DIR/"
    echo "  - pthread worker copied"
fi

echo "=== Build complete ==="
echo "Output files:"
echo "  - $OUTPUT_DIR/progressive_decoder.js"
echo "  - $OUTPUT_DIR/progressive_decoder.wasm"
echo "  - $OUTPUT_DIR/progressive_decoder.worker.js (pthread support)"
