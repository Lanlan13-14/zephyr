#!/usr/bin/env python3
"""Generate every Zephyr One icon artefact from the four themed SVG masters.

Inputs
    platform_assets/icons/zephyr-one-<theme>.svg   (frost | lava | asagi | cyber)

Outputs
    src-tauri/icons/*                      bundle icon set, rendered from frost
    src-tauri/runtime-icons/*.png          one per theme, for runtime set_icon

Why two output sets
    The bundle icon is baked into the installer and the .app / .exe resource, so
    it cannot change per theme. frost ("凝霜蓝") is the product default and is
    therefore what ships. The runtime set is what `window_set_theme_icon` hands
    to WebviewWindow::set_icon so Windows and Linux can follow the chosen
    palette live. macOS has no window icon at all (tao: "iOS / Android / macOS:
    Unsupported"), so it keeps the bundled frost icon — matching the rule that
    any platform without live switching falls back to frost.

Why the SVG keeps its white plate here
    The masters carry `<rect rx="44" fill="#ffffff"/>`. That plate stays for the
    app icon: the wind strokes run #eef2f7 → #6e7b88, which is nearly invisible
    against a light Windows taskbar without it. The in-app inline mark drops the
    plate instead (see theme-runtime.js) because a white square would punch a
    hole in a dark UI.

Runtime PNG size
    128×128. tao sets ICON_SMALL/ICON_BIG from this buffer and Windows scales
    down from there; 128 is a multiple of both 16 and 32, so the common 16/32/48
    presentations land on clean ratios, and it still has headroom for HiDPI
    title bars. Each file is a few KB, and they are compiled in with
    include_bytes! rather than shipped as resources — resource-path resolution
    is exactly what broke the desktop-runtime lookup before.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SVG_DIR = ROOT / "platform_assets" / "icons"
BUNDLE_OUT = ROOT / "src-tauri" / "icons"
RUNTIME_OUT = ROOT / "src-tauri" / "runtime-icons"

THEMES = ("frost", "lava", "asagi", "cyber")
DEFAULT_THEME = "frost"
RUNTIME_SIZE = 128
MASTER_SIZE = 1024

# Bundle set. Keys are file names, values the square edge length.
BUNDLE_PNGS = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "256x256.png": 256,
    "512x512.png": 512,
    "icon.png": 512,
    "icon-512.png": 512,
    "icon-1024.png": 1024,
}
# Windows .ico carries several sizes in one file so the shell can pick.
ICO_SIZES = (16, 32, 48, 64, 128, 256)
# .icns wants the full Retina ladder; PIL writes the sizes it is given.
ICNS_SIZES = (16, 32, 64, 128, 256, 512, 1024)


def render_svg(svg: Path, size: int, dest: Path) -> None:
    """Rasterise an SVG at an exact pixel size with librsvg."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "rsvg-convert",
            "--width", str(size),
            "--height", str(size),
            "--keep-aspect-ratio",
            "--format", "png",
            "--output", str(dest),
            str(svg),
        ],
        check=True,
    )


def require(path: Path, what: str) -> Path:
    if not path.exists():
        sys.exit(f"ERROR: missing {what}: {path}")
    return path


def main() -> None:
    if subprocess.run(["rsvg-convert", "--version"], capture_output=True).returncode != 0:
        sys.exit("ERROR: rsvg-convert (librsvg) is required to rasterise the SVG masters")

    for theme in THEMES:
        require(SVG_DIR / f"zephyr-one-{theme}.svg", f"{theme} SVG master")

    BUNDLE_OUT.mkdir(parents=True, exist_ok=True)
    RUNTIME_OUT.mkdir(parents=True, exist_ok=True)

    # ── runtime set: one PNG per theme ──
    for theme in THEMES:
        dest = RUNTIME_OUT / f"zephyr-one-{theme}.png"
        render_svg(SVG_DIR / f"zephyr-one-{theme}.svg", RUNTIME_SIZE, dest)
        print(f"runtime  {dest.relative_to(ROOT)}  {RUNTIME_SIZE}x{RUNTIME_SIZE}")

    # ── bundle set: rendered from the default theme ──
    default_svg = SVG_DIR / f"zephyr-one-{DEFAULT_THEME}.svg"
    master = BUNDLE_OUT / ".master.png"
    render_svg(default_svg, MASTER_SIZE, master)

    with Image.open(master) as src_img:
        src = src_img.convert("RGBA")

        for name, size in BUNDLE_PNGS.items():
            # Rasterise straight from the SVG whenever the size differs from the
            # master: vector output beats resampling a bitmap down.
            dest = BUNDLE_OUT / name
            if size == MASTER_SIZE:
                src.save(dest)
            else:
                render_svg(default_svg, size, dest)
            print(f"bundle   {dest.relative_to(ROOT)}  {size}x{size}")

        icos = [src.resize((s, s), Image.Resampling.LANCZOS) for s in ICO_SIZES]
        icos[0].save(
            BUNDLE_OUT / "icon.ico",
            format="ICO",
            sizes=[(i.width, i.height) for i in icos],
        )
        print(f"bundle   {(BUNDLE_OUT / 'icon.ico').relative_to(ROOT)}  {ICO_SIZES}")

        src.save(BUNDLE_OUT / "icon.icns", format="ICNS")
        print(f"bundle   {(BUNDLE_OUT / 'icon.icns').relative_to(ROOT)}  {ICNS_SIZES}")

    master.unlink(missing_ok=True)
    print(f"\nicons ready: bundle={BUNDLE_OUT.relative_to(ROOT)} runtime={RUNTIME_OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
