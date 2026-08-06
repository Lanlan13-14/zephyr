#!/usr/bin/env python3
"""Stamp Zephyr One package version from a release tag.

Examples:
  one-v0.1.7  →  0.1.7
  v0.2.0      →  0.2.0
  0.1.8       →  0.1.8

Updates (in-place, under zephyr_one/):
  - package.json              "version"
  - src-tauri/Cargo.toml      version =
  - src-tauri/tauri.conf.json "version"

Also writes GITHUB_ENV keys when present:
  ZEPHYR_ONE_VERSION_NAME, ZEPHYR_ONE_VERSION_CODE
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

SEMVER_RE = re.compile(r"(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)")
ROOT = Path(__file__).resolve().parent.parent


def parse_version(raw: str | None) -> str:
    value = (raw or os.environ.get("ZEPHYR_ONE_VERSION") or "").strip()
    if not value:
        # fall back to current tauri.conf.json
        conf = ROOT / "src-tauri" / "tauri.conf.json"
        if conf.exists():
            try:
                value = json.loads(conf.read_text(encoding="utf-8")).get("version") or ""
            except Exception:
                value = ""
    match = SEMVER_RE.search(value)
    if not match:
        raise SystemExit(f"Cannot derive semantic version from: {value!r}")
    return match.group(1).split("+", 1)[0]


def version_code(version: str, fallback: str | None = None) -> str:
    """Android-style integer versionCode: major*10000 + minor*100 + patch.

    Prefer the semver-derived code so one-v0.1.8 → 108 (not GITHUB_RUN_NUMBER,
    which is unrelated to the product version). Explicit ZEPHYR_ONE_VERSION_CODE
    still wins when set intentionally.
    """
    nums = [int(x) for x in re.findall(r"\d+", version)[:3]]
    while len(nums) < 3:
        nums.append(0)
    major, minor, patch = nums[:3]
    derived = major * 10000 + minor * 100 + patch
    if fallback and str(fallback).strip().isdigit():
        # Only honor explicit override when it is not a bare CI run number that
        # would shrink the code (e.g. run 27 < 108). Larger explicit values OK.
        fb = int(str(fallback).strip())
        if fb >= derived:
            return str(fb)
    return str(derived)


def patch_package_json(version: str) -> None:
    path = ROOT / "package.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["version"] = version
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def patch_tauri_conf(version: str) -> None:
    path = ROOT / "src-tauri" / "tauri.conf.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["version"] = version
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def patch_cargo_toml(version: str) -> None:
    path = ROOT / "src-tauri" / "Cargo.toml"
    text = path.read_text(encoding="utf-8")
    new, n = re.subn(
        r'(?m)^version\s*=\s*"[^"]*"',
        f'version = "{version}"',
        text,
        count=1,
    )
    if n != 1:
        raise SystemExit(f"Failed to patch version in {path}")
    path.write_text(new, encoding="utf-8")


def main() -> None:
    raw = sys.argv[1] if len(sys.argv) > 1 else None
    version = parse_version(raw)
    # Prefer explicit ZEPHYR_ONE_VERSION_CODE only — never GITHUB_RUN_NUMBER
    # (run id is not a product version; one-v0.1.8 must become 108, not 27).
    code = version_code(version, os.environ.get("ZEPHYR_ONE_VERSION_CODE"))
    patch_package_json(version)
    patch_tauri_conf(version)
    patch_cargo_toml(version)

    env_file = os.environ.get("GITHUB_ENV")
    if env_file:
        with open(env_file, "a", encoding="utf-8") as f:
            f.write(f"ZEPHYR_ONE_VERSION_NAME={version}\n")
            f.write(f"ZEPHYR_ONE_VERSION_CODE={code}\n")

    print(f"ZEPHYR_ONE_VERSION_NAME={version}")
    print(f"ZEPHYR_ONE_VERSION_CODE={code}")
    print(f"stamped package.json / Cargo.toml / tauri.conf.json → {version}")


if __name__ == "__main__":
    main()
