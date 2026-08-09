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

import re
import subprocess
import sys
import tempfile
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


# ---------------------------------------------------------------------------
# Wordmark outlining
# ---------------------------------------------------------------------------
#
# branding/manifest.json freezes two rules that pull against each other:
#
#     "productionRule": "Convert the One text to fixed paths before generating
#      Android or iOS release assets. Preserve the source files unchanged."
#
# So the masters on disk keep their <text> elements (they are the reviewable
# source, and their SHA-256 is recorded in the manifest), and the conversion to
# outlines happens here, in memory, on the way to the rasteriser.
#
# Why it matters for the desktop bundle too, not just Android/iOS: <text> is
# resolved against the *build machine's* font set at rasterisation time. Measured
# on the frost master, rendering with Segoe UI Bold present versus absent moves
# 256 pixels inside the wordmark box - so the shipped icon silently depended on
# which fonts the CI runner happened to have. An outline cannot vary.
#
# Geometry: Segoe UI Bold, font-size 15 in the 200x200 viewBox, "O" centred on
# x=145 (branding/manifest.json geometry.oneAnchor) and "ne" starting at x=152.4,
# baseline y=120.7 - the same numbers the masters specify. Verified against the
# text rendering: 0.4% of pixels differ at 256px, all inside the wordmark's own
# bounding box and all at antialiasing edges.
WORDMARK_PATH = (
    "M144.95 120.88Q142.70 120.88 141.28 119.41Q139.85 117.95 139.85 115.59Q139.85 113.10 141.30 111.56Q142.74 110.02 145.12 110.02Q147.37 110.02 148.76 111.49Q150.15 112.97 150.15 115.38Q150.15 117.85 148.71 119.37Q147.27 120.88 144.95 120.88ZM145.05 112.06Q143.81 112.06 143.08 112.99Q142.34 113.93 142.34 115.46Q142.34 117.02 143.08 117.93Q143.81 118.84 145.00 118.84Q146.22 118.84 146.94 117.96Q147.66 117.07 147.66 115.51Q147.66 113.87 146.96 112.97Q146.26 112.06 145.05 112.06Z M160.62 120.70H158.31V116.53Q158.31 114.79 157.07 114.79Q156.46 114.79 156.08 115.25Q155.69 115.71 155.69 116.42V120.70H153.37V113.20H155.69V114.39H155.72Q156.55 113.02 158.13 113.02Q160.62 113.02 160.62 116.11Z M169.19 117.61H164.29Q164.41 119.24 166.35 119.24Q167.59 119.24 168.53 118.66V120.33Q167.49 120.88 165.83 120.88Q164.01 120.88 163.01 119.88Q162.00 118.87 162.00 117.07Q162.00 115.20 163.09 114.11Q164.17 113.02 165.75 113.02Q167.39 113.02 168.29 113.99Q169.19 114.97 169.19 116.64ZM167.04 116.19Q167.04 114.58 165.74 114.58Q165.18 114.58 164.77 115.04Q164.37 115.50 164.28 116.19Z"
)

# The <g> the masters wrap the two <text> runs in. Captured so the fill and
# opacity carry over unchanged: the colour is per-palette and must not be
# hardcoded here.
WORDMARK_GROUP = re.compile(
    r'<g font-family="[^"]*"\s+font-size="15"\s+font-weight="800"\s+'
    r'fill="(?P<fill>[^"]+)"\s+opacity="(?P<opacity>[^"]+)">'
    r'\s*<text[^>]*>O</text>\s*<text[^>]*>ne</text>\s*</g>'
)


def outline_wordmark(svg: str) -> str:
    """Replace the <text> wordmark with its fixed outline.

    Fails loudly rather than passing the markup through: a master that no longer
    matches would otherwise ship a font-dependent icon again, which is exactly
    the regression this function exists to prevent.
    """
    match = WORDMARK_GROUP.search(svg)
    if match is None:
        sys.exit(
            "ERROR: could not find the <text> wordmark group to outline. "
            "The SVG masters changed shape; update WORDMARK_GROUP/WORDMARK_PATH "
            "together (see branding/manifest.json productionRule)."
        )
    if len(WORDMARK_GROUP.findall(svg)) != 1:
        sys.exit("ERROR: expected exactly one wordmark group per master")
    replacement = (
        '<path d="' + WORDMARK_PATH + '" '
        'fill="' + match.group("fill") + '" '
        'opacity="' + match.group("opacity") + '"/>'
    )
    return svg[: match.start()] + replacement + svg[match.end() :]


def staged_master(svg: Path, scratch: Path) -> Path:
    """An outlined copy of *svg*, written under *scratch*.

    The original is never modified; the manifest records its hash.
    """
    staged = scratch / svg.name
    staged.write_text(outline_wordmark(svg.read_text(encoding="utf-8")), encoding="utf-8")
    return staged


def _have_rsvg() -> bool:
    """True when librsvg's CLI is callable."""
    try:
        return subprocess.run(
            ["rsvg-convert", "--version"], capture_output=True
        ).returncode == 0
    except OSError:
        return False


def _have_resvg() -> bool:
    """True when the resvg wheel is importable."""
    try:
        import resvg_py  # noqa: F401
    except Exception:
        return False
    return True


