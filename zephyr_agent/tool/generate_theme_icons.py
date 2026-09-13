#!/usr/bin/env python3
"""Regenerate Zephyr Agent theme icons from the web ICON_PALETTES."""
from __future__ import annotations

import struct
import subprocess
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "assets" / "icons"
LOGO = ROOT / "assets" / "logo" / "zephyr-logo.svg"
ANDROID_LAUNCHER = ROOT / "platform_assets" / "android" / "ic_launcher.png"
ANDROID_RES = ROOT / "platform_assets" / "android" / "res"
WINDOWS_ICO = ROOT / "platform_assets" / "windows" / "app_icon.ico"
APPLE_SETS = {
    "frost": ROOT / "platform_assets" / "apple" / "AppIcon.appiconset",
    "lava": ROOT / "platform_assets" / "apple" / "ZephyrAgent_lava.appiconset",
    "asagi": ROOT / "platform_assets" / "apple" / "ZephyrAgent_asagi.appiconset",
    "cyber": ROOT / "platform_assets" / "apple" / "ZephyrAgent_cyber.appiconset",
}

# Exact match for public/theme-runtime.js ICON_PALETTES
PALETTES = {
    "frost": {
        "main": "#eef2f7",
        "mid": "#a8b5c3",
        "dark": "#6e7b88",
        "dotA": "#0a84ff",
        "midOffset": "58%",
        "bgDark": ["#1e242c", "#101419"],
    },
    "lava": {
        "main": "#f1e8df",
        "mid": "#c79672",
        "dark": "#8d5a3a",
        "dotA": "#bf5a1f",
        "midOffset": "58%",
        "bgDark": ["#241c17", "#15100c"],
    },
    "asagi": {
        "main": "#edf4f2",
        "mid": "#9bbdb5",
        "dark": "#5e8f83",
        "dotA": "#4d9c8a",
        "midOffset": "58%",
        "bgDark": ["#17221f", "#0e1614"],
    },
    "cyber": {
        "main": "#eef3f5",
        "mid": "#9eb7bd",
        "dark": "#5d858d",
        "dotA": "#4f9da6",
        "midOffset": "58%",
        "bgDark": ["#152024", "#0d1417"],
    },
}

APPLE_SIZES = [
    ("Icon-App-20x20@1x.png", 20),
    ("Icon-App-20x20@2x.png", 40),
    ("Icon-App-20x20@3x.png", 60),
    ("Icon-App-29x29@1x.png", 29),
    ("Icon-App-29x29@2x.png", 58),
    ("Icon-App-29x29@3x.png", 87),
    ("Icon-App-40x40@1x.png", 40),
    ("Icon-App-40x40@2x.png", 80),
    ("Icon-App-40x40@3x.png", 120),
    ("Icon-App-60x60@2x.png", 120),
    ("Icon-App-60x60@3x.png", 180),
    ("Icon-App-76x76@1x.png", 76),
    ("Icon-App-76x76@2x.png", 152),
    ("Icon-App-83.5x83.5@2x.png", 167),
    ("Icon-App-1024x1024@1x.png", 1024),
]

ICO_SIZES = [16, 32, 48, 64, 128, 256]


def svg_for(theme: str, dark_mode: bool = False) -> str:
    p = PALETTES[theme]
    bg_top = p["bgDark"][0] if dark_mode else "#ffffff"
    bg_bot = p["bgDark"][1] if dark_mode else "#ffffff"
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" fill="none">
  <defs>
    <linearGradient id="bg_{theme}_{dark_mode}" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="{bg_top}"/>
      <stop offset="100%" stop-color="{bg_bot}"/>
    </linearGradient>
    <linearGradient id="g" x1="15%" y1="15%" x2="85%" y2="85%">
      <stop offset="0%" stop-color="{p["main"]}"/>
      <stop offset="{p["midOffset"]}" stop-color="{p["mid"]}"/>
      <stop offset="100%" stop-color="{p["dark"]}"/>
    </linearGradient>
    <mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">
      <rect width="200" height="200" fill="#ffffff"/>
      <circle cx="145" cy="115" r="6.2" fill="#000000"/>
    </mask>
  </defs>
  <rect width="200" height="200" rx="44" fill="url(#bg_{theme}_{dark_mode})"/>
  <path d="M 43 64 C 84 44, 138 52, 160 77 C 148 94, 108 104, 76 123" stroke="url(#g)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M 49 76 C 89 74, 126 89, 145 115 C 120 134, 76 153, 40 135" stroke="url(#g)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" opacity="0.88" mask="url(#cut)"/>
  <path d="M 80 92 C 108 108, 137 135, 162 129" stroke="url(#g)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.65"/>
  <circle cx="145" cy="115" r="4.5" fill="{p["dotA"]}" opacity="0.9"/>
