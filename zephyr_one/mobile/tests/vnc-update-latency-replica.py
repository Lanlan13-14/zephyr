#!/usr/bin/env python3
"""Replica of RfbUpdateLatency. Keep in lockstep with RfbUpdateLatency.kt."""

from __future__ import annotations

import unittest

NONE = -1
MIN_MS = 1
MAX_MS = 60_000
NANOS_PER_MS = 1_000_000


class RfbUpdateLatency:
    def __init__(self):
        self.outstanding = NONE

    def mark_requested(self, at_ns: int) -> None:
        if self.outstanding != NONE:
            return
        self.outstanding = at_ns

    def sample(self, at_ns: int):
        started = self.outstanding
        self.outstanding = NONE
        if started == NONE or at_ns < started:
            return None
        ms = (at_ns - started) // NANOS_PER_MS
        if ms < MIN_MS or ms > MAX_MS:
            return None
        return ms


class Replica(unittest.TestCase):
    def test_matched_request(self):
        s = RfbUpdateLatency()
        s.mark_requested(1_000_000_000)
        self.assertEqual(s.sample(1_018_000_000), 18)

    def test_second_request_does_not_restart(self):
        s = RfbUpdateLatency()
        s.mark_requested(0)
        s.mark_requested(5_000_000)
        self.assertEqual(s.sample(20_000_000), 20)

    def test_no_request(self):
        self.assertIsNone(RfbUpdateLatency().sample(10_000_000))

    def test_sub_millisecond_dropped(self):
        s = RfbUpdateLatency()
        s.mark_requested(0)
        self.assertIsNone(s.sample(500_000))

    def test_over_one_minute_dropped(self):
        s = RfbUpdateLatency()
        s.mark_requested(0)
        self.assertIsNone(s.sample(61_000 * NANOS_PER_MS))


if __name__ == "__main__":
    unittest.main()
