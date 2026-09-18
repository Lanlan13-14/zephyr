#!/usr/bin/env sh
# Build zephyr-link-embed for the current (or supplied) GOOS/GOARCH and copy
# it next to the Flutter executable. Invoked from CI after `flutter build`.
set -eu

platform="${1:-}"
if [ -z "$platform" ]; then
  echo "usage: sh tool/bundle_link_runtime.sh linux|windows|macos|ios [dest-dir]" >&2
  exit 2
fi

root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
mod="$root/zephyr-link"
out_name="zephyr-link-embed"
goos=""
goarch="${GOARCH:-amd64}"
dest="${2:-}"

case "$platform" in
  linux)
    goos=linux
    goarch="${GOARCH:-amd64}"
    dest="${dest:-$root/zephyr_agent/build/linux/x64/release/bundle}"
    ;;
  windows)
    goos=windows
    goarch="${GOARCH:-amd64}"
    out_name="zephyr-link-embed.exe"
    dest="${dest:-$root/zephyr_agent/build/windows/x64/runner/Release}"
    ;;
  macos)
    goos=darwin
    goarch="${GOARCH:-arm64}"
    dest="${dest:-}"
    ;;
  ios)
    # GOOS=ios needs the iOS SDK linker (cgo). A darwin/arm64 Mach-O is what
    # we can produce without Xcode cgo; the host execs it the same way Android
    # execs libzephyr_link.so.
    goos=darwin
    goarch="${GOARCH:-arm64}"
    dest="${dest:-}"
    ;;
  *)
    echo "unknown platform: $platform" >&2
    exit 2
    ;;
esac

if [ -z "${GO:-}" ]; then
  if command -v go >/dev/null 2>&1; then
    GO="$(command -v go)"
  else
    echo "go not on PATH" >&2
    exit 1
  fi
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
bin="$tmp/$out_name"

CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" "$GO" build -C "$mod" -trimpath -ldflags='-s -w' \
  -o "$bin" ./cmd/zephyr-link-embed

if [ "$platform" = "macos" ] && [ -z "${2:-}" ]; then
  app_path="$(find "$root/zephyr_agent/build/macos/Build/Products/Release" -maxdepth 1 -name '*.app' | head -n 1)"
  if [ -z "$app_path" ]; then
    echo "macos .app not found; pass dest-dir" >&2
    exit 1
  fi
  dest="$app_path/Contents/MacOS"
fi

if [ "$platform" = "ios" ] && [ -z "${2:-}" ]; then
  app_path="$(find "$root/zephyr_agent/build/ios/iphoneos" -maxdepth 1 -name '*.app' | head -n 1)"
  if [ -z "$app_path" ]; then
    echo "ios .app not found; pass dest-dir" >&2
    exit 1
  fi
  dest="$app_path"
fi

if [ -z "$dest" ]; then
  echo "destination directory required" >&2
  exit 1
fi
mkdir -p "$dest"
cp "$bin" "$dest/$out_name"
chmod 755 "$dest/$out_name"
echo "bundled $out_name -> $dest/$out_name"