</svg>
'''


def render_png(svg_text: str, out: Path, size: int = 1024) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".svg.tmp")
    tmp.write_text(svg_text, encoding="utf-8")
    try:
        subprocess.check_call(
            [
                "rsvg-convert",
                "-w",
                str(size),
                "-h",
                str(size),
                "-o",
                str(out),
                str(tmp),
            ]
        )
    finally:
        tmp.unlink(missing_ok=True)


def png_chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def read_png(path: Path) -> bytes:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"not a PNG: {path}")
    return data


def ico_from_pngs(png_paths: list[Path], out: Path) -> None:
    images = []
    for png in png_paths:
        raw = read_png(png)
        # IHDR is first chunk after signature
        width = struct.unpack(">I", raw[16:20])[0]
        height = struct.unpack(">I", raw[20:24])[0]
        images.append((width if width < 256 else 0, height if height < 256 else 0, raw))

    count = len(images)
    offset = 6 + 16 * count
    header = struct.pack("<HHH", 0, 1, count)
    entries = b""
    payloads = b""
    for w, h, raw in images:
        entries += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(raw), offset)
        payloads += raw
        offset += len(raw)
    out.write_bytes(header + entries + payloads)


def android_vector_drawable_for(theme: str) -> str:
    p = PALETTES[theme]
    main_c = p["main"].upper()
    mid_c = p["mid"].upper()
    dark_c = p["dark"].upper()
    dot_c = p["dotA"].upper()
    return f'''<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="200"
    android:viewportHeight="200">

    <group
        android:pivotX="100"
        android:pivotY="100"
        android:scaleX="0.7"
        android:scaleY="0.7">

        <path
            android:pathData="M 43 64 C 84 44, 138 52, 160 77 C 148 94, 108 104, 76 123"
            android:strokeWidth="10"
            android:strokeLineCap="round"
            android:strokeLineJoin="round">
            <aapt:attr name="android:strokeColor">
                <gradient
                    android:startX="30"
                    android:startY="30"
                    android:endX="170"
                    android:endY="170"
                    android:type="linear">
                    <item android:offset="0" android:color="#FF{main_c[1:]}" />
                    <item android:offset="0.58" android:color="#FF{mid_c[1:]}" />
                    <item android:offset="1" android:color="#FF{dark_c[1:]}" />
                </gradient>
            </aapt:attr>
        </path>

        <group>
            <clip-path
                android:fillType="evenOdd"
                android:pathData="M 0 0 H 200 V 200 H 0 Z M 138.8 115 A 6.2 6.2 0 1 0 151.2 115 A 6.2 6.2 0 1 0 138.8 115 Z" />
            <path
                android:pathData="M 49 76 C 89 74, 126 89, 145 115 C 120 134, 76 153, 40 135"
                android:strokeWidth="6"
                android:strokeAlpha="0.88"
                android:strokeLineCap="round"
                android:strokeLineJoin="round">
                <aapt:attr name="android:strokeColor">
                    <gradient
                        android:startX="30"
                        android:startY="30"
                        android:endX="170"
                        android:endY="170"
                        android:type="linear">
                        <item android:offset="0" android:color="#FF{main_c[1:]}" />
                        <item android:offset="0.58" android:color="#FF{mid_c[1:]}" />
                        <item android:offset="1" android:color="#FF{dark_c[1:]}" />
                    </gradient>
                </aapt:attr>
            </path>
        </group>

        <path
            android:pathData="M 80 92 C 108 108, 137 135, 162 129"
            android:strokeWidth="3.5"
            android:strokeAlpha="0.65"
            android:strokeLineCap="round"
            android:strokeLineJoin="round">
            <aapt:attr name="android:strokeColor">
                <gradient
                    android:startX="30"
                    android:startY="30"
                    android:endX="170"
                    android:endY="170"
                    android:type="linear">
                    <item android:offset="0" android:color="#FF{main_c[1:]}" />
                    <item android:offset="0.58" android:color="#FF{mid_c[1:]}" />
                    <item android:offset="1" android:color="#FF{dark_c[1:]}" />
                </gradient>
            </aapt:attr>
        </path>

        <path
            android:pathData="M 140.5 115 A 4.5 4.5 0 1 0 149.5 115 A 4.5 4.5 0 1 0 140.5 115 Z"
            android:fillColor="#FF{dot_c[1:]}"
            android:fillAlpha="0.9" />
    </group>
