#!/usr/bin/env sh
# Full Android open-box prep:
# 1) Zephyr icons
# 2) Release signing (Agent-style JKS — package id stays com.zephyr.one)
# 3) Bundle Node as jniLibs/*/libnode.so (installed directly by Android)
# 4) Bundle server.js into one streamable asset and copy public files as APK assets
# 5) Manifest: INTERNET, biometric, cleartext, extractNativeLibs
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
# Always absolute because generated Android paths are used by multiple tools.
ANDROID_ROOT="$(CDPATH= cd -- "${1:-$ROOT/src-tauri/gen/android}" && pwd)"
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

# Node jniLibs (open-box)
sh "$ROOT/scripts/bundle-node-android.sh" "$ANDROID_ROOT"

# Build a single dependency-complete CommonJS entry and copy public files into
# the APK asset tree. At runtime Rust streams the JS entry to Node over stdin;
# Node reads requested public files directly from base.apk. Nothing is expanded
# into filesDir during first launch or after an update.
CORE_SRC="$ROOT/zephyr-core"
ASSETS_DIR="$APP/src/main/assets"
if [ -d "$CORE_SRC" ] && [ -f "$CORE_SRC/server.js" ] && [ -d "$CORE_SRC/public" ]; then
    mkdir -p "$ASSETS_DIR"
    node "$ROOT/scripts/build-android-embedded-core.mjs" "$CORE_SRC" "$ASSETS_DIR"
    test -s "$ASSETS_DIR/zephyr-core.cjs"
    test -f "$ASSETS_DIR/zephyr-public/app.html"
    test ! -e "$ASSETS_DIR/zephyr-core.tar"
else
    echo "ERROR: zephyr-core not found at $CORE_SRC - run: npm run stage:core" >&2
    exit 1
fi

# Optional: stamp versionName/versionCode from env (set by scripts/set-version.py / CI)
VERSION_NAME="${ZEPHYR_ONE_VERSION_NAME:-}"
VERSION_CODE="${ZEPHYR_ONE_VERSION_CODE:-}"

python3 - "$GRADLE" "$MANIFEST" "$ANDROID_ROOT" "$VERSION_NAME" "$VERSION_CODE" <<'PY'
import re, sys
from pathlib import Path
gradle, manifest, android_root = map(Path, sys.argv[1:4])
version_name = (sys.argv[4] if len(sys.argv) > 4 else "").strip()
version_code = (sys.argv[5] if len(sys.argv) > 5 else "").strip()
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
# packaging: keep jniLibs .so
if "jniLibs" not in s and "packaging" not in s:
    s = s.replace(
        "android {",
        '''android {
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
''',
        1,
    )

# Stamp versionName / versionCode so Settings → App info matches release tag
# (one-v0.1.7 → versionName 0.1.7). Tauri also reads package version, but the
# generated gradle defaults to 0.1.0 unless we rewrite it.
if version_name:
    if re.search(r'versionName\s*=', s):
        s = re.sub(r'versionName\s*=\s*"[^"]*"', f'versionName = "{version_name}"', s, count=1)
    elif re.search(r'versionName\s+"', s):
        s = re.sub(r'versionName\s+"[^"]*"', f'versionName "{version_name}"', s, count=1)
    else:
        s = re.sub(
            r'(defaultConfig\s*\{)',
            rf'\1\n        versionName = "{version_name}"',
            s,
            count=1,
        )
if version_code and version_code.isdigit():
    if re.search(r'versionCode\s*=', s):
        s = re.sub(r'versionCode\s*=\s*\d+', f'versionCode = {version_code}', s, count=1)
    elif re.search(r'versionCode\s+\d+', s):
        s = re.sub(r'versionCode\s+\d+', f'versionCode {version_code}', s, count=1)
    else:
        s = re.sub(
            r'(defaultConfig\s*\{)',
            rf'\1\n        versionCode = {version_code}',
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
    if "extractNativeLibs" not in m:
        m = re.sub(r"<application\b", '<application android:extractNativeLibs="true"', m, count=1)
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
print("prepare-android: icons + signing + jniLibs node + manifest OK")
PY

echo "prepare-android done: $ANDROID_ROOT"
