#!/bin/sh
# Fetch Node.js for Android from Delusions6515/node-android-build releases.
# Solves Android Node version skew for any future embedded worker.
set -eu
ARCH="${1:-arm64}"
MAJOR="${2:-24}"
OUT_DIR="${3:-./third_party/node-android}"
REPO="Delusions6515/node-android-build"
TAG="node-android-${ARCH}-${MAJOR}"

mkdir -p "$OUT_DIR"
echo "Resolving latest asset under release tag: $TAG"
API="https://api.github.com/repos/${REPO}/releases/tags/${TAG}"
ASSET=$(curl -fsSL "$API" | python3 -c 'import json,sys
j=json.load(sys.stdin)
assets=j.get("assets") or []
names=[a["name"] for a in assets if a["name"].endswith(".tar.xz")]
print(sorted(names)[-1] if names else "")')
if [ -z "$ASSET" ]; then
  echo "No asset found for $TAG" >&2
  exit 1
fi
URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
echo "Downloading $URL"
curl -fL "$URL" -o "$OUT_DIR/$ASSET"
tar -xJf "$OUT_DIR/$ASSET" -C "$OUT_DIR"
echo "Extracted into $OUT_DIR"
find "$OUT_DIR" -type f -name node -perm -111
