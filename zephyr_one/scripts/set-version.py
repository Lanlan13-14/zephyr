#!/usr/bin/env python3
"""Stamp Zephyr One package version from a release tag.

Examples:
  one-v0.1.7  →  0.1.7
  v0.2.0      →  0.2.0
  0.1.8       →  0.1.8

Updates (in-place, under zephyr_one/):
  - package.json              "version"

Also writes GITHUB_ENV keys when present:
  ZEPHYR_ONE_VERSION_NAME, ZEPHYR_ONE_VERSION_CODE,
  ZEPHYR_ONE_FULL_VERSION, ZEPHYR_ONE_PRERELEASE

The desktop release flow appends the pre label OUTSIDE this script
(workflow_dispatch inputs tag + prerelease_label), so the raw tag arriving
here is already the full one-v0.1.20pre15. package.json keeps the marketing
version only (0.1.20, installer-safe); the full display build travels on
ZEPHYR_ONE_FULL_VERSION and the suffix alone on ZEPHYR_ONE_PRERELEASE.
"""
from __future__ import annotations

import json
import os
import re
import stat
import sys
import tempfile
from pathlib import Path

SEMVER_RE = re.compile(r"(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)")
ROOT = Path(__file__).resolve().parent.parent


def parse_version(raw: str | None) -> str:
    value = (raw or os.environ.get("ZEPHYR_ONE_VERSION") or "").strip()
    if not value:
        conf = ROOT / "package.json"
        if conf.exists():
            try:
                value = json.loads(conf.read_text(encoding="utf-8")).get("version") or ""
            except Exception:
                value = ""
    match = SEMVER_RE.search(value)
    if not match:
        raise SystemExit(f"Cannot derive semantic version from: {value!r}")
    return match.group(1).split("+", 1)[0]


def split_prerelease(raw: str | None) -> str:
    """Recover the `preN` suffix from the raw release tag ('' when stable).

    Matches the desktop release convention one-v0.1.20pre15 -> pre15.
    parse_version() intentionally strips it for the marketing version; this
    keeps it on a separate channel so About can show it without changing
    package.json shape.
    """
    text = (raw or os.environ.get("ZEPHYR_ONE_VERSION") or "").strip()
    match = re.search(r"(pre\d+)\s*$", text, re.IGNORECASE)
    return match.group(1).lower() if match else ""


def full_display_version(version: str, prerelease: str) -> str:
    """Marketing version plus pre suffix for display (0.1.20 + pre15)."""
    if prerelease and not version.lower().endswith(prerelease.lower()):
        return f"{version}{prerelease}"
    return version


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


def atomic_write_text(path: Path, text: str) -> None:
    """Replace *path* atomically with UTF-8 text.

    Plain Path.write_text opens the destination with O_TRUNC before writing. The
    One test suite runs files in parallel, and set-version.test used to stamp the
    real project package.json; another Node process importing a local ESM module
    could observe that zero/half-written window and fail with
    ERR_INVALID_PACKAGE_CONFIG. A tight-reader probe observed 169 invalid reads
    during 117 real set-version runs.

    The temporary file must live in the same directory so os.replace is atomic
    on POSIX and Windows (no cross-filesystem rename). Flush + fsync prevents the
    renamed file from referring only to userspace buffers if the runner dies.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        if path.exists():
            os.chmod(tmp, stat.S_IMODE(path.stat().st_mode))
        os.replace(tmp, path)
    finally:
        # os.replace removes tmp on success; clean it only on failure.
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def patch_package_json(version: str, prerelease: str = "") -> None:
    path = ROOT / "package.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["version"] = version
    atomic_write_text(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    # Shell-side display slot. package.json keeps the marketing version only;
    # the full display build (marketing + pre) lives in
    # src/js/shell/version.js as APP_VERSION + APP_PRERELEASE, stamped here
    # so CI is the single source of truth.
    shell_version = ROOT / "src" / "js" / "shell" / "version.js"
    if shell_version.exists():
        text = shell_version.read_text(encoding="utf-8")
        text = re.sub(
            r"export const APP_VERSION = '[^']*';",
            f"export const APP_VERSION = '{version}';",
            text,
            count=1,
        )
        if "export const APP_PRERELEASE" in text:
            text = re.sub(
                r"export const APP_PRERELEASE = '[^']*';",
                f"export const APP_PRERELEASE = '{prerelease}';",
                text,
                count=1,
            )
        atomic_write_text(shell_version, text)


def main() -> None:
    raw = sys.argv[1] if len(sys.argv) > 1 else None
    version = parse_version(raw)
    prerelease = split_prerelease(raw)
    full = full_display_version(version, prerelease)
    # Prefer explicit ZEPHYR_ONE_VERSION_CODE only — never GITHUB_RUN_NUMBER
    # (run id is not a product version; one-v0.1.8 must become 108, not 27).
    code = version_code(version, os.environ.get("ZEPHYR_ONE_VERSION_CODE"))
    patch_package_json(version, prerelease)

    env_file = os.environ.get("GITHUB_ENV")
    if env_file:
        with open(env_file, "a", encoding="utf-8") as f:
            f.write(f"ZEPHYR_ONE_VERSION_NAME={version}\n")
            f.write(f"ZEPHYR_ONE_VERSION_CODE={code}\n")
            f.write(f"ZEPHYR_ONE_FULL_VERSION={full}\n")
            f.write(f"ZEPHYR_ONE_PRERELEASE={prerelease}\n")

    # ASCII only: Windows runners default to cp1252 and choke on arrows/CJK.
    print(f"ZEPHYR_ONE_VERSION_NAME={version}")
    print(f"ZEPHYR_ONE_VERSION_CODE={code}")
    print(f"ZEPHYR_ONE_FULL_VERSION={full}")
    print(f"ZEPHYR_ONE_PRERELEASE={prerelease}")
    print(f"stamped package.json -> {version}")


if __name__ == "__main__":
    main()
