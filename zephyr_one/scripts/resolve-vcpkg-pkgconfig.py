#!/usr/bin/env python3
"""Resolve the vcpkg static FreeRDP pkg-config environment for a packaged build.

Why this exists as a script instead of inline shell in the workflow:

  * lukka/run-vcpkg does NOT export VCPKG_INSTALLED_DIR to later steps. It only
    exports VCPKG_ROOT / VCPKG_DEFAULT_TRIPLET / VCPKG_BINARY_SOURCES. Its
    install command uses `$[env.VCPKG_INSTALLED_DIR]`, and it fills that in via
    setEnvVarIfUndefined -> only when the variable is not already set. So the
    workflow pins VCPKG_INSTALLED_DIR at job level and both the action and this
    script agree on one path.

  * The exact on-disk layout of the vcpkg `pkgconf` host tool is not something
    to hardcode from memory. Guessing it wrongly fails every desktop build in
    the same step with a bare exit code. So this script SEARCHES for pkgconf and
    prints a directory listing when it cannot find it, turning a silent failure
    into an actionable one.

Emits to $GITHUB_ENV (or stdout when run outside Actions):
    PKG_CONFIG            absolute path to a pkgconf/pkg-config binary
    PKG_CONFIG_PATH       directory holding freerdp3.pc / winpr3.pc
    PKG_CONFIG_ALL_STATIC 1
    ZEPHYR_ONE_RDP_STATIC 1   (build.rs uses this to force .statik(true))
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# The .pc files the C shim and Rust helper actually need. freerdp-client3 is the
# one that carries the client-side channel addins (rdpdr/drive, rdpsnd, cliprdr).
REQUIRED_PC = ("freerdp3.pc", "freerdp-client3.pc", "winpr3.pc")


def fail(message: str, *, listing: Path | None = None) -> "NoReturn":  # type: ignore[name-defined]
    print(f"error: {message}", file=sys.stderr)
    if listing is not None and listing.is_dir():
        print(f"--- contents of {listing} ---", file=sys.stderr)
        for entry in sorted(listing.rglob("*"))[:200]:
            print(f"  {entry.relative_to(listing)}", file=sys.stderr)
    sys.exit(1)


def find_pkgconfig_dir(installed: Path, triplet: str) -> Path:
    """Locate the target triplet's pkgconfig directory containing FreeRDP."""
    preferred = installed / triplet / "lib" / "pkgconfig"
    candidates = [preferred]
    # Release-only layouts and some ports place .pc files under share/pkgconfig.
    candidates.append(installed / triplet / "share" / "pkgconfig")

    for candidate in candidates:
        if candidate.is_dir() and (candidate / REQUIRED_PC[0]).is_file():
            return candidate

    # Fall back to a real search so a layout change reports the truth rather
    # than a wrong hardcoded path.
    for found in (installed / triplet).rglob(REQUIRED_PC[0]):
        return found.parent

    fail(
        f"could not find {REQUIRED_PC[0]} under {installed / triplet}",
        listing=installed / triplet,
    )


def find_pkgconf(installed: Path, triplet: str) -> Path:
    """Locate a pkgconf binary. vcpkg installs it under the HOST triplet."""
    exe = ".exe" if os.name == "nt" else ""
    names = (f"pkgconf{exe}", f"pkg-config{exe}")

    # Search the whole installed root: the host triplet differs from the target
    # triplet on Windows (x64-windows vs x64-windows-static-md), and hardcoding
    # either one is exactly the guess that breaks the build.
    for name in names:
        for found in installed.rglob(name):
            if found.is_file():
                return found

    # A system pkg-config is an acceptable fallback on Linux/macOS.
    for name in names:
        for directory in os.environ.get("PATH", "").split(os.pathsep):
            if not directory:
                continue
            candidate = Path(directory) / name
            if candidate.is_file():
                return candidate

    fail(f"no pkgconf/pkg-config found under {installed} or on PATH", listing=installed)


def main() -> int:
    installed_raw = os.environ.get("VCPKG_INSTALLED_DIR")
    if not installed_raw:
        fail("VCPKG_INSTALLED_DIR is not set; pin it at job level in the workflow")
    triplet = os.environ.get("VCPKG_DEFAULT_TRIPLET")
    if not triplet:
        fail("VCPKG_DEFAULT_TRIPLET is not set")

    installed = Path(installed_raw)
    if not installed.is_dir():
        fail(f"VCPKG_INSTALLED_DIR does not exist: {installed}")

    pc_dir = find_pkgconfig_dir(installed, triplet)

    missing = [name for name in REQUIRED_PC if not (pc_dir / name).is_file()]
    if missing:
        fail(f"missing pkg-config files in {pc_dir}: {', '.join(missing)}", listing=pc_dir)

    pkgconf = find_pkgconf(installed, triplet)

    # Forward slashes keep the value usable from both bash and pwsh on Windows.
    values = {
        "PKG_CONFIG": str(pkgconf).replace("\\", "/"),
        "PKG_CONFIG_PATH": str(pc_dir).replace("\\", "/"),
        "PKG_CONFIG_ALL_STATIC": "1",
        "ZEPHYR_ONE_RDP_STATIC": "1",
    }

    github_env = os.environ.get("GITHUB_ENV")
    if github_env:
        with open(github_env, "a", encoding="utf-8") as handle:
            for key, value in values.items():
                handle.write(f"{key}={value}\n")

    for key, value in values.items():
        print(f"{key}={value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
