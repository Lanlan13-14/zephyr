#!/usr/bin/env python3
"""Behaviour replica of AndroidRdpEngine.connect / trustCertificate.

Mirrors the Kotlin control flow closely enough that deleting the password
copy, auto-ignoring an unknown cert, or retrying a changed fingerprint
makes this file fail. No FreeRDP / Gradle required.
"""
from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
ENGINE = (
    ROOT
    / "android/protocol-rdp/src/main/kotlin/one/zephyr/mobile/protocol/rdp/AndroidRdpEngine.kt"
)


def normalize(raw: str | None) -> str:
    if not raw:
        return ""
    value = raw.strip()
    algo = value.split(":", 1)[0]
    if algo.lower() in {"sha256", "sha1"} and ":" in value:
        value = value.split(":", 1)[1]
    hex_chars: list[str] = []
    for ch in value:
        if ch in " \t:-":
            continue
        if ch in "0123456789abcdefABCDEF":
            hex_chars.append(ch.upper())
        else:
            return ""
    if not hex_chars or len(hex_chars) % 2:
        return ""
    return ":".join("".join(hex_chars[i : i + 2]) for i in range(0, len(hex_chars), 2))


class FakeNative:
    def __init__(self, mode: str, fingerprint: str | None = None, create_ok: bool = True):
        self.mode = mode
        self.fingerprint = fingerprint
        self.create_ok = create_ok
        self.create_calls = 0
        self.passwords: list[str] = []
        self.ignore_flags: list[bool] = []

    def open(self, password: list[str], ignore: bool) -> tuple[str, str | None]:
        self.create_calls += 1
        self.passwords.append("".join(password))
        self.ignore_flags.append(ignore)
        password[:] = ["\0"] * len(password)
        if not self.create_ok:
            return "create_failed", None
        if self.mode == "accept":
            return "connected", None
        if self.mode == "reject":
            return "connect_failed", self.fingerprint
        if self.mode == "reject_then_accept":
            if ignore:
                return "connected", self.fingerprint
            return "connect_failed", self.fingerprint
        raise AssertionError(self.mode)


def connect(native: FakeNative, stored: str | None, password: str) -> dict:
    source = list(password)
    first_copy = source.copy()
    first_status, presented = native.open(first_copy, False)
    presented_n = normalize(presented)
    if first_status == "connected":
        source[:] = ["\0"] * len(source)
        return {"status": "connected", "presented": presented_n}
    if first_status == "create_failed":
        source[:] = ["\0"] * len(source)
        return {"status": "create_failed", "presented": presented_n}
    if presented_n:
        if stored and stored == presented_n:
            second_copy = source.copy()
            second_status, _ = native.open(second_copy, True)
            source[:] = ["\0"] * len(source)
            return {"status": second_status if second_status == "connected" else "retry_failed"}
        source[:] = ["\0"] * len(source)
        return {
            "status": "review_changed" if stored else "review_first",
            "presented": presented_n,
            "previous": stored,
        }
    source[:] = ["\0"] * len(source)
    return {"status": "connect_failed", "presented": ""}


def must_engine() -> None:
    text = ENGINE.read_text(encoding="utf-8")
    for needle in (
        "request.password?.copyOf()",
        "stored != null && stored == presented",
        "ignoreCertificate = ignoreCertificate",
        "CertificateReview",
        "SESSION_CREATE_FAILED",
    ):
        if needle not in text:
            raise AssertionError(f"engine missing {needle!r}")
    compact = "".join(text.split())
    if "ignoreCertificate=true," in compact:
        raise AssertionError("NativeRdpConfig hardcodes ignoreCertificate=true")
    if "ignoreCertificate=ignoreCertificate" not in compact:
        raise AssertionError("NativeRdpConfig must take the per-attempt flag")
    if "openNative(request,ignoreCertificate=false)" not in compact:
        raise AssertionError("first create must verify the certificate")
    if "openNative(request,ignoreCertificate=true)" not in compact:
        raise AssertionError("stored-fingerprint retry must set ignoreCertificate=true")


def main() -> int:
    must_engine()

    native = FakeNative("accept")
    got = connect(native, None, "secret")
    assert got["status"] == "connected", got
    assert native.create_calls == 1
    assert native.passwords == ["secret"]

    native = FakeNative("accept", create_ok=False)
    got = connect(native, None, "secret")
    assert got["status"] == "create_failed", got
    assert native.create_calls == 1

    native = FakeNative("reject", fingerprint="sha256:aabbccdd")
    got = connect(native, None, "secret")
    assert got == {"status": "review_first", "presented": "AA:BB:CC:DD", "previous": None}, got
    assert native.create_calls == 1
    assert native.ignore_flags == [False]

    native = FakeNative("reject_then_accept", fingerprint="aa:bb:cc:dd")
    got = connect(native, "AA:BB:CC:DD", "secret")
    assert got["status"] == "connected", got
    assert native.create_calls == 2
    assert native.passwords == ["secret", "secret"]
    assert native.ignore_flags == [False, True]

    native = FakeNative("reject", fingerprint="sha256:ddeeff00")
    got = connect(native, "AA:BB:CC:DD", "secret")
    assert got["status"] == "review_changed", got
    assert got["presented"] == "DD:EE:FF:00"
    assert native.create_calls == 1
    assert native.ignore_flags == [False]

    print("rdp-android-engine-replica: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
