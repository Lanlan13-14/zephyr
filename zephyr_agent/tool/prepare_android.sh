#!/usr/bin/env sh
set -eu

# Called after `flutter create --platforms android .` in CI.
# Installs Zephyr Agent Android host code that implements SAF-backed disk
# mapping over Flutter MethodChannel.

mkdir -p android/app/src/main/kotlin/com/zephyr/zephyr_agent
cp android_host/MainActivity.kt android/app/src/main/kotlin/com/zephyr/zephyr_agent/MainActivity.kt

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
p.write_text(s)
PY
