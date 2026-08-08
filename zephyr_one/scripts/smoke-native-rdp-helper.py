#!/usr/bin/env python3
"""Verify a staged zephyr-one-rdp helper starts and speaks framed protocol."""
import json
import struct
import subprocess
import sys

MSG_CONFIG = 0x00
MSG_STOP = 0x09
MSG_EVENT = 0x82

helper = sys.argv[1]
config = json.dumps({
    "host": "127.0.0.1",
    "port": 9,
    "security": "rdp",
    "audioMode": "off",
    "clipboard": False,
    "dynamicResolution": False,
    "maxFps": 30,
}, separators=(",", ":")).encode()

def frame(kind, body=b""):
    payload = bytes([kind]) + body
    return struct.pack("<I", len(payload)) + payload

proc = subprocess.Popen(
    [helper], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
)
try:
    proc.stdin.write(frame(MSG_CONFIG, config))
    proc.stdin.flush()
    header = proc.stdout.read(4)
    if len(header) != 4:
        err = proc.stderr.read(4096).decode("utf-8", "replace")
        raise RuntimeError(f"no framed output; stderr={err!r}")
    size = struct.unpack("<I", header)[0]
    if size < 2 or size > 1024 * 1024:
        raise RuntimeError(f"invalid first frame length {size}")
    body = proc.stdout.read(size)
    if len(body) != size or body[0] != MSG_EVENT:
        raise RuntimeError("first output is not an EVENT frame")
    event = json.loads(body[1:])
    if event.get("type") != "hello" or event.get("freerdpMajor") not in (2, 3):
        raise RuntimeError(f"unexpected first event: {event!r}")
    proc.stdin.write(frame(MSG_STOP))
    proc.stdin.flush()
    print(f"Native RDP helper smoke OK (FreeRDP {event['freerdpMajor']})")
finally:
    try:
        proc.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
