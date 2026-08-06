#!/usr/bin/env sh
# Bundle Node for Android as libnode.so under jniLibs (install-time extract by OS).
# Open-box: no app-runtime download/unpack of the Node binary.
#
# Source: https://github.com/Delusions6515/node-android-build
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
ANDROID_ROOT="${1:-$ROOT/src-tauri/gen/android}"
CACHE="${NODE_ANDROID_CACHE:-$ROOT/third_party/node-android}"
MAJOR="${NODE_ANDROID_MAJOR:-24}"
REPO="Delusions6515/node-android-build"

# abi -> release arch name
# jniLibs path: app/src/main/jniLibs/<abi>/libnode.so
bundle_one() {
  abi="$1"
  arch="$2"
  tag="node-android-${arch}-${MAJOR}"
  mkdir -p "$CACHE"
  api="https://api.github.com/repos/${REPO}/releases/tags/${tag}"
  echo "Resolving $tag ..."
  asset=$(curl -fsSL "$api" | python3 -c 'import json,sys
j=json.load(sys.stdin)
names=[a["name"] for a in (j.get("assets") or []) if a["name"].endswith(".tar.xz")]
print(sorted(names)[-1] if names else "")')
  if [ -z "$asset" ]; then
    echo "warn: no asset for $tag" >&2
    return 1
  fi
  tarball="$CACHE/$asset"
  if [ ! -f "$tarball" ]; then
    url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
    echo "Downloading $url"
    curl -fL "$url" -o "$tarball"
  fi
  extract="$CACHE/extract-${arch}-${MAJOR}"
  rm -rf "$extract"
  mkdir -p "$extract"
  tar -xJf "$tarball" -C "$extract"
  node_bin=$(find "$extract" -type f -name node | head -n 1)
  if [ -z "$node_bin" ] || [ ! -f "$node_bin" ]; then
    echo "warn: node binary not found in $asset" >&2
    return 1
  fi
  # Android core uses Node 24 node:sqlite instead of better-sqlite3. Verify
  # the actual downloaded binary before it can enter the signed APK.
  sh "$ROOT/scripts/verify-android-node-binary.sh" "$node_bin"
  out_dir="$ANDROID_ROOT/app/src/main/jniLibs/$abi"
  mkdir -p "$out_dir"
  # Android PackageManager only auto-extracts lib*.so from jniLibs.
  cp "$node_bin" "$out_dir/libnode.so"
  chmod 755 "$out_dir/libnode.so"
  ls -lh "$out_dir/libnode.so"
  echo "bundled $arch -> jniLibs/$abi/libnode.so"
}

# Release workflow builds `--target aarch64`, so arm64 is the fast default.
# Other ABIs can be requested explicitly, e.g.
# NODE_ANDROID_ABIS="arm64-v8a armeabi-v7a x86_64".
NODE_ANDROID_ABIS="${NODE_ANDROID_ABIS:-arm64-v8a}"
LIBS_ROOT="$ANDROID_ROOT/app/src/main/jniLibs"
for abi in arm64-v8a armeabi-v7a x86_64; do
  case " $NODE_ANDROID_ABIS " in *" $abi "*) ;; *) rm -rf "$LIBS_ROOT/$abi" ;; esac
done
for abi in $NODE_ANDROID_ABIS; do
  case "$abi" in
    arm64-v8a) bundle_one "$abi" "arm64" ;;
    armeabi-v7a) bundle_one "$abi" "arm" ;;
    x86_64) bundle_one "$abi" "x64" ;;
    *) echo "ERROR: unsupported NODE_ANDROID_ABIS entry: $abi" >&2; exit 1 ;;
  esac
done

# Ensure extractNativeLibs so libnode.so is on a real filesystem path we can exec
MANIFEST="$ANDROID_ROOT/app/src/main/AndroidManifest.xml"
if [ -f "$MANIFEST" ]; then
  if ! grep -q 'extractNativeLibs' "$MANIFEST"; then
    # insert on <application ...>
    python3 - "$MANIFEST" <<'PY'
from pathlib import Path
import re, sys
p = Path(sys.argv[1])
m = p.read_text()
if "extractNativeLibs" not in m:
    m = re.sub(
        r"<application\b",
        '<application android:extractNativeLibs="true"',
        m,
        count=1,
    )
    p.write_text(m)
    print("manifest: extractNativeLibs=true")
PY
  fi
fi

echo "bundle-node-android done"
