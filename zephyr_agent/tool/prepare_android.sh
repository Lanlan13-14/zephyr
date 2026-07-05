#!/usr/bin/env sh
set -eu

# Called after `flutter create --platforms android .` in CI.
# Installs Zephyr Agent Android host code that implements SAF-backed disk
# mapping over Flutter MethodChannel.

mkdir -p android/app/src/main/kotlin/com/zephyr/agent
cp android_host/MainActivity.kt android/app/src/main/kotlin/com/zephyr/agent/MainActivity.kt
mkdir -p android/app/src/main/res/drawable-nodpi
cp platform_assets/android/ic_launcher.png android/app/src/main/res/drawable-nodpi/zephyr_agent_icon.png
cp assets/icons/zephyr-agent-frost.png android/app/src/main/res/drawable-nodpi/zephyr_agent_icon_frost.png
cp assets/icons/zephyr-agent-lava.png android/app/src/main/res/drawable-nodpi/zephyr_agent_icon_lava.png
cp assets/icons/zephyr-agent-asagi.png android/app/src/main/res/drawable-nodpi/zephyr_agent_icon_asagi.png
cp assets/icons/zephyr-agent-cyber.png android/app/src/main/res/drawable-nodpi/zephyr_agent_icon_cyber.png
cp platform_assets/android/signing/zephyr-agent-release.jks android/app/zephyr-agent-release.jks

# Android SAF needs androidx.documentfile. Multiple dependencies blocks are OK
# in Gradle Kotlin DSL.
cat >> android/app/build.gradle.kts <<'EOF'

dependencies {
    implementation("androidx.documentfile:documentfile:1.0.1")
}
EOF

# Keep Android compile SDK explicit for current AndroidX/plugin metadata.
python3 - <<'PY'
from pathlib import Path
import re
p=Path('android/app/build.gradle.kts')
s=p.read_text()
s=s.replace('compileSdk = flutter.compileSdkVersion', 'compileSdk = 36')
s=s.replace('namespace = "com.zephyr.zephyr_agent"', 'namespace = "com.zephyr.agent"')
s=s.replace('applicationId = "com.zephyr.zephyr_agent"', 'applicationId = "com.zephyr.agent"')
s=s.replace('versionCode = flutter.versionCode', 'versionCode = (project.findProperty("ZEPHYR_AGENT_VERSION_CODE") as String?)?.toInt() ?: flutter.versionCode')
s=s.replace('versionName = flutter.versionName', 'versionName = (project.findProperty("ZEPHYR_AGENT_VERSION_NAME") as String?) ?: flutter.versionName')
if 'signingConfigs {' not in s:
    s=s.replace('android {', '''android {
    signingConfigs {
        create("release") {
            storeFile = file("zephyr-agent-release.jks")
            storePassword = "zephyr-agent-release"
            keyAlias = "zephyr-agent"
            keyPassword = "zephyr-agent-release"
        }
    }
''', 1)
    s=s.replace('buildTypes {\n        release {\n            // TODO: Add your own signing config for the release build.\n            // Signing with the debug keys for now, so `flutter run --release` works.\n            signingConfig = signingConfigs.getByName("debug")\n        }\n    }', 'buildTypes {\n        release {\n            signingConfig = signingConfigs.getByName("release")\n        }\n    }')
manifest=Path('android/app/src/main/AndroidManifest.xml')
m=manifest.read_text()
m=m.replace('android:label="zephyr_agent"', 'android:label="Zephyr Agent"')
m=m.replace('<manifest xmlns:android="http://schemas.android.com/apk/res/android">', '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />\n    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />\n    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />')
m=m.replace('android:icon="@mipmap/ic_launcher"', 'android:icon="@drawable/zephyr_agent_icon_frost"')
# MainActivity must not be a launcher entry. Launcher icon switching is implemented
# exclusively through activity-alias entries below; leaving Flutter's default
# MAIN/LAUNCHER intent-filter in place creates a second, non-switchable icon.
activity_match=re.search(r'(<activity\b[^>]*android:name="\.MainActivity"[\s\S]*?</activity>)', m)
if not activity_match:
    raise SystemExit('AndroidManifest.xml: MainActivity block not found')
activity_block=activity_match.group(1)
activity_block=re.sub(r'android:exported="true"', 'android:exported="false"', activity_block, count=1)

def drop_launcher_filter(match):
    block = match.group(0)
    if 'android.intent.action.MAIN' in block and 'android.intent.category.LAUNCHER' in block:
        return ''
    return block

activity_block=re.sub(r'\n\s*<intent-filter\b[\s\S]*?</intent-filter>', drop_launcher_filter, activity_block)
if 'android.intent.category.LAUNCHER' in activity_block:
    raise SystemExit('AndroidManifest.xml: failed to remove MainActivity launcher intent-filter')
m=m[:activity_match.start(1)] + activity_block + m[activity_match.end(1):]
# Re-running this script during local debugging must not duplicate aliases.
m=re.sub(r'\n\s*<activity-alias\b[\s\S]*?</activity-alias>', '', m)
aliases='''
        <activity-alias
            android:name=".LauncherFrost"
            android:enabled="true"
            android:exported="true"
            android:icon="@drawable/zephyr_agent_icon_frost"
            android:label="Zephyr Agent"
            android:targetActivity=".MainActivity">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity-alias>
        <activity-alias
            android:name=".LauncherLava"
            android:enabled="false"
            android:exported="true"
            android:icon="@drawable/zephyr_agent_icon_lava"
            android:label="Zephyr Agent"
            android:targetActivity=".MainActivity">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity-alias>
        <activity-alias
            android:name=".LauncherAsagi"
            android:enabled="false"
            android:exported="true"
            android:icon="@drawable/zephyr_agent_icon_asagi"
            android:label="Zephyr Agent"
            android:targetActivity=".MainActivity">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity-alias>
        <activity-alias
            android:name=".LauncherCyber"
            android:enabled="false"
            android:exported="true"
            android:icon="@drawable/zephyr_agent_icon_cyber"
            android:label="Zephyr Agent"
            android:targetActivity=".MainActivity">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity-alias>
'''
m=m.replace('</application>', aliases + '\n    </application>')
manifest.write_text(m)
p.write_text(s)
PY
