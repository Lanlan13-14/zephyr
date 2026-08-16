#!/usr/bin/env python3
"""Replica of SshRemoteOps parsers. A mutation that drops docker-status
markers or CPU-rate math must fail here even when Gradle is unavailable."""
from __future__ import annotations

import json
import re
import sys


def parse_docker_status(raw: str) -> dict:
    return {
        "installed": "__DOCKER_INSTALLED__=1" in raw,
        "socket": "__DOCKER_SOCKET__=1" in raw,
        "version": next((line.strip() for line in raw.splitlines() if line.lower().startswith("docker version")), ""),
    }


def parse_json_lines(raw: str) -> list[dict]:
    out = []
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def parse_cpu_stat(raw: str):
    for line in raw.splitlines():
        if line.startswith("cpu "):
            parts = [int(x) for x in line.split()[1:]]
            idle = (parts[3] if len(parts) > 3 else 0) + (parts[4] if len(parts) > 4 else 0)
            return {"idle": idle, "total": sum(parts)}
    return None


def compute_cpu(current, previous) -> float:
    if not current or not previous:
        return 0.0
    total = current["total"] - previous["total"]
    idle = current["idle"] - previous["idle"]
    if total <= 0:
        return 0.0
    return max(0.0, min(100.0, (1.0 - idle / total) * 100.0))


def unique_copy_name(existing: set[str], original: str) -> str:
    if original not in existing:
        return original
    archive = next((ext for ext in [".tar.gz", ".tgz", ".zip"] if original.endswith(ext)), "")
    stem = original[: -len(archive)] if archive else original.rsplit(".", 1)[0] if "." in original[1:] else original
    suffix = archive or (("." + original.rsplit(".", 1)[1]) if "." in original[1:] else "")
    index = 1
    while True:
        candidate = f"{stem}-复制{suffix}" if index == 1 else f"{stem}-复制{index}{suffix}"
        if candidate not in existing:
            return candidate
        index += 1


def main() -> int:
    status = parse_docker_status("__DOCKER_INSTALLED__=1\nDocker version 27.1.1, build x\n__DOCKER_SOCKET__=1\n")
    assert status["installed"] and status["socket"]
    assert status["version"].startswith("Docker version 27.1.1")
    missing = parse_docker_status("__DOCKER_INSTALLED__=0\n")
    assert not missing["installed"]

    rows = parse_json_lines('{"ID":"abc","Names":"/nginx","State":"running"}\nnot-json\n{"ID":"def","Names":"worker","State":"exited"}\n')
    assert len(rows) == 2
    assert rows[0]["Names"] == "/nginx"

    first = parse_cpu_stat("cpu  100 0 0 100 0 0 0 0 0 0")
    second = parse_cpu_stat("cpu  180 0 0 120 0 0 0 0 0 0")
    usage = compute_cpu(second, first)
    assert 79.0 < usage < 81.0, usage
    assert compute_cpu(second, None) == 0.0

    assert unique_copy_name({"notes.txt"}, "notes.txt") == "notes-复制.txt"
    assert unique_copy_name({"backup.tar.gz"}, "backup.tar.gz") == "backup-复制.tar.gz"

    # Mutation guard: the Android source must still emit the same markers and commands.
    from pathlib import Path
    src = Path(__file__).resolve().parents[1] / "android/protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshRemoteOps.kt"
    text = src.read_text(encoding="utf-8")
    for needle in (
        "__DOCKER_INSTALLED__",
        "docker ps -a --no-trunc --format '{{json .}}'",
        "docker image ls --no-trunc --format '{{json .}}'",
        "registry-mirrors",
        "systemctl restart docker",
        "ps -eo pid=,user=,pcpu=,pmem=,stat=,comm=,args=",
        "kill -s",
    ):
        if needle not in text:
            raise AssertionError(f"missing {needle}")
    print("ssh-ops-parser-replica: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
