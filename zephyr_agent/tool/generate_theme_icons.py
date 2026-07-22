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
        "dotB": "#8e99a6",
        "midOffset": "58%",
    },
    "lava": {
        "main": "#f1e8df",
        "mid": "#c79672",
        "dark": "#8d5a3a",
        "dotA": "#bf5a1f",
        "dotB": "#a58a78",
        "midOffset": "58%",
    },
    "asagi": {
        "main": "#edf4f2",
        "mid": "#9bbdb5",
        "dark": "#5e8f83",
        "dotA": "#4d9c8a",
        "dotB": "#829b96",
        "midOffset": "58%",
    },
    "cyber": {
        "main": "#eef3f5",
        "mid": "#9eb7bd",
        "dark": "#5d858d",
        "dotA": "#4f9da6",
        "dotB": "#7f9298",
        "midOffset": "58%",
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


def svg_for(theme: str) -> str:
    p = PALETTES[theme]
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" fill="none">
  <defs>
    <linearGradient id="g" x1="15%" y1="15%" x2="85%" y2="85%">
      <stop offset="0%" stop-color="{p["main"]}"/>
      <stop offset="{p["midOffset"]}" stop-color="{p["mid"]}"/>
      <stop offset="100%" stop-color="{p["dark"]}"/>
    </linearGradient>
  </defs>
  <rect width="200" height="200" rx="44" fill="#ffffff"/>
  <path d="M 45 65 C 85 45, 135 55, 160 80 C 130 80, 95 95, 75 125" stroke="url(#g)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M 50 75 C 90 75, 125 90, 145 115 C 115 135, 75 155, 40 135" stroke="url(#g)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>
  <path d="M 85 95 C 110 110, 135 135, 155 130" stroke="url(#g)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.6"/>
  <circle cx="145" cy="115" r="4.5" fill="{p["dotA"]}" opacity="0.9"/>
  <circle cx="75" cy="125" r="3" fill="{p["dotB"]}" opacity="0.8"/>
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
  </defs>
  <path d="M 45 65 C 85 45, 135 55, 160 80 C 130 80, 95 95, 75 125" stroke="url(#g)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M 50 75 C 90 75, 125 90, 145 115 C 115 135, 75 155, 40 135" stroke="url(#g)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>
  <path d="M 85 95 C 110 110, 135 135, 155 130" stroke="url(#g)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.6"/>
  <circle cx="145" cy="115" r="4.5" fill="{p["dotA"]}" opacity="0.9"/>
  <circle cx="75" cy="125" r="3" fill="{p["dotB"]}" opacity="0.8"/>
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
            for name, size in APPLE_SIZES:
                render_png(svg, apple_dir / name, size)
            print(f"  apple set {apple_dir.name}")

    # Default launchers
    frost_png = ICONS / "zephyr-agent-frost.png"
    ANDROID_LAUNCHER.write_bytes(frost_png.read_bytes())
    WINDOWS_ICO.write_bytes((ICONS / "zephyr-agent-frost.ico").read_bytes())
    print("updated android/windows default launchers")


if __name__ == "__main__":
    main()
