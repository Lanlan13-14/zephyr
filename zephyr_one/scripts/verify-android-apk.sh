#!/usr/bin/env sh
# Validate the final APK, not merely the pre-AAPT assets directory.
set -eu
APK="${1:?usage: verify-android-apk.sh <apk>}"
[ -f "$APK" ] || { echo "APK not found: $APK" >&2; exit 1; }
command -v unzip >/dev/null 2>&1 || { echo "unzip is required" >&2; exit 1; }

has_zip_entry() {
  # `unzip -Z1` is absent in BusyBox; `unzip -l` is portable enough here.
  unzip -l "$APK" | awk 'NR > 3 { print $4 }' | grep -Fx "$1" >/dev/null
}
has_zip_entry 'assets/zephyr-core.cjs' || {
  echo "APK lacks assets/zephyr-core.cjs" >&2; exit 1;
}
has_zip_entry 'assets/zephyr-public/index.html' || {
  echo "APK lacks assets/zephyr-public/index.html" >&2; exit 1;
}
has_zip_entry 'assets/zephyr-public/app.html' || {
  echo "APK lacks assets/zephyr-public/app.html" >&2; exit 1;
}
has_zip_entry 'lib/arm64-v8a/libnode.so' || {
  echo "APK lacks lib/arm64-v8a/libnode.so" >&2; exit 1;
}
if has_zip_entry 'assets/zephyr-core.tar'; then
  echo "APK still contains the removed first-run extraction tar" >&2
  exit 1
fi
if unzip -l "$APK" | awk 'NR > 3 { print $4 }' | grep -E '(^|/).*\.node$' >/dev/null; then
  echo "APK contains an unsupported host-native .node addon" >&2
  exit 1
fi
unzip -p "$APK" assets/zephyr-core.cjs | grep -F 'ZEPHYR_ANDROID_APK_PATH' >/dev/null || {
  echo "embedded core lacks direct-APK asset support" >&2; exit 1;
}
printf 'APK verified: %s\n' "$APK"
printf 'embedded public entries: %s\n' "$(unzip -l "$APK" | awk 'NR > 3 { print $4 }' | grep -c '^assets/zephyr-public/' | tr -d ' ')"
