#!/usr/bin/env python3
"""Replica of the Kotlin JUnit suites. Fails if the motion/copy math drifts."""

from __future__ import annotations

import math
import sys


class Detent:
    PEEK = 0.30
    HALF = 0.55
    EXPANDED = 0.92
    ALL = ("PEEK", "HALF", "EXPANDED")
    FRAC = {"PEEK": PEEK, "HALF": HALF, "EXPANDED": EXPANDED}


FLICK_V = 0.9
FLICK_Y = 40.0
PROJ = 140.0
PEEK_FLOOR = 0.70
PAD_BP = 768.0
PAD_MAX = 420.0
PAD_FRAC = 0.42
PHONE = 800.0


def height(name: str, container: float) -> float:
    return float(round(container * Detent.FRAC[name]))


def clamp(h: float, container: float) -> float:
    lo = height("PEEK", container) * PEEK_FLOOR
    hi = height("EXPANDED", container)
    return min(max(h, lo), hi)


def nearest(current: float, container: float) -> str:
    best, best_d = "PEEK", float("inf")
    for name in Detent.ALL:
        d = abs(height(name, container) - current)
        if d < best_d:
            best, best_d = name, d
    return best


def settle(current: float, container: float, vel: float, dy: float, layout: str):
    if layout == "PAD":
        return "HALF"
    if vel > FLICK_V and dy > FLICK_Y:
        return None
    projected = current - vel * PROJ
    return nearest(projected, container)


def back(detent, picker=False):
    if picker:
        return detent, False
    nxt = {"EXPANDED": "HALF", "HALF": "PEEK", "PEEK": None, None: None}[detent]
    return nxt, False


def next_opt(value, options):
    i = options.index(value) if value in options else 0
    start = 0 if i < 0 else i + 1
    return options[start % len(options)]


def settings_sub(enabled, model, collab):
    if not enabled:
        return "已停用 · 导航与工作区不再显示 AI"
    mode = collab if collab.endswith("模式") else collab + "模式"
    return f"已启用 · {model} · {mode}"


def context(protocol, name, page):
    live = bool(protocol) and bool(name)
    return f"{protocol} · {name}" if live else (page or "当前页")


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def main():
    check(height("PEEK", PHONE) == 240, "peek height")
    check(height("HALF", PHONE) == 440, "half height")
    check(height("EXPANDED", PHONE) == 736, "expanded height")

    current = height("HALF", PHONE) - 50
    check(nearest(current, PHONE) == "HALF", "nearest still half")
    check(settle(current, PHONE, 1.2, 50, "PHONE") is None, "flick closes")
    check(settle(current, PHONE, 0.2, 50, "PHONE") == "HALF", "slow drag stays")
    check(settle(height("HALF", PHONE), PHONE, 1.4, 10, "PHONE") == "PEEK", "fast no travel projects")
    check(nearest(500, PHONE) == "HALF", "500 nearer half")
    check(settle(500, PHONE, -2, -80, "PHONE") == "EXPANDED", "up projects expanded")
    check(settle(360, PHONE, 0.6, 30, "PHONE") == "PEEK", "down projects peek")
    check(settle(200, PHONE, 2, 80, "PAD") == "HALF", "pad ignores flick")
    check(clamp(10, PHONE) == 168, "min drag")
    check(clamp(900, PHONE) == 736, "max drag")
    check(min(PAD_MAX, 2000 * PAD_FRAC) == 420, "pad cap")
    check(abs(min(PAD_MAX, 768 * PAD_FRAC) - 322.56) < 0.01, "pad 768")

    d, p = back("EXPANDED")
    check(d == "HALF" and p is False, "back expanded")
    d, p = back("HALF")
    check(d == "PEEK", "back half")
    d, p = back("PEEK")
    check(d is None, "back peek")
    d, p = back("HALF", picker=True)
    check(d == "HALF" and p is False, "picker first")

    models = ["Claude Opus", "Claude Sonnet", "GPT-5", "Gemini 3 Pro"]
    check(next_opt("Claude Opus", models) == "Claude Sonnet", "cycle model")
    walking = "Claude Opus"
    for _ in models:
        walking = next_opt(walking, models)
    check(walking == "Claude Opus", "wrap models")
    check(settings_sub(True, "Claude Opus", "协作") == "已启用 · Claude Opus · 协作模式", "sub on")
    check(settings_sub(False, "Claude Opus", "协作") == "已停用 · 导航与工作区不再显示 AI", "sub off")
    check(context("SSH", "edge-01", "首页") == "SSH · edge-01", "live ctx")
    check(context(None, None, "工具") == "工具", "page ctx")
    check("prod-web-01" not in context(None, None, "工具"), "no demo host")

    print("ai-workspace-junit-replica: all cases passed")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except AssertionError as exc:
        print("FAIL:", exc, file=sys.stderr)
        sys.exit(1)