</vector>
'''


def android_vector_drawable_monochrome() -> str:
    return '''<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="200"
    android:viewportHeight="200">

    <group
        android:pivotX="100"
        android:pivotY="100"
        android:scaleX="0.7"
        android:scaleY="0.7">

        <path
            android:pathData="M 43 64 C 84 44, 138 52, 160 77 C 148 94, 108 104, 76 123"
            android:strokeColor="#FF000000"
            android:strokeWidth="10"
            android:strokeLineCap="round"
            android:strokeLineJoin="round" />

        <group>
            <clip-path
                android:fillType="evenOdd"
                android:pathData="M 0 0 H 200 V 200 H 0 Z M 138.8 115 A 6.2 6.2 0 1 0 151.2 115 A 6.2 6.2 0 1 0 138.8 115 Z" />
            <path
                android:pathData="M 49 76 C 89 74, 126 89, 145 115 C 120 134, 76 153, 40 135"
                android:strokeColor="#FF000000"
                android:strokeWidth="6"
                android:strokeAlpha="0.88"
                android:strokeLineCap="round"
                android:strokeLineJoin="round" />
        </group>

        <path
            android:pathData="M 80 92 C 108 108, 137 135, 162 129"
            android:strokeColor="#FF000000"
            android:strokeWidth="3.5"
            android:strokeAlpha="0.65"
            android:strokeLineCap="round"
            android:strokeLineJoin="round" />

        <path
            android:pathData="M 140.5 115 A 4.5 4.5 0 1 0 149.5 115 A 4.5 4.5 0 1 0 140.5 115 Z"
            android:fillColor="#FF000000"
            android:fillAlpha="0.9" />
    </group>
