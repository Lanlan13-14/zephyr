#!/usr/bin/env python3
from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ANDROID = "http://schemas.android.com/apk/res/android"
NS = f"{{{ANDROID}}}"


def attr(node: ET.Element, name: str) -> str | None:
    return node.attrib.get(f"{NS}{name}")


def has_launcher(node: ET.Element) -> bool:
    for intent in node.findall("intent-filter"):
        has_main = any(attr(action, "name") == "android.intent.action.MAIN" for action in intent.findall("action"))
        has_launcher_category = any(attr(category, "name") == "android.intent.category.LAUNCHER" for category in intent.findall("category"))
        if has_main and has_launcher_category:
            return True
    return False


def main() -> None:
    manifest = Path("android/app/src/main/AndroidManifest.xml")
    if not manifest.exists():
        raise SystemExit(f"missing manifest: {manifest}")
    root = ET.parse(manifest).getroot()
    app = root.find("application")
    if app is None:
        raise SystemExit("manifest has no application")

    main_activity = None
    launcher_aliases = []
    for child in list(app):
        name = attr(child, "name")
        if child.tag == "activity" and name == ".MainActivity":
            main_activity = child
            if has_launcher(child):
                raise SystemExit("MainActivity still has a MAIN/LAUNCHER intent-filter; this creates a duplicate desktop icon")
            if attr(child, "exported") == "true":
                raise SystemExit("MainActivity is still exported=true; launcher aliases should be the only exported entries")
        if child.tag == "activity-alias" and has_launcher(child):
            launcher_aliases.append(name)

    if main_activity is None:
        raise SystemExit("MainActivity not found")
    if len(launcher_aliases) != 4:
        raise SystemExit(f"expected exactly 4 launcher aliases, found {len(launcher_aliases)}: {launcher_aliases}")
    if len(set(launcher_aliases)) != len(launcher_aliases):
        raise SystemExit(f"duplicate launcher aliases: {launcher_aliases}")
    print("Android manifest launcher validation passed")


if __name__ == "__main__":
    main()
