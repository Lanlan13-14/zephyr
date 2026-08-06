#!/usr/bin/env python3
"""Generate Tauri icon set from Zephyr Agent frost PNG."""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT.parent / "zephyr_agent" / "assets" / "icons" / "zephyr-agent-frost.png"
OUT = ROOT / "src-tauri" / "icons"

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    src = Image.open(SRC).convert("RGBA")
    for size in (32, 128, 256, 512):
        img = src.resize((size, size), Image.Resampling.LANCZOS)
        img.save(OUT / f"{size}x{size}.png")
        if size == 128:
            src.resize((256, 256), Image.Resampling.LANCZOS).save(OUT / "128x128@2x.png")
    src.resize((512, 512), Image.Resampling.LANCZOS).save(OUT / "icon.png")
    src.resize((512, 512), Image.Resampling.LANCZOS).save(OUT / "icon-512.png")
    src.resize((1024, 1024), Image.Resampling.LANCZOS).save(OUT / "icon-1024.png")
    # Windows ico
    icos = [src.resize((s, s), Image.Resampling.LANCZOS) for s in (16, 32, 48, 64, 128, 256)]
    icos[0].save(OUT / "icon.ico", format="ICO", sizes=[(i.width, i.height) for i in icos])
    print("icons ready in", OUT)

if __name__ == "__main__":
    main()
