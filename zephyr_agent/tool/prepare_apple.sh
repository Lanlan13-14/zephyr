#!/usr/bin/env sh
set -eu

platform="$1"

if [ "$platform" = "ios" ]; then
  rm -rf ios/Runner/Assets.xcassets/AppIcon.appiconset
  cp -R platform_assets/apple/AppIcon.appiconset ios/Runner/Assets.xcassets/AppIcon.appiconset
  python3 - <<'PY'
import plistlib
from pathlib import Path
p=Path('ios/Runner/Info.plist')
d=plistlib.loads(p.read_bytes())
d['CFBundleDisplayName']='Zephyr Agent'
d['CFBundleName']='Zephyr Agent'
d['CFBundleIdentifier']='com.zephyr.agent'
p.write_bytes(plistlib.dumps(d))
pbx=Path('ios/Runner.xcodeproj/project.pbxproj')
if pbx.exists():
    s=pbx.read_text()
    s=s.replace('PRODUCT_BUNDLE_IDENTIFIER = com.zephyr.zephyrAgent;', 'PRODUCT_BUNDLE_IDENTIFIER = com.zephyr.agent;')
    s=s.replace('PRODUCT_BUNDLE_IDENTIFIER = com.zephyr.zephyr-agent;', 'PRODUCT_BUNDLE_IDENTIFIER = com.zephyr.agent;')
    s=s.replace('PRODUCT_BUNDLE_IDENTIFIER = com.zephyr.zephyr_agent;', 'PRODUCT_BUNDLE_IDENTIFIER = com.zephyr.agent;')
    pbx.write_text(s)
PY
elif [ "$platform" = "macos" ]; then
  rm -rf macos/Runner/Assets.xcassets/AppIcon.appiconset
  cp -R platform_assets/macos/AppIcon.appiconset macos/Runner/Assets.xcassets/AppIcon.appiconset
  python3 - <<'PY'
from pathlib import Path
for rel in ['macos/Runner/Configs/AppInfo.xcconfig','macos/Runner/Info.plist']:
    p=Path(rel)
    if not p.exists():
        continue
    s=p.read_text()
    s=s.replace('PRODUCT_NAME = zephyr_agent', 'PRODUCT_NAME = Zephyr Agent')
    s=s.replace('PRODUCT_BUNDLE_IDENTIFIER = com.zephyr.zephyrAgent', 'PRODUCT_BUNDLE_IDENTIFIER = com.zephyr.agent')
    s=s.replace('PRODUCT_BUNDLE_IDENTIFIER = com.zephyr.zephyr-agent', 'PRODUCT_BUNDLE_IDENTIFIER = com.zephyr.agent')
    s=s.replace('PRODUCT_BUNDLE_IDENTIFIER = com.zephyr.zephyr_agent', 'PRODUCT_BUNDLE_IDENTIFIER = com.zephyr.agent')
    s=s.replace('<string>zephyr_agent</string>', '<string>Zephyr Agent</string>')
    p.write_text(s)
PY
else
  echo "usage: sh tool/prepare_apple.sh ios|macos" >&2
  exit 2
fi
