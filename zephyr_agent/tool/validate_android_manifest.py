#!/usr/bin/env python3
from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ANDROID = "http://schemas.android.com/apk/res/android"
NS = f"{{{ANDROID}}}"

THEMES = ["frost", "lava", "asagi", "cyber"]


def attr(node: ET.Element, name: str) -> str | None:
    return node.attrib.get(f"{NS}{name}")


def has_launcher(node: ET.Element) -> bool:
    for intent in node.findall("intent-filter"):
        has_main = any(attr(action, "name") == "android.intent.action.MAIN" for action in intent.findall("action"))
        has_launcher_category = any(attr(category, "name") == "android.intent.category.LAUNCHER" for category in intent.findall("category"))
        if has_main and has_launcher_category:
            return True
    return False


def validate_adaptive_icons(res_dir: Path) -> None:
    if not res_dir.exists():
        raise SystemExit(f"resources directory missing: {res_dir}")

    # Values check
    bg_light = res_dir / "values" / "ic_launcher_background.xml"
    if not bg_light.exists():
        raise SystemExit(f"missing light launcher background: {bg_light}")
    bg_dark = res_dir / "values-night" / "colors.xml"
    if not bg_dark.exists():
        raise SystemExit(f"missing dark launcher background: {bg_dark}")
    if "#FF10151C" not in bg_dark.read_text(encoding="utf-8").upper():
        raise SystemExit(f"dark launcher background must be #FF10151C: {bg_dark}")

    # Monochrome drawable
    mono = res_dir / "drawable" / "ic_launcher_monochrome.xml"
    if not mono.exists():
        raise SystemExit(f"missing monochrome launcher drawable: {mono}")
    mono_root = ET.parse(mono).getroot()
    if mono_root.tag != "vector":
        raise SystemExit(f"monochrome drawable must be <vector>: {mono}")

    for theme in THEMES:
        fg = res_dir / "drawable" / f"ic_launcher_foreground_{theme}.xml"
        if not fg.exists():
            raise SystemExit(f"missing foreground vector drawable: {fg}")
        fg_root = ET.parse(fg).getroot()
        if fg_root.tag != "vector":
            raise SystemExit(f"foreground drawable must be <vector>: {fg}")
        if attr(fg_root, "width") != "108dp" or attr(fg_root, "height") != "108dp":
            raise SystemExit(f"foreground vector must be 108dp x 108dp: {fg}")
        if attr(fg_root, "viewportWidth") != "200" or attr(fg_root, "viewportHeight") != "200":
            raise SystemExit(f"foreground vector viewport must be 200 x 200: {fg}")

        # Check scale group (0.7 to avoid abnormal magnification)
        has_scale_group = any(
            attr(g, "scaleX") == "0.7" and attr(g, "scaleY") == "0.7"
            for g in fg_root.iter("group")
        )
        if not has_scale_group:
            raise SystemExit(f"foreground vector must contain a group scaled by 0.7 to fit 66dp safe zone: {fg}")

        for version in ["mipmap-anydpi-v26", "mipmap-anydpi-v33"]:
            for suffix in ["", "_round"]:
                adaptive_file = res_dir / version / f"ic_launcher_{theme}{suffix}.xml"
                if not adaptive_file.exists():
                    raise SystemExit(f"missing adaptive icon XML: {adaptive_file}")
                root = ET.parse(adaptive_file).getroot()
                if root.tag != "adaptive-icon":
                    raise SystemExit(f"root must be <adaptive-icon>: {adaptive_file}")
                bg_node = root.find("background")
                fg_node = root.find("foreground")
                if bg_node is None or attr(bg_node, "drawable") != "@color/ic_launcher_background":
                    raise SystemExit(f"adaptive-icon background must be @color/ic_launcher_background: {adaptive_file}")
                expected_fg = f"@drawable/ic_launcher_foreground_{theme}"
                if fg_node is None or attr(fg_node, "drawable") != expected_fg:
                    raise SystemExit(f"adaptive-icon foreground must be {expected_fg}, found {attr(fg_node, 'drawable') if fg_node is not None else None}")
                if version == "mipmap-anydpi-v33":
                    mono_node = root.find("monochrome")
                    if mono_node is None or attr(mono_node, "drawable") != "@drawable/ic_launcher_monochrome":
                        raise SystemExit(f"v33 adaptive icon must have @drawable/ic_launcher_monochrome: {adaptive_file}")


def main() -> None:
    manifest = Path("android/app/src/main/AndroidManifest.xml")
    if not manifest.exists():
        # Fallback if validating from project root or platform_assets
        alt_manifest = Path("zephyr_agent/android/app/src/main/AndroidManifest.xml")
        if alt_manifest.exists():
            manifest = alt_manifest
        else:
            # Validate platform_assets directly if Android host is not yet staged
            res_dir = Path("platform_assets/android/res")
            if not res_dir.exists():
                res_dir = Path("zephyr_agent/platform_assets/android/res")
            if res_dir.exists():
                validate_adaptive_icons(res_dir)
                print("Platform assets Android Adaptive Icon validation passed")
                return
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
            icon = attr(child, "icon")
            if not icon or not icon.startswith("@mipmap/ic_launcher_"):
                raise SystemExit(f"alias {name} icon must point to @mipmap/ic_launcher_<theme>, found {icon}")
            round_icon = attr(child, "roundIcon")
            if round_icon and not round_icon.startswith("@mipmap/ic_launcher_"):
                raise SystemExit(f"alias {name} roundIcon must point to @mipmap/ic_launcher_<theme>_round, found {round_icon}")

    if main_activity is None:
        raise SystemExit("MainActivity not found")
    if len(launcher_aliases) != 4:
        raise SystemExit(f"expected exactly 4 launcher aliases, found {len(launcher_aliases)}: {launcher_aliases}")
    if len(set(launcher_aliases)) != len(launcher_aliases):
        raise SystemExit(f"duplicate launcher aliases: {launcher_aliases}")

    res_dir = manifest.parent / "res"
    validate_adaptive_icons(res_dir)
    print("Android manifest and adaptive launcher icons validation passed")


if __name__ == "__main__":
    main()
