#!/usr/bin/env python3
"""Overwrite Tauri-generated Android launcher icons with Zephyr ic_launcher.

Uses Pillow when available; otherwise copies the source PNG into each mipmap
slot (Android scales). CI may not have PIL installed.
"""
from pathlib import Path
import shutil
import sys

_ONE = Path(__file__).resolve().parents[1]
_REPO = Path(__file__).resolve().parents[2]
SRC = _ONE / "platform_assets" / "android" / "ic_launcher.png"
if not SRC.exists():
    SRC = _REPO / "zephyr_agent" / "platform_assets" / "android" / "ic_launcher.png"

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
    res = android_root / "app" / "src" / "main" / "res"
    if not res.exists():
        raise SystemExit(f"android res not found: {res}")

    try:
        from PIL import Image

        src = Image.open(SRC).convert("RGBA")
        use_pil = True
    except Exception:
        src = None
        use_pil = False
        print("PIL not available; copying full-size icon into mipmaps")

    for dens, px in SIZES.items():
        for folder in (f"mipmap-{dens}", f"mipmap-{dens}-v26"):
            d = res / folder
            d.mkdir(parents=True, exist_ok=True)
            for name in (
                "ic_launcher.png",
                "ic_launcher_round.png",
                "ic_launcher_foreground.png",
            ):
                out = d / name
                if use_pil:
                    src.resize((px, px), Image.Resampling.LANCZOS).save(out)
                else:
                    shutil.copyfile(SRC, out)
    play = res / "play_store_512.png"
    if use_pil:
        src.resize((512, 512), Image.Resampling.LANCZOS).save(play)
    else:
        shutil.copyfile(SRC, play)
    # drawable-nodpi already handled by prepare-android
    print("stamped icons into", res, "pil=" + str(use_pil))


if __name__ == "__main__":
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "src-tauri/gen/android")
    main(root.resolve())
