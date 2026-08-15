#!/usr/bin/env python3
"""Replica of Android RDP create/HOME/certificate decisions.

Fails if the production sources lose the HOME install or start auto-accepting
an unknown / changed fingerprint. Independent of Gradle.
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
ENGINE = ROOT / "android/protocol-rdp/src/main/kotlin/one/zephyr/mobile/protocol/rdp/AndroidRdpEngine.kt"
RUNTIME = ROOT / "android/protocol-rdp/src/main/kotlin/one/zephyr/mobile/protocol/rdp/RdpAndroidRuntime.kt"
JNI = ROOT / "android/protocol-rdp/src/main/cpp/zephyr_rdp_jni.c"
APP = ROOT / "android/app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneApplication.kt"
CONTAINER = ROOT / "android/app/src/main/kotlin/one/zephyr/mobile/app/di/AppContainer.kt"


def normalize(raw: str) -> str:
    value = raw.strip()
    algo = value.split(":", 1)[0]
    if algo.lower() in {"sha256", "sha1"}:
        value = value.split(":", 1)[1]
    hex_chars = "".join(ch.upper() for ch in value if ch in "0123456789abcdefABCDEF")
    if not hex_chars:
        return ""
    return ":".join(hex_chars[i : i + 2] for i in range(0, len(hex_chars), 2))


def decide(stored: str | None, presented: str | None, create_ok: bool) -> str:
    if not create_ok:
        return "create_failed"
    if presented:
        presented = normalize(presented)
    if presented and stored == presented:
        return "retry_ignore"
    if presented:
        return "review_changed" if stored else "review_first"
    return "connect_failed"


def must_contain(path: pathlib.Path, *needles: str) -> None:
    text = path.read_text(encoding="utf-8")
    for needle in needles:
        if needle not in text:
            raise AssertionError(f"{path.name} missing {needle!r}")


def must_not_contain(path: pathlib.Path, *needles: str) -> None:
    text = path.read_text(encoding="utf-8")
    for needle in needles:
        if needle in text:
            raise AssertionError(f"{path.name} unexpectedly contains {needle!r}")


def main() -> int:
    must_contain(RUNTIME, 'const val HOME_ENV = "HOME"', "android.system.Os", "setenv")
    must_contain(APP, "RdpAndroidRuntime.installHome(filesDir)")
    must_contain(CONTAINER, "AndroidRdpEngine(context.filesDir)")
    must_not_contain(CONTAINER, "AndroidRdpEngine()")
    must_contain(
        ENGINE,
        "SESSION_CREATE_FAILED",
        "CertificateReview",
        "ignoreCertificate",
        "pendingReviews",
        "request.password?.copyOf()",
    )
    must_contain(
        JNI,
        "ignoreCertificate",
        "ZEPHYR_RDP_EV_LOG",
        "onCertificateFingerprint",
        "JNI_ABORT",
    )
    engine = ENGINE.read_text(encoding="utf-8")
    if re.search(r"ignoreCertificate\s*=\s*true", engine) and "stored != null && stored == presented" not in engine:
        raise AssertionError("engine would ignore certificates without a stored match")

    cases = [
        (None, None, False, "create_failed"),
        (None, None, True, "connect_failed"),
        (None, "sha256:aabbccdd", True, "review_first"),
        ("AA:BB:CC:DD", "sha256:aabbccdd", True, "retry_ignore"),
        ("AA:BB:CC:DD", "sha256:ddeeff00", True, "review_changed"),
        ("AA:BB:CC:DD", None, True, "connect_failed"),
    ]
    for stored, presented, create_ok, expected in cases:
        got = decide(stored, presented, create_ok)
        if got != expected:
            raise AssertionError(f"{stored!r} {presented!r} {create_ok} -> {got}, want {expected}")

    if normalize("sha256:aabbccdd") != "AA:BB:CC:DD":
        raise AssertionError("normalize replica drifted")
    print("rdp-android-create-replica: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
