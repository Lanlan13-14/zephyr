#!/usr/bin/env bash
# Run only on the Apple CI runner. Build with the same clean source revision as the app.
set -euo pipefail
kind="${1:?host or ios-device}"
out="${2:?absolute output archive}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ "$(uname -s)" == Darwin ]] || { echo 'Apple SDK runner required' >&2; exit 1; }
[[ "$out" == /* ]] || { echo 'Absolute output archive required' >&2; exit 1; }
[[ "$(go env GOVERSION)" == go1.26.10 ]] || { echo 'Go 1.26.10 required' >&2; exit 1; }
mkdir -p "$(dirname "$out")"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/zephyr-link-apple.XXXXXX")"
trap 'rm -rf "$work"' EXIT
revision="$(git -C "$root" rev-parse HEAD)"
git clone --shared --no-checkout "$root" "$work/source" >/dev/null 2>&1
git -C "$work/source" checkout --detach "$revision" >/dev/null 2>&1
export CGO_ENABLED=1
case "$kind" in
  host)
    export GOOS=darwin
    case "$(uname -m)" in arm64) export GOARCH=arm64;; x86_64) export GOARCH=amd64;; *) exit 1;; esac
    export CC="$(xcrun --sdk macosx --find clang)"
    export SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
    export CGO_CFLAGS="-isysroot $SDKROOT"
    export CGO_LDFLAGS="$CGO_CFLAGS"
    ;;
  ios-device)
    export GOOS=ios GOARCH=arm64
    export CC="$(xcrun --sdk iphoneos --find clang)"
    export CGO_CFLAGS="-arch arm64 -isysroot $(xcrun --sdk iphoneos --show-sdk-path) -miphoneos-version-min=17.0"
    export CGO_LDFLAGS="$CGO_CFLAGS"
    ;;
  *) echo 'Expected host or ios-device' >&2; exit 1;;
esac
(cd "$work/source/zephyr-link" && go build -buildvcs=true -trimpath -buildmode=c-archive -o "$out" ./cmd/zephyr-link-apple)
go version -m "$out" > "$out.buildinfo.txt" 2>&1 || true
# Archives are not executables on every Go revision. Identity is also asserted by running
# ZephyrLinkBuildInfo from the linked Swift test executable, not inferred from this text alone.
printf '%s\n' "$revision" > "$out.revision.txt"
[[ -s "$out" ]]
# Native exports must actually be present; a successful no-op build is not evidence.
xcrun nm -g "$out" > "$out.symbols.txt"
for symbol in ZephyrLinkCreate ZephyrLinkCall ZephyrLinkDestroy ZephyrLinkBuildInfo ZephyrLinkFree; do
  rg "_$symbol$" "$out.symbols.txt" >/dev/null
done