def render_svg(svg: Path, size: int, dest: Path) -> None:
    """Rasterise an SVG at an exact pixel size.

    Two backends, both true vector rasterisers, because the artefacts must be
    regenerable on a developer machine and not only on a runner that happens to
    have librsvg installed. librsvg is preferred so output stays identical to
    what has been shipped so far; resvg is the fallback and is a pure-wheel
    install, which is what makes `npm run icons` work on Windows.

    Deliberately *not* a fallback: resampling a larger bitmap. Every caller here
    wants the vector rasterised at the target size, and silently substituting a
    downscale is the exact defect this module was fixed for.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    if _have_rsvg():
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
        return

    import resvg_py

    png = resvg_py.svg_to_bytes(
        svg_string=svg.read_text(encoding="utf-8"),
        width=size,
        height=size,
    )
    dest.write_bytes(bytes(png))


def require(path: Path, what: str) -> Path:
    if not path.exists():
        sys.exit(f"ERROR: missing {what}: {path}")
    return path


def main() -> None:
    if not _have_rsvg() and not _have_resvg():
        sys.exit(
            "ERROR: a vector rasteriser is required. Install librsvg "
            "(rsvg-convert) or `pip install resvg-py`."
        )

    for theme in THEMES:
        require(SVG_DIR / f"zephyr-one-{theme}.svg", f"{theme} SVG master")

    BUNDLE_OUT.mkdir(parents=True, exist_ok=True)
    RUNTIME_OUT.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as scratch:
        _generate(Path(scratch))


def _generate(scratch: Path) -> None:
    """Render every artefact from outlined copies of the masters."""
    staged = {
        theme: staged_master(SVG_DIR / f"zephyr-one-{theme}.svg", scratch)
        for theme in THEMES
    }

    # ── runtime set: one PNG per theme ──
    for theme in THEMES:
        dest = RUNTIME_OUT / f"zephyr-one-{theme}.png"
        render_svg(staged[theme], RUNTIME_SIZE, dest)
        print(f"runtime  {dest.relative_to(ROOT)}  {RUNTIME_SIZE}x{RUNTIME_SIZE}")

    # ── bundle set: rendered from the default theme ──
    default_svg = staged[DEFAULT_THEME]
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

        # Every .ico frame is rasterised from the vector at its own size,
        # never resampled from a larger bitmap.
        #
        # The previous version built the frames with
        # `src.resize((s, s), LANCZOS)` off the 256px master. Measured against a
        # native render of the same master: the 16px frame differed by 12.1% of
        # its pixels, 32px by 6.0%, 48px by 5.0% - and the committed frames were
        # a 0.00% match for the downscale, which is how the regression was
        # confirmed rather than guessed. Bitmap reduction throws away the stroke
        # geometry librsvg would have hinted at that size, so the small frames
        # Windows actually shows in the taskbar, Alt-Tab and Explorer's list
        # views arrived visibly soft. The bundle PNG loop above already
        # rasterises per size for exactly this reason; the .ico path simply did
        # not.
        #
        # The largest frame still has to be the base with the rest handed over
        # via append_images: PIL caps every requested size at the *base* image's
        # own dimensions (IcoImagePlugin._save: "if size[0] > width ...
        # continue"), so saving from the 16px frame silently discarded 32
        # through 256 and shipped a single-entry 16px .ico. Windows then
        # upscaled that one bitmap everywhere, which is the other half of the
        # blurry-icon report.
        ico_frames = []
        for size in ICO_SIZES:
            frame_path = scratch / f"ico-{size}.png"
            render_svg(default_svg, size, frame_path)
            with Image.open(frame_path) as frame_img:
                ico_frames.append(frame_img.convert("RGBA"))
        ico_frames.sort(key=lambda frame: frame.width, reverse=True)
        ico_frames[0].save(
            BUNDLE_OUT / "icon.ico",
            format="ICO",
            sizes=[(i.width, i.height) for i in ico_frames],
            append_images=ico_frames[1:],
        )
        print(f"bundle   {(BUNDLE_OUT / 'icon.ico').relative_to(ROOT)}  {ICO_SIZES}")

        # .icns likewise: hand PIL a native render per size rather than letting
        # it thumbnail one bitmap down the whole Retina ladder.
        icns_frames = []
        for size in ICNS_SIZES:
            frame_path = scratch / f"icns-{size}.png"
            render_svg(default_svg, size, frame_path)
            with Image.open(frame_path) as frame_img:
                icns_frames.append(frame_img.convert("RGBA"))
        icns_frames.sort(key=lambda frame: frame.width, reverse=True)
        icns_frames[0].save(
            BUNDLE_OUT / "icon.icns",
            format="ICNS",
            sizes=[(i.width, i.height) for i in icns_frames],
            append_images=icns_frames[1:],
        )
        print(f"bundle   {(BUNDLE_OUT / 'icon.icns').relative_to(ROOT)}  {ICNS_SIZES}")

    master.unlink(missing_ok=True)
    print(f"\nicons ready: bundle={BUNDLE_OUT.relative_to(ROOT)} runtime={RUNTIME_OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
