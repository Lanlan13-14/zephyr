#!/usr/bin/env sh
# Validate the final APK, not merely the pre-AAPT assets directory.
set -eu
APK="${1:?usage: verify-android-apk.sh <apk>}"
[ -f "$APK" ] || { echo "APK not found: $APK" >&2; exit 1; }
command -v unzip >/dev/null 2>&1 || { echo "unzip is required" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required" >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

has_zip_entry() {
  # `unzip -Z1` is absent in BusyBox; `unzip -l` is portable enough here.
  unzip -l "$APK" | awk 'NR > 3 { print $4 }' | grep -Fx "$1" >/dev/null
}
has_zip_entry 'assets/zephyr-core.tar' || {
  echo "APK lacks exact assets/zephyr-core.tar" >&2; exit 1;
}
has_zip_entry 'lib/arm64-v8a/libnode.so' || {
  echo "APK lacks lib/arm64-v8a/libnode.so" >&2; exit 1;
}
unzip -p "$APK" assets/zephyr-core.tar >"$TMP/zephyr-core.tar"
tar -tf "$TMP/zephyr-core.tar" >"$TMP/files"
grep -E '(^|/)server\.js$' "$TMP/files" >/dev/null || {
  echo "core tar lacks server.js" >&2; exit 1;
}
grep -E '(^|/)public/' "$TMP/files" >/dev/null || {
  echo "core tar lacks public/" >&2; exit 1;
}
if grep -E '(^|/).*\.node$' "$TMP/files" >/dev/null; then
  echo "core tar retains unsupported host-native .node addon" >&2
  grep -E '(^|/).*\.node$' "$TMP/files" >&2
  exit 1
fi
if grep -E '(^|/)node_modules/(better-sqlite3|sharp|@img)(/|$)' "$TMP/files" >/dev/null; then
  echo "core tar retains Android-incompatible native dependency package" >&2
  grep -E '(^|/)node_modules/(better-sqlite3|sharp|@img)(/|$)' "$TMP/files" >&2
  exit 1
fi
printf 'APK verified: %s\n' "$APK"
printf 'core tar bytes: %s\n' "$(wc -c <"$TMP/zephyr-core.tar" | tr -d ' ')"
printf 'core file entries: %s\n' "$(wc -l <"$TMP/files" | tr -d ' ')"
