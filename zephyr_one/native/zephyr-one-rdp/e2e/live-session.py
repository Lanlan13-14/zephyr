#!/usr/bin/env python3
"""
End-to-end proof that the native helper speaks real RDP.

Why this exists, and why it is not a mock:
  The C-level tests prove the *settings* are assembled correctly, and the Rust
  unit tests prove the framing and surface math. Neither can prove the helper
  actually completes an RDP handshake, receives real graphics, or that the
  BGRA->RGBA channel swap in emit_rect() is the right way round. Only a live
  server can, so this drives one:

      Xvfb (known solid colour)  ->  freerdp-shadow-cli (real RDP server)
        ->  zephyr-one-rdp (the helper under test)  ->  frames decoded here

  The pixel assertion is the important one. PIXEL_FORMAT_BGRA32 names FreeRDP's
  internal layout, and whether that means byte order B,G,R,A in memory is not
  settled by the header comments. Painting the root window pure red and
  asserting the emitted bytes are (255,0,0,255) settles it empirically: with the
  swap backwards we would read (0,0,255,255).

Usage: python3 e2e/live-session.py [--helper PATH]
Exit 0 = all checks passed, 1 = a check failed, 2 = environment unusable.
"""

import argparse
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time

DISPLAY = os.environ.get("ZEPHYR_E2E_DISPLAY", ":99")
WIDTH, HEIGHT = 1024, 768
RDP_PORT = int(os.environ.get("ZEPHYR_E2E_PORT", "33890"))

MSG_CONFIG = 0x00
MSG_STOP = 0x09
MSG_FRAME = 0x81
MSG_EVENT = 0x82

# Upper bound on a single helper frame, mirroring MAX_HELPER_FRAME on the Node
# side. A full 4K repaint is 3840*2160*4 + 9 ≈ 33.2 MB, so 64 MB leaves room
# without letting a desynchronised length prefix turn into a 900 MB read that
# blocks the reader until EOF — which is exactly how this guard used to pass
# while the stream was in fact corrupt.
MAX_FRAME_BYTES = 64 * 1024 * 1024

checks = 0
failures = 0


def ok(cond, what, detail=""):
    global checks, failures
    checks += 1
    suffix = f" ({detail})" if detail else ""
    if cond:
        print(f"  ok   {what}{suffix}")
    else:
        failures += 1
        print(f"  FAIL {what}{suffix}")


def need(binary):
    path = shutil.which(binary)
    if not path:
        print(f"FATAL: {binary} not found on PATH", file=sys.stderr)
        sys.exit(2)
    return path


def need_any(*binaries):
    """Return the first installed command name.

    FreeRDP 2 distributions ship `freerdp-shadow-cli`; Ubuntu 24.04's FreeRDP
    3 package intentionally versions it as `freerdp-shadow-cli3`. The protocol
    test is version-independent and must not fail merely because a distro avoids
    a binary-name collision.
    """
    for binary in binaries:
        path = shutil.which(binary)
        if path:
            return path
    print(f"FATAL: none of {', '.join(binaries)} found on PATH", file=sys.stderr)
    sys.exit(2)


def encode(kind, payload=b""):
    body = bytes([kind]) + payload
    return struct.pack("<I", len(body)) + body


