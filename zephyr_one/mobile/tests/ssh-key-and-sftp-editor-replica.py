#!/usr/bin/env python3
"""Replica of SshPrivateKeyLoader cipher probe + SftpEditorHistory coalesce.

Gradle is unavailable in this sandbox. These two algorithms are the ones a
regression would silently break: encrypted OpenSSH keys would look unencrypted,
and the editor would snapshot the whole file on every keystroke again.
"""
from __future__ import annotations

import base64
import sys
from pathlib import Path


MAGIC = b"openssh-key-v1\x00"

ED25519 = """-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACDCNOa2VSpZOlSzO9Z8jXhGIJDyq02ESWICLwSdnUsotAAAAJDSAUTF0gFE
xQAAAAtzc2gtZWQyNTUxOQAAACDCNOa2VSpZOlSzO9Z8jXhGIJDyq02ESWICLwSdnUsotA
AAAEBRkilTYHsUxFV2w9xeaktHCWNOFQ6IWxPbDRy2rbh8/sI05rZVKlk6VLM71nyNeEYg
kPKrTYRJYgIvBJ2dSyi0AAAAC3plcGh5ci10ZXN0AQI=
-----END OPENSSH PRIVATE KEY-----"""

ED25519_ENC = """-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABDud1KCPl
RoyDsV2rlcmRtCAAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAILl3rdVFSpxo7ra/
ZtL2W++WTixQz5hFrjH9t/GM8HbFAAAAkH5xkd0zNz+RvQLm4nEKwyexeV8+Toxm3mH6dY
/RL5vISS/XPWos4z8nj2hZZweFNlmkjQKkXZNa+J8ZAzVglznX4Zw5dG1zHzu2gIOZayK6
GjFy2yBnyNywu6QLUFlNnnZJHXbaHxDEFEbP0ktiI2VpqMDbhnUeosIurAhupnH7bgE9tU
n78gVxzDzsPMyhHA==
-----END OPENSSH PRIVATE KEY-----"""


def normalize(raw: str) -> str:
    trimmed = raw.strip().lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    begin = trimmed.find("-----BEGIN ")
    if begin < 0:
        return trimmed
    end_token = trimmed.find("-----END ", begin)
    if end_token < 0:
        return trimmed[begin:]
    closing = trimmed.find("-----", end_token + len("-----END "))
    if closing < 0:
        return trimmed[begin:]
    return trimmed[begin : closing + 5]


def open_ssh_v1_cipher_name(pem: str) -> str | None:
    body = "".join(
        line.strip()
        for line in pem.splitlines()
        if line.strip() and not line.strip().startswith("-----")
    )
    try:
        decoded = base64.b64decode(body, validate=True)
    except Exception:
        return None
    if len(decoded) < len(MAGIC) + 8 or decoded[: len(MAGIC)] != MAGIC:
        return None
    offset = len(MAGIC)
    length = int.from_bytes(decoded[offset : offset + 4], "big")
    start = offset + 4
    if length < 0 or start + length > len(decoded):
        return None
    return decoded[start : start + length].decode("ascii")


def is_encrypted(pem: str) -> bool:
    header = next((line.strip() for line in pem.splitlines() if line.strip()), "")
    if "ENCRYPTED" in header.upper() or "Proc-Type: 4,ENCRYPTED" in pem:
        return True
    cipher = open_ssh_v1_cipher_name(pem)
    return bool(cipher) and cipher.lower() != "none"


class History:
    def __init__(self, coalesce_ms: int = 400, coalesce_chars: int = 24) -> None:
        self.undo: list[str] = []
        self.redo: list[str] = []
        self.last = 0
        self.coalesce_ms = coalesce_ms
        self.coalesce_chars = coalesce_chars

    def record(self, previous: str, nxt: str, now: int) -> None:
        if previous == nxt:
            return
        prefix = _prefix(previous, nxt)
        suffix = _suffix(previous, nxt, prefix)
        small = (len(previous) - prefix - suffix) <= self.coalesce_chars and (
            len(nxt) - prefix - suffix
        ) <= self.coalesce_chars
        coalesce = self.undo and 0 <= now - self.last <= self.coalesce_ms and small
        if not coalesce:
            self.undo.append(previous)
        self.last = now
        self.redo.clear()


def _prefix(left: str, right: str) -> int:
    limit = min(len(left), len(right))
    index = 0
    while index < limit and left[index] == right[index]:
        index += 1
    return index


def _suffix(left: str, right: str, prefix: int) -> int:
    limit = min(len(left) - prefix, len(right) - prefix)
    index = 0
    while index < limit and left[-1 - index] == right[-1 - index]:
        index += 1
    return index


def main() -> int:
    plain = normalize("请粘贴\n\n" + ED25519 + "\n完")
    enc = normalize(ED25519_ENC)
    assert plain.startswith("-----BEGIN OPENSSH PRIVATE KEY-----")
    assert open_ssh_v1_cipher_name(plain) == "none"
    assert not is_encrypted(plain)
    assert open_ssh_v1_cipher_name(enc) == "aes256-ctr"
    assert is_encrypted(enc)
    assert "bcrypt" not in enc

    coalesced = History(coalesce_ms=400)
    text = ""
    now = 1000
    for ch in "typing-feels-fine":
        nxt = text + ch
        coalesced.record(text, nxt, now)
        text = nxt
        now += 20
    assert len(coalesced.undo) == 1, coalesced.undo

    naive = History(coalesce_ms=0)
    text = ""
    now = 1000
    for ch in "typing-feels-fine":
        nxt = text + ch
        naive.record(text, nxt, now)
        text = nxt
        now += 20
    assert len(naive.undo) == len("typing-feels-fine")

    root = Path(__file__).resolve().parents[1]
    loader = (root / "android/protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshPrivateKeyLoader.kt").read_text()
    history = (root / "android/feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SftpEditorHistory.kt").read_text()
    engine = (root / "android/protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshjEngine.kt").read_text()
    for needle in ("OpenSSHKeyV1KeyFile", "openSshV1CipherName", "openssh-key-v1"):
        if needle not in loader:
            raise AssertionError(f"loader missing {needle}")
    if 'pem.contains("bcrypt"' in loader:
        raise AssertionError("loader still guesses encryption from a bcrypt substring")
    if "SshPrivateKeyLoader.load(" not in engine:
        raise AssertionError("engine no longer uses the v1-aware loader")
    for needle in ("coalesceMs", "isSmallSingleRegionEdit"):
        if needle not in history:
            raise AssertionError(f"history missing {needle}")
    print("ssh-key-and-sftp-editor-replica: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
