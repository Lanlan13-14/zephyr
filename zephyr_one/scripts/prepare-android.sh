#!/usr/bin/env sh
# Stamp Zephyr icons + Agent-style release signing into Tauri Android project.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
ANDROID_ROOT="${1:-$ROOT/src-tauri/gen/android}"
APP="$ANDROID_ROOT/app"
GRADLE="$APP/build.gradle.kts"
MANIFEST="$APP/src/main/AndroidManifest.xml"
JKS_SRC="$ROOT/platform_assets/android/signing/zephyr-one-release.jks"
ICON_SRC="$ROOT/platform_assets/android/ic_launcher.png"

[ -d "$APP" ] || { echo "missing $APP — run: npx tauri android init" >&2; exit 1; }
[ -f "$JKS_SRC" ] || { echo "missing $JKS_SRC" >&2; exit 1; }

cp "$JKS_SRC" "$APP/zephyr-one-release.jks"
mkdir -p "$APP/src/main/res/drawable-nodpi"
cp "$ICON_SRC" "$APP/src/main/res/drawable-nodpi/zephyr_one_icon.png"
python3 "$ROOT/scripts/stamp-android-icons.py" "$ANDROID_ROOT"

python3 - "$GRADLE" "$MANIFEST" "$ANDROID_ROOT" <<'PY'
import re, sys
from pathlib import Path
gradle, manifest, android_root = map(Path, sys.argv[1:4])
s = gradle.read_text()
if "zephyr-one-release.jks" not in s:
    s = s.replace(
        "android {",
        '''android {
    signingConfigs {
        create("release") {
            storeFile = file("zephyr-one-release.jks")
            storePassword = "zephyr-agent-release"
            keyAlias = "zephyr-agent"
            keyPassword = "zephyr-agent-release"
        }
    }
''',
        1,
    )
if 'signingConfig = signingConfigs.getByName("release")' not in s:
    # common Tauri patterns
    s = s.replace(
        'signingConfig = signingConfigs.getByName("debug")',
        'signingConfig = signingConfigs.getByName("release")',
    )
    if 'signingConfig = signingConfigs.getByName("release")' not in s:
        s = re.sub(
            r'getByName\("release"\)\s*\{',
            'getByName("release") {\n            signingConfig = signingConfigs.getByName("release")',
            s,
            count=1,
        )
gradle.write_text(s)

props = android_root / "gradle.properties"
text = props.read_text() if props.exists() else ""
if "android.javaCompile.suppressSourceTargetDeprecationWarning" not in text:
    props.write_text(text + "\nandroid.javaCompile.suppressSourceTargetDeprecationWarning=true\n")

if manifest.exists():
    m = manifest.read_text()
    if "usesCleartextTraffic" not in m:
        m = re.sub(r"<application\b", '<application android:usesCleartextTraffic="true"', m, count=1)
    for perm in (
        "android.permission.INTERNET",
        "android.permission.ACCESS_NETWORK_STATE",
        "android.permission.USE_BIOMETRIC",
        "android.permission.USE_FINGERPRINT",
    ):
        if f'android:name="{perm}"' not in m:
            m = m.replace("</manifest>", f'    <uses-permission android:name="{perm}" />\n</manifest>', 1)
    m = re.sub(r'android:label="[^"]*"', 'android:label="Zephyr One"', m, count=1)
    m = m.replace('android:icon="@mipmap/ic_launcher"', 'android:icon="@drawable/zephyr_one_icon"')
    m = m.replace('android:roundIcon="@mipmap/ic_launcher_round"', 'android:roundIcon="@drawable/zephyr_one_icon"')
    manifest.write_text(m)
print("prepare-android: signing + icons + manifest OK")
PY

echo "prepare-android done: $ANDROID_ROOT"
