#!/bin/sh
# Ensure INTERNET + cleartext for http Zephyr hosts; stamp icons.
set -eu
ANDROID_ROOT="${1:-src-tauri/gen/android}"
MANIFEST="$ANDROID_ROOT/app/src/main/AndroidManifest.xml"
if [ -f "$MANIFEST" ]; then
  # usesCleartextTraffic
  if ! grep -q 'usesCleartextTraffic' "$MANIFEST"; then
    sed -i 's/<application /<application android:usesCleartextTraffic="true" /' "$MANIFEST" || true
  fi
  if ! grep -q 'android.permission.INTERNET' "$MANIFEST"; then
    sed -i 's#</manifest>#    <uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />\n</manifest>#' "$MANIFEST" || true
  fi
fi
python3 "$(dirname "$0")/stamp-android-icons.py" "$ANDROID_ROOT"
echo "android patched: $ANDROID_ROOT"
