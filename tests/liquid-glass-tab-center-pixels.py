#!/usr/bin/env python3
"""Pixel-level: canvas text ink centroid vs equal-width indicator.

Mirrors rasterizeText (textAlign=center, fillText at cssW/2) and the
indicator translation x = glassX + index * tabW.

Fails if 笔记 (or any label) ink center drifts from the pill center.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = Path("/var/minis/workspace/tab-center-proof.png")
LABELS = ["仪表盘", "活动", "终端", "远程执行", "笔记", "设置"]
FONT_CANDIDATES = [
    "/usr/share/fonts/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto/NotoSansSC-Regular.otf",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/system/fonts/NotoSansCJK-Regular.ttc",
    "/system/fonts/NotoSansSC-Regular.otf",
    "/usr/share/fonts/TTF/NotoSansCJK-Regular.ttc",
]


def find_font() -> ImageFont.FreeTypeFont:
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, 13)
            except OSError:
                continue
    # last resort: scan
    for root in ("/usr/share/fonts", "/system/fonts"):
        if not os.path.isdir(root):
            continue
        for dirpath, _, files in os.walk(root):
            for f in files:
                low = f.lower()
                if not (low.endswith(".ttc") or low.endswith(".otf") or low.endswith(".ttf")):
                    continue
                if "cjk" in low or "sc" in low or "noto" in low or "droid" in low:
                    path = os.path.join(dirpath, f)
                    try:
                        return ImageFont.truetype(path, 13)
                    except OSError:
                        continue
    raise SystemExit("no CJK font found — cannot run pixel test")


def ink_centroid_x(img: Image.Image, box: tuple[int, int, int, int]) -> float:
    x0, y0, x1, y1 = box
    arr = np.asarray(img.crop((x0, y0, x1, y1)).convert("L"))
    # text is dark on white; ink = pixels darker than 240
    mask = arr < 240
    if not mask.any():
        raise AssertionError(f"no ink in box {box}")
    ys, xs = np.nonzero(mask)
    return x0 + float(xs.mean())


def draw_scene(font: ImageFont.FreeTypeFont, equal: bool) -> tuple[Image.Image, list[float], list[float]]:
    """Return image, list of ink centers, list of pill centers."""
    pad_x = 14
    # natural widths = text + horizontal padding*2
    naturals = []
    scratch = Image.new("L", (400, 40), 255)
    d0 = ImageDraw.Draw(scratch)
    for label in LABELS:
        bbox = d0.textbbox((0, 0), label, font=font)
        naturals.append((bbox[2] - bbox[0]) + pad_x * 2)

    n = len(LABELS)
    if equal:
        tab_w = float(max(naturals))
        widths = [tab_w] * n
    else:
        widths = [float(w) for w in naturals]
        tab_w = widths[0]

    glass_x = 20.0
    glass_y = 16.0
    glass_h = 32.0
    scale = 3  # supersample
    total_w = int((glass_x * 2 + sum(widths)) * scale)
    total_h = int((glass_y * 2 + glass_h) * scale)
    img = Image.new("RGB", (total_w, total_h), (245, 245, 247))
    draw = ImageDraw.Draw(img)

    # container
    cont = [
        int(glass_x * scale) - 4 * scale,
        int(glass_y * scale) - 4 * scale,
        int((glass_x + sum(widths)) * scale) + 4 * scale,
        int((glass_y + glass_h) * scale) + 4 * scale,
    ]
    draw.rounded_rectangle(cont, radius=int(20 * scale), fill=(232, 232, 236))

    ink_cs = []
    pill_cs = []
    x = glass_x
    font_hi = ImageFont.truetype(font.path, 13 * scale)
    notes = LABELS.index("笔记")
    for i, label in enumerate(LABELS):
        w = widths[i]
        cell = [x, glass_y, x + w, glass_y + glass_h]
        pill_x = glass_x + i * tab_w  # renderer: fraction * dragWidth
        pill = [pill_x, glass_y, pill_x + tab_w, glass_y + glass_h]
        if i == notes:
            draw.rounded_rectangle(
                [int(v * scale) for v in pill],
                radius=int(glass_h / 2 * scale),
                fill=(210, 214, 220),
            )
        cx = (cell[0] + cell[2]) / 2
        cy = (cell[1] + cell[3]) / 2
        # rasterizeText: fillText(content, cssW/2, cssH/2)
        draw.text(
            (cx * scale, cy * scale),
            label,
            font=font_hi,
            fill=(20, 20, 22) if i != notes else (10, 132, 255),
            anchor="mm",
        )
        box = (
            int(cell[0] * scale),
            int(cell[1] * scale),
            int(cell[2] * scale),
            int(cell[3] * scale),
        )
        ink_cs.append(ink_centroid_x(img, box) / scale)
        pill_cs.append((pill[0] + pill[2]) / 2)
        x += w
    return img, ink_cs, pill_cs


def main() -> int:
    font = find_font()
    unequal, ink_u, pill_u = draw_scene(font, equal=False)
    notes = LABELS.index("笔记")
    dx_bug = pill_u[notes] - ink_u[notes]
    print(f"unequal 笔记 pill-ink dx = {dx_bug:.3f}px")
    if dx_bug <= 4:
        print("FAIL: expected the old first-tab-width bug to shift 笔记 left of the pill")
        return 1

    equal, ink_e, pill_e = draw_scene(font, equal=True)
    equal.save(OUT)
    failed = 0
    for i, label in enumerate(LABELS):
        dx = pill_e[i] - ink_e[i]
        print(f"equal {label:8s} ink={ink_e[i]:7.3f} pill={pill_e[i]:7.3f} dx={dx:+.3f}")
        if abs(dx) > 0.75:
            print(f"FAIL: {label} ink not centered in pill (dx={dx:.3f} > 0.75px)")
            failed += 1
    if failed:
        return 1
    print(f"wrote {OUT}")
    print("pixel center test passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