def wait_port(port, timeout=15.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except OSError:
            time.sleep(0.25)
    return False


class Collector:
    """
    Reads the helper's stdout on a thread.

    A thread rather than inline reads because the helper streams frames
    continuously: a synchronous read loop in the main thread would have to guess
    how many frames to expect before asserting, and would deadlock if it guessed
    high.
    """

    def __init__(self, fh):
        self.fh = fh
        self.frames = []
        self.events = []
        self.error = None
        # Byte offset into the stream, so a desync names *where* it happened.
        # That offset is what identified the cause the first time: it landed
        # immediately after the `hello` JSON, pointing at library output rather
        # than at a framing bug.
        self.consumed = 0
        self._stop = False
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _read_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.fh.read(n - len(buf))
            if not chunk:
                return None
            buf += chunk
        return buf

    def _run(self):
        """
        Read length-prefixed frames, treating any deviation as a recorded error.

        The validation below is not defensive padding — it is the entire point of
        the "stdout stream stayed framed" check. An earlier version simply did
        `body = self._read_exact(length); if body is None: return`, which made
        that check unable to fail: when FreeRDP's WLog wrote to stdout inside the
        stream, the next 4 bytes read as a ~931 MB length, _read_exact blocked
        until EOF, returned None, and this thread returned with self.error still
        None. The assertion then reported "ok" while the stream was in fact
        destroyed. Every `return` here now records why it stopped.
        """
        try:
            while not self._stop:
                header = self._read_exact(4)
                if header is None:
                    # EOF exactly on a frame boundary is the one clean ending.
                    return
                length = struct.unpack("<I", header)[0]
                if length < 1 or length > MAX_FRAME_BYTES:
                    self.error = RuntimeError(
                        f"desynchronised stream: frame length {length} out of range "
                        f"at byte {self.consumed}; almost always library output "
                        f"(WLog) landing on stdout inside the protocol channel"
                    )
                    return
                self.consumed += 4
                body = self._read_exact(length)
                if body is None:
                    self.error = RuntimeError(
                        f"truncated frame: wanted {length} bytes at byte "
                        f"{self.consumed}, stream ended first"
                    )
                    return
                self.consumed += length
                kind = body[0]
                if kind == MSG_EVENT:
                    self.events.append(json.loads(body[1:].decode("utf-8")))
                elif kind == MSG_FRAME:
                    if len(body) < 9:
                        self.error = RuntimeError(
                            f"frame header short: {len(body)} bytes"
                        )
                        return
                    x, y, w, h = struct.unpack("<HHHH", body[1:9])
                    self.frames.append((x, y, w, h, body[9:]))
                else:
                    # An unknown kind byte means the stream is misaligned even if
                    # the length happened to look plausible.
                    self.error = RuntimeError(
                        f"unknown frame kind 0x{kind:02x} at byte {self.consumed}"
                    )
                    return
        except Exception as exc:  # noqa: BLE001 - reported, not swallowed
            self.error = exc

    def stop(self):
        self._stop = True

    def event_of(self, kind):
        for event in self.events:
            if event.get("type") == kind:
                return event
        return None

    def wait_for_event(self, kind, timeout):
        deadline = time.time() + timeout
        while time.time() < deadline:
            found = self.event_of(kind)
            if found:
                return found
            time.sleep(0.1)
        return None

    def wait_for_frames(self, count, timeout):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if len(self.frames) >= count:
                return True
            time.sleep(0.1)
        return len(self.frames) >= count


def pixel_at(frame, px, py):
    """RGBA tuple at absolute screen coords, or None if outside this rect."""
    x, y, w, h, pixels = frame
    if not (x <= px < x + w and y <= py < y + h):
        return None
    offset = ((py - y) * w + (px - x)) * 4
    if offset + 4 > len(pixels):
        return None
    return tuple(pixels[offset:offset + 4])


def find_pixel(frames, px, py):
    """Latest frame covering the point wins, matching how a canvas composites."""
    for frame in reversed(frames):
        value = pixel_at(frame, px, py)
        if value is not None:
            return value
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--helper", default=None)
    args = parser.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    crate = os.path.dirname(here)
    helper = args.helper or os.path.join(crate, "target", "debug", "zephyr-one-rdp")
    if not os.path.isfile(helper):
        print(f"FATAL: helper not found at {helper}\nBuild it: cargo build",
              file=sys.stderr)
        sys.exit(2)

    xvfb = need("Xvfb")
    xsetroot = need("xsetroot")
    shadow = need_any("freerdp-shadow-cli", "freerdp-shadow-cli3")

    share = "/tmp/zephyr-e2e-share"
    os.makedirs(share, exist_ok=True)
    with open(os.path.join(share, "hello.txt"), "w") as handle:
        handle.write("zephyr folder mapping e2e\n")

    procs = []
    helper_proc = None
    collector = None
    try:
        print("== environment ==")
        xvfb_proc = subprocess.Popen(
            [xvfb, DISPLAY, "-screen", "0", f"{WIDTH}x{HEIGHT}x24",
             "-nolisten", "tcp"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        procs.append(xvfb_proc)
        time.sleep(1.5)
        ok(xvfb_proc.poll() is None, "Xvfb started")
        if xvfb_proc.poll() is not None:
            print("FATAL: Xvfb died immediately", file=sys.stderr)
            sys.exit(2)

        env = dict(os.environ, DISPLAY=DISPLAY)

        shadow_log_path = "/tmp/zephyr-e2e-shadow.log"
        shadow_log = open(shadow_log_path, "wb")
        shadow_proc = subprocess.Popen(
            [shadow, f"/port:{RDP_PORT}", "/bind-address:127.0.0.1",
             "-auth", "/sec:rdp"],
            env=env, stdout=shadow_log, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
        )
        procs.append(shadow_proc)
        listening = wait_port(RDP_PORT, timeout=15)
        ok(listening, f"freerdp-shadow-cli listening on {RDP_PORT}")
        if not listening:
            shadow_log.flush()
            with open(shadow_log_path, "rb") as handle:
                print(handle.read().decode("utf-8", "replace")[-3000:])
            print("FATAL: shadow server never listened", file=sys.stderr)
            sys.exit(2)

        # Paint *after* shadow is listening, not before.
        #
        # freerdp-shadow-cli takes its baseline capture of the X root when it
        # starts. A colour painted before that point is folded into the baseline
        # and never arrives as an update, so the first frame the client decodes
        # is the zeroed GDI primary buffer — black. Measured directly: with the
        # paint before shadow started the centre pixel read (0,0,0); with it
        # after, (255,0,0).
        subprocess.run([xsetroot, "-solid", "#FF0000"], env=env, check=True)
        print(f"  painted root window #FF0000 on {DISPLAY} (after shadow start)")
        time.sleep(0.5)

        print("\n== live session ==")
        config = {
            "host": "127.0.0.1",
            "port": RDP_PORT,
            "username": "",
            "password": "",
            "width": WIDTH,
            "height": HEIGHT,
            # The shadow server is started with /sec:rdp, so pin the client to
            # the same layer; "auto" would offer NLA first and be refused.
            "security": "rdp",
            "ignoreCertificate": True,
            "audioMode": "off",
            "clipboard": True,
            "driveName": "ZephyrE2E",
            "drivePath": share,
            "dynamicResolution": False,
            "gfx": False,
            "maxFps": 30,
        }

        helper_proc = subprocess.Popen(
            [helper],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=open("/tmp/zephyr-e2e-helper.log", "wb"),
        )
        collector = Collector(helper_proc.stdout)

        helper_proc.stdin.write(
            encode(MSG_CONFIG, json.dumps(config).encode("utf-8")))
        helper_proc.stdin.flush()

        hello = collector.wait_for_event("hello", 10)
        ok(hello is not None, "helper emits hello before connecting")
        if hello:
            ok(hello.get("freerdpMajor") in (2, 3),
               "hello reports the linked FreeRDP major",
               str(hello.get("freerdpMajor")))
            ok(hello.get("driveMapped") is True,
               "hello reports the folder mapping as active")

        connected = collector.wait_for_event("connected", 30)
        ok(connected is not None, "RDP handshake completes against a real server")
        if connected is None:
            # Events first: if the helper emitted an "error" event it names the
            # FreeRDP failure code directly, which the logs only hint at.
            print("--- events emitted by the helper ---")
            for event in collector.events:
                print(f"    {json.dumps(event, ensure_ascii=False)}")
            if not collector.events:
                print("    (none)")
            if collector.error is not None:
                print(f"--- collector reader error: {collector.error!r}")
            print(f"--- frames received: {len(collector.frames)}")
            with open("/tmp/zephyr-e2e-helper.log", "rb") as handle:
                print("--- helper stderr ---")
                print(handle.read().decode("utf-8", "replace")[-3000:])
            with open(shadow_log_path, "rb") as handle:
                print("--- shadow log ---")
                print(handle.read().decode("utf-8", "replace")[-3000:])
        else:
            ok(connected.get("width") == WIDTH and connected.get("height") == HEIGHT,
               "negotiated desktop size matches the request",
               f"{connected.get('width')}x{connected.get('height')}")

            got_frames = collector.wait_for_frames(1, 20)
            ok(got_frames, "server sends graphics the helper decodes into frames",
               f"{len(collector.frames)} frames")

            if collector.frames:
                total_px = sum(f[2] * f[3] for f in collector.frames)
                ok(total_px > 0, "frames carry a non-empty damage area",
                   f"{total_px} px")

                for frame in collector.frames:
                    x, y, w, h, pixels = frame
                    if len(pixels) != w * h * 4:
                        ok(False, "frame payload length equals w*h*4",
                           f"{len(pixels)} != {w*h*4}")
                        break
                else:
                    ok(True, "every frame payload length equals w*h*4")

                for frame in collector.frames:
                    x, y, w, h, _ = frame
                    if x + w > WIDTH or y + h > HEIGHT:
                        ok(False, "no frame exceeds the surface bounds",
                           f"rect {x},{y} {w}x{h}")
                        break
                else:
                    ok(True, "no frame exceeds the surface bounds")

                # The channel-order oracle. Sample well inside the screen to
                # avoid any cursor or border artefact at the origin.
                sample = find_pixel(collector.frames, WIDTH // 2, HEIGHT // 2)
                ok(sample is not None, "centre pixel was painted by some frame")
                if sample is not None:
                    r, g, b, a = sample
                    print(f"  centre pixel RGBA = ({r},{g},{b},{a})")
                    ok(a == 255, "alpha is opaque", str(a))
                    ok(r > 200 and g < 60 and b < 60,
                       "red screen decodes as RED in RGBA byte order "
                       "(proves the BGRA->RGBA swap direction)",
                       f"r={r} g={g} b={b}")

                # Repaint BLUE, not green, and confirm the change propagates.
                #
                # Two things are being proved at once, and the colour choice is
                # what makes the second one possible:
                #   1. Frames track live damage instead of replaying one cached
                #      image (any colour would show this).
                #   2. The BGRA->RGBA channel swap runs in the right direction.
                #
                # Green is the one primary that CANNOT prove (2): (0,255,0)
                # is unchanged by exchanging R and B, so a backwards swap would
                # pass a green assertion just as happily. Red and blue are the
                # asymmetric pair — with the swap inverted, this blue screen
                # would arrive as (255,0,0) and fail here.
                subprocess.run([xsetroot, "-solid", "#0000FF"], env=env, check=True)
                before = len(collector.frames)
                grew = collector.wait_for_frames(before + 1, 15)
                ok(grew, "repainting the desktop produces new frames",
                   f"{len(collector.frames)} total")
                blue = find_pixel(collector.frames, WIDTH // 2, HEIGHT // 2)
                if blue is not None:
                    r, g, b, _ = blue
                    print(f"  centre pixel after blue repaint = ({r},{g},{b})")
                    ok(b > 200 and r < 60 and g < 60,
                       "blue screen decodes as BLUE, so the R/B swap is not "
                       "inverted (red+blue are the asymmetric pair; green "
                       "cannot detect an inverted swap)",
                       f"r={r} g={g} b={b}")

        print("\n== shutdown ==")
        helper_proc.stdin.write(encode(MSG_STOP))
        helper_proc.stdin.flush()
        try:
            rc = helper_proc.wait(timeout=15)
            ok(True, "helper exits on MSG_STOP", f"rc={rc}")
        except subprocess.TimeoutExpired:
            ok(False, "helper exits on MSG_STOP", "timed out")
            helper_proc.kill()

        disconnected = collector.event_of("disconnected")
        ok(disconnected is not None, "helper reports a clean disconnect")

        if collector.error:
            ok(False, "stdout stream stayed framed", repr(collector.error))
        else:
            ok(True, "stdout stream stayed framed")

    finally:
        if collector:
            collector.stop()
        if helper_proc and helper_proc.poll() is None:
            helper_proc.kill()
        for proc in reversed(procs):
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()

    print(f"\n{checks} checks, {failures} failures")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
