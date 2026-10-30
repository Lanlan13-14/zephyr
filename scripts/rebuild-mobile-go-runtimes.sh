#!/usr/bin/env bash
set -euo pipefail
# Compile a pristine, immutable checkout, then stage binaries in the packaging
# tree. Writing the first tracked .so must not dirty the next runtime's VCS stamp.
root="${GITHUB_WORKSPACE:?}"
source="${RUNNER_TEMP:?}/zephyr-mobile-go-source"
output="$RUNNER_TEMP/zephyr-mobile-go-output"
revision="$(git -C "$root" rev-parse HEAD)"
# Go's VCS detector in this pinned toolchain requires a .git directory.
# A linked worktree has only a .git file and silently loses VCS build settings.
git clone --shared --no-checkout "$root" "$source"
git -C "$source" checkout --detach "$revision"
test -d "$source/.git"
test -z "$(git -C "$source" status --porcelain)"
mkdir -p "$output"
for module in zephyr-ai zephyr-link; do
  case "$module" in
    zephyr-ai) entry=./cmd/zephyr-ai-android; name=libzephyr_ai_runtime.so ;;
    zephyr-link) entry=./cmd/zephyr-link-android; name=libzephyr_link.so ;;
  esac
  (cd "$source/$module" && CGO_ENABLED=0 GOOS=android GOARCH=arm64 \
    go build -buildvcs=true -mod=readonly -trimpath -ldflags='-s -w' -o "$output/$name" "$entry")
  go version -m "$output/$name" > "$output/$name.buildinfo.txt"
  cat "$output/$name.buildinfo.txt"
  rg -F "vcs.revision=$revision" "$output/$name.buildinfo.txt"
  rg -F 'vcs.modified=false' "$output/$name.buildinfo.txt"
  rg -F 'go1.26.10' "$output/$name.buildinfo.txt"
done
for name in libzephyr_ai_runtime.so libzephyr_link.so; do
  cp "$output/$name" "$root/zephyr_one/mobile/android/app/src/main/jniLibs/arm64-v8a/$name"
done
