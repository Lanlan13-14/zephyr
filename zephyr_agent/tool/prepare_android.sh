#!/usr/bin/env sh
set -eu

# Called after `flutter create --platforms android .` in CI.
# Installs Zephyr Agent Android host code that implements SAF-backed disk
# mapping over Flutter MethodChannel.

mkdir -p android/app/src/main/kotlin/com/zephyr/agent
cp android_host/MainActivity.kt android/app/src/main/kotlin/com/zephyr/agent/MainActivity.kt
mkdir -p android/app/src/main/res/drawable-nodpi
cp platform_assets/android/ic_launcher.png android/app/src/main/res/drawable-nodpi/zephyr_agent_icon.png

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
p=Path('android/app/build.gradle.kts')
s=p.read_text()
s=s.replace('compileSdk = flutter.compileSdkVersion', 'compileSdk = 36')
s=s.replace('namespace = "com.zephyr.zephyr_agent"', 'namespace = "com.zephyr.agent"')
s=s.replace('applicationId = "com.zephyr.zephyr_agent"', 'applicationId = "com.zephyr.agent"')
manifest=Path('android/app/src/main/AndroidManifest.xml')
m=manifest.read_text()
m=m.replace('android:label="zephyr_agent"', 'android:label="Zephyr Agent"')
m=m.replace('<manifest xmlns:android="http://schemas.android.com/apk/res/android">', '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />\n    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />\n    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />')
m=m.replace('android:icon="@mipmap/ic_launcher"', 'android:icon="@drawable/zephyr_agent_icon"')
manifest.write_text(m)
p.write_text(s)
PY
