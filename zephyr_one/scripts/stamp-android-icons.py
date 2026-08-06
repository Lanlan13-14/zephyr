#!/usr/bin/env python3
"""Overwrite Tauri-generated Android launcher icons with Zephyr ic_launcher."""
from pathlib import Path
from PIL import Image
import sys

# Prefer One-local copy; fall back to monorepo Agent asset.
_ONE = Path(__file__).resolve().parents[1]
_REPO = Path(__file__).resolve().parents[2]
SRC = _ONE / "platform_assets" / "android" / "ic_launcher.png"
if not SRC.exists():
    SRC = _REPO / "zephyr_agent" / "platform_assets" / "android" / "ic_launcher.png"
# density -> px
SIZES = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}

def main(android_root: Path):
    if not SRC.exists():
        raise SystemExit(f"missing source icon: {SRC}")
    src = Image.open(SRC).convert("RGBA")
    res = android_root / "app" / "src" / "main" / "res"
    if not res.exists():
        raise SystemExit(f"android res not found: {res}")
    for dens, px in SIZES.items():
        for folder in (f"mipmap-{dens}", f"mipmap-{dens}-v26"):
            d = res / folder
            if not d.exists():
                d.mkdir(parents=True, exist_ok=True)
            img = src.resize((px, px), Image.Resampling.LANCZOS)
            for name in ("ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"):
                # foreground often larger; use full art for all
                img.save(d / name)
        # also anyplaystore
    play = res / "play_store_512.png"
    src.resize((512, 512), Image.Resampling.LANCZOS).save(play)
    # adaptive icon XML may reference foreground — keep simple
    print("stamped icons into", res)

if __name__ == "__main__":
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "src-tauri/gen/android")
    main(root.resolve())