</vector>
'''


def android_adaptive_icon_xml(theme: str, v33: bool = False) -> str:
    monochrome_line = '    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />\\n' if v33 else ''
    return f'''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground_{theme}" />
{monochrome_line}</adaptive-icon>
'''


def main() -> None:
    ICONS.mkdir(parents=True, exist_ok=True)
    frost_svg = svg_for("frost")
    # Transparent-logo style SVG used in-app / assets/logo (no dark plate)
    p = PALETTES["frost"]
    LOGO.write_text(
        f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" fill="none">
  <defs>
    <linearGradient id="g" x1="15%" y1="15%" x2="85%" y2="85%">
      <stop offset="0%" stop-color="{p["main"]}"/>
      <stop offset="{p["midOffset"]}" stop-color="{p["mid"]}"/>
      <stop offset="100%" stop-color="{p["dark"]}"/>
    </linearGradient>
    <mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">
      <rect width="200" height="200" fill="#ffffff"/>
      <circle cx="145" cy="115" r="6.2" fill="#000000"/>
    </mask>
  </defs>
  <path d="M 43 64 C 84 44, 138 52, 160 77 C 148 94, 108 104, 76 123" stroke="url(#g)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M 49 76 C 89 74, 126 89, 145 115 C 120 134, 76 153, 40 135" stroke="url(#g)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" opacity="0.88" mask="url(#cut)"/>
  <path d="M 80 92 C 108 108, 137 135, 162 129" stroke="url(#g)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.65"/>
  <circle cx="145" cy="115" r="4.5" fill="{p["dotA"]}" opacity="0.9"/>
</svg>
''',
        encoding="utf-8",
    )

    for theme in PALETTES:
        svg = svg_for(theme)
        png = ICONS / f"zephyr-agent-{theme}.png"
        render_png(svg, png, 1024)
        # multi-size ico
        tmp_pngs = []
        for size in ICO_SIZES:
            tmp = ICONS / f".tmp-{theme}-{size}.png"
            render_png(svg, tmp, size)
            tmp_pngs.append(tmp)
        ico = ICONS / f"zephyr-agent-{theme}.ico"
        ico_from_pngs(tmp_pngs, ico)
        for tmp in tmp_pngs:
            tmp.unlink(missing_ok=True)
        print(f"wrote {png.name} + {ico.name}")

        apple_dir = APPLE_SETS.get(theme)
        if apple_dir and apple_dir.exists():
            # Apple HIG: also generate Dark Mode variants for iOS 18 / macOS 15 (Appearance: Any, Dark)
            for name, size in APPLE_SIZES:
                # Light / Default variant
                render_png(svg_for(theme, dark_mode=False), apple_dir / name, size)
                # Dark variant (suffix -Dark)
                dark_name = name.replace('.png', '-Dark.png')
                render_png(svg_for(theme, dark_mode=True), apple_dir / dark_name, size)
            print(f"  apple set {apple_dir.name} (Light + Dark variants)")

    # Default launchers
    frost_png = ICONS / "zephyr-agent-frost.png"
    ANDROID_LAUNCHER.write_bytes(frost_png.read_bytes())
    WINDOWS_ICO.write_bytes((ICONS / "zephyr-agent-frost.ico").read_bytes())
    print("updated android/windows default launchers")

    # Android Adaptive Icon resources (VectorDrawables, values, mipmap v26 & v33)
    (ANDROID_RES / "drawable").mkdir(parents=True, exist_ok=True)
    (ANDROID_RES / "values").mkdir(parents=True, exist_ok=True)
    (ANDROID_RES / "values-night").mkdir(parents=True, exist_ok=True)
    (ANDROID_RES / "mipmap-anydpi-v26").mkdir(parents=True, exist_ok=True)
    (ANDROID_RES / "mipmap-anydpi-v33").mkdir(parents=True, exist_ok=True)

    (ANDROID_RES / "values" / "ic_launcher_background.xml").write_text('''<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#FFFFFFFF</color>
</resources>
''', encoding="utf-8")
    (ANDROID_RES / "values-night" / "colors.xml").write_text('''<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#FF10151C</color>
</resources>
''', encoding="utf-8")
    (ANDROID_RES / "drawable" / "ic_launcher_monochrome.xml").write_text(android_vector_drawable_monochrome(), encoding="utf-8")

    for theme in PALETTES:
        (ANDROID_RES / "drawable" / f"ic_launcher_foreground_{theme}.xml").write_text(android_vector_drawable_for(theme), encoding="utf-8")
        ad_v26 = android_adaptive_icon_xml(theme, v33=False)
        (ANDROID_RES / "mipmap-anydpi-v26" / f"ic_launcher_{theme}.xml").write_text(ad_v26, encoding="utf-8")
        (ANDROID_RES / "mipmap-anydpi-v26" / f"ic_launcher_{theme}_round.xml").write_text(ad_v26, encoding="utf-8")
        ad_v33 = android_adaptive_icon_xml(theme, v33=True)
        (ANDROID_RES / "mipmap-anydpi-v33" / f"ic_launcher_{theme}.xml").write_text(ad_v33, encoding="utf-8")
        (ANDROID_RES / "mipmap-anydpi-v33" / f"ic_launcher_{theme}_round.xml").write_text(ad_v33, encoding="utf-8")
    print(f"  android adaptive icon set under {ANDROID_RES.name}")


if __name__ == "__main__":
    main()
