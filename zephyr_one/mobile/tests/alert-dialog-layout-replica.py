"""Replica of AlertDialogLayout so the wrap/height contract can fail
without an Android SDK. Keep this file byte-for-byte with the Kotlin
helpers; the Node suite execs it and diffs the outputs.
"""

from __future__ import annotations

MAX_SHEET_DP = 640.0
EDGE_GUTTER_DP = 10.0
GROUP_GAP_DP = 8.0
ACTION_MIN_DP = 50.0
FINGERPRINT_GROUP = 4
FINGERPRINT_GROUPS_PER_LINE = 6
DARK_SHEET_ARGB = 0xFF1A1E25
LIGHT_SHEET_ARGB = 0xFFFFFFFF


def available_height_dp(window_height_dp: float) -> float:
    return max(min(window_height_dp - EDGE_GUTTER_DP * 2.0, MAX_SHEET_DP), 120.0)


def stacked_height_dp(body_height_dp: float, has_dismiss: bool) -> float:
    groups = body_height_dp + GROUP_GAP_DP + ACTION_MIN_DP if has_dismiss else body_height_dp
    return groups + EDGE_GUTTER_DP


def sheet_fits(window_height_dp: float, body_height_dp: float, has_dismiss: bool) -> bool:
    available = available_height_dp(window_height_dp)
    stacked = stacked_height_dp(body_height_dp, has_dismiss)
    return stacked <= available + 0.01 and stacked <= window_height_dp - EDGE_GUTTER_DP


def _is_hex_digit(ch: str) -> bool:
    return ("0" <= ch <= "9") or ("A" <= ch <= "F") or ("a" <= ch <= "f")


def wrap_fingerprint(raw: str) -> str:
    compact = "".join(raw.split())
    if not compact:
        return raw
    colon = compact.find(":")
    head = compact[:colon] if 1 <= colon <= 8 else ""
    prefix_end = colon + 1 if head and any(not _is_hex_digit(ch) for ch in head) else 0
    prefix = compact[:prefix_end]
    payload = compact[prefix_end:].replace(":", "")
    if not payload:
        return compact
    groups = [payload[i : i + FINGERPRINT_GROUP] for i in range(0, len(payload), FINGERPRINT_GROUP)]
    lines = [
        " ".join(groups[i : i + FINGERPRINT_GROUPS_PER_LINE])
        for i in range(0, len(groups), FINGERPRINT_GROUPS_PER_LINE)
    ]
    if not prefix:
        return "\n".join(lines)
    return prefix + lines[0] + "".join("\n" + line for line in lines[1:])


def main() -> int:
    assert available_height_dp(780.0) == 640.0
    assert available_height_dp(360.0) == 340.0
    assert available_height_dp(80.0) == 120.0
    body = 180.0
    assert sheet_fits(780.0, body, True)
    assert not sheet_fits(220.0, body, True)
    assert stacked_height_dp(body, True) == body + 8.0 + 50.0 + 10.0

    raw = "SHA256:QytVAAei+gY5ISAlZF3D6WfcZGOaTGY+ygTPRiDSbl0"
    wrapped = wrap_fingerprint(raw)
    assert wrapped == "SHA256:QytV AAei +gY5 ISAl ZF3D 6Wfc\nZGOa TGY+ ygTP RiDS bl0"
    assert max(len(line) for line in wrapped.split("\n")) <= 48
    assert wrap_fingerprint(wrapped) == wrapped
    assert wrapped.replace("\n", "").replace(" ", "") == raw

    tls = ":".join(f"{i:02X}" for i in range(32))
    tls_wrapped = wrap_fingerprint(tls)
    assert tls_wrapped.startswith("0001 0203")
    assert tls.replace(":", "") == tls_wrapped.replace(" ", "").replace(":", "").replace("\n", "")
    hex_head = "A1:B2:C3:D4:E5:F6:01:23"
    assert wrap_fingerprint(hex_head).startswith("A1B2")
    assert (DARK_SHEET_ARGB >> 24) & 0xFF == 0xFF
    assert (LIGHT_SHEET_ARGB >> 24) & 0xFF == 0xFF
    print("alert-dialog-layout-replica ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
