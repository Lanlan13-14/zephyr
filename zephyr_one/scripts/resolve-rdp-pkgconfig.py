#!/usr/bin/env python3
"""Resolve the pkg-config environment for the vendored static FreeRDP.

FreeRDP itself is no longer taken from vcpkg. vcpkg's freerdp port produces a
broken static set -- measured on both Linux and Windows CI, libfreerdp3 and
libwinpr3 came out byte-identical (size=1745350 members=257 syms=440 each) and
gdi_free / freerdp_client_load_addins / PubSub_Subscribe were defined in NO
archive. That is what produced 20 undefined symbols for four consecutive rounds.
So FreeRDP is built from a pinned tag by scripts/../native/freerdp-core/
scripts/build-freerdp.sh, and this script points pkg-config at that install.

vcpkg is still used, but only for FreeRDP's own third-party dependencies on the
platforms that have no system copy:

    Windows / macOS : openssl, zlib, cjson come from vcpkg (Apple removed the
                      system OpenSSL; Windows never had one). Their archives
                      live outside any system root, so build.rs links them
                      statically and the helper ships self-contained.
    Linux           : the distro provides them. They are deliberately NOT
                      vendored: statically linking the distro's OpenSSL would
                      mean every OpenSSL CVE requires a Zephyr One release
                      instead of an apt upgrade, which is a security regression
                      for a client that speaks TLS/NLA.

Emits to $GITHUB_ENV (or stdout when run outside Actions):
    PKG_CONFIG            absolute path to a pkgconf/pkg-config binary
    PKG_CONFIG_PATH       vendored FreeRDP pkgconfig dir, then vcpkg's
    PKG_CONFIG_ALL_STATIC 1
    ZEPHYR_ONE_RDP_STATIC 1   (build.rs uses this to force .statik(true))
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# The .pc files the C shim and Rust helper actually need. freerdp-client3 is the
# one carrying the client-side channel addins (rdpdr/drive, rdpsnd, cliprdr).
REQUIRED_PC = ("freerdp3.pc", "freerdp-client3.pc", "winpr3.pc")


def fail(message, listing=None):
    print(f"error: {message}", file=sys.stderr)
    if listing is not None and Path(listing).is_dir():
        print(f"--- contents of {listing} ---", file=sys.stderr)
        for entry in sorted(Path(listing).rglob("*"))[:200]:
            print(f"  {entry.relative_to(listing)}", file=sys.stderr)
    sys.exit(1)


def freerdp_pc_dir():
    """Locate the vendored FreeRDP install's pkgconfig directory.

    The layout is fixed by build-freerdp.sh ($PREFIX/install), but the .pc files
    land under lib/ or lib64/ depending on the platform's CMake GNUInstallDirs
    default, so both are checked before falling back to a real search.
    """
    here = Path(__file__).resolve().parent
    crate = here.parent / "native" / "freerdp-core"
    prefix = Path(os.environ.get("ZEPHYR_FREERDP_PREFIX") or (crate / ".freerdp-dist"))
    install = prefix / "install"

    if not install.is_dir():
        fail(
            f"vendored FreeRDP install not found at {install}; "
            "run native/freerdp-core/scripts/build-freerdp.sh first",
            listing=prefix if prefix.is_dir() else None,
        )

    for sub in ("lib/pkgconfig", "lib64/pkgconfig", "share/pkgconfig"):
        candidate = install / sub
        if candidate.is_dir() and (candidate / REQUIRED_PC[0]).is_file():
            return candidate

    for found in install.rglob(REQUIRED_PC[0]):
        return found.parent

    fail(f"could not find {REQUIRED_PC[0]} under {install}", listing=install)


def vcpkg_pc_dir():
    """Locate vcpkg's pkgconfig dir for OpenSSL/zlib/cJSON. Optional."""
    installed_raw = os.environ.get("VCPKG_INSTALLED_DIR")
    triplet = os.environ.get("VCPKG_DEFAULT_TRIPLET")
    if not installed_raw or not triplet:
        return None
    installed = Path(installed_raw)
    if not installed.is_dir():
        return None
    for sub in ("lib/pkgconfig", "share/pkgconfig"):
        candidate = installed / triplet / sub
        if candidate.is_dir():
            return candidate
    return None


def find_pkgconf():
    """Locate a pkgconf binary: vcpkg's host tool first, then PATH."""
    exe = ".exe" if os.name == "nt" else ""
    names = (f"pkgconf{exe}", f"pkg-config{exe}")

    installed_raw = os.environ.get("VCPKG_INSTALLED_DIR")
    if installed_raw and Path(installed_raw).is_dir():
        # Search the whole installed root: the host triplet differs from the
        # target triplet on Windows (x64-windows vs x64-windows-static-md), and
        # hardcoding either one is exactly the guess that breaks the build.
        for name in names:
            for found in Path(installed_raw).rglob(name):
                if found.is_file():
                    return found

    for name in names:
        for directory in os.environ.get("PATH", "").split(os.pathsep):
            if not directory:
                continue
            candidate = Path(directory) / name
            if candidate.is_file():
                return candidate

    fail("no pkgconf/pkg-config found in the vcpkg tree or on PATH")


def main():
    pc_dir = freerdp_pc_dir()

    missing = [name for name in REQUIRED_PC if not (pc_dir / name).is_file()]
    if missing:
        fail(f"missing pkg-config files in {pc_dir}: {', '.join(missing)}", listing=pc_dir)

    parts = [str(pc_dir).replace("\\", "/")]
    vcpkg_dir = vcpkg_pc_dir()
    if vcpkg_dir is not None:
        # After the vendored dir: FreeRDP's own .pc files must win, and vcpkg
        # only needs to satisfy Requires.private (libssl, zlib, libcjson).
        parts.append(str(vcpkg_dir).replace("\\", "/"))

    # Preserve any pre-existing search path (the distro's own dir on Linux),
    # otherwise libssl/zlib/libcjson cannot be resolved there at all.
    existing = os.environ.get("PKG_CONFIG_PATH", "")
    if existing:
        parts.extend(p for p in existing.split(os.pathsep) if p)

    pkgconf = find_pkgconf()

    values = {
        "PKG_CONFIG": str(pkgconf).replace("\\", "/"),
        "PKG_CONFIG_PATH": os.pathsep.join(parts),
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
