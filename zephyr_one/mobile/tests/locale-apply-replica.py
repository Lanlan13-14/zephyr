#!/usr/bin/env python3

def from_stored(value):
    if value in ("zh-Hans", "zh", "zh-CN", "zh-cn"):
        return "ZH_HANS"
    if value in ("zh-Hant", "zh-TW", "zh-tw", "zh-HK", "zh-hk"):
        return "ZH_HANT"
    if value in ("en", "en-US", "en-GB"):
        return "EN"
    return "SYSTEM"

def pending(stored, applied):
    if stored is None:
        return None
    wanted = from_stored(stored)
    return None if wanted == applied else wanted

def check(cond, msg):
    if not cond:
        raise AssertionError(msg)

check(pending(None, "SYSTEM") is None, "null stored waits")
check(pending("system", "SYSTEM") is None, "already system")
check(pending("en", "EN") is None, "already en")
check(pending("en", "SYSTEM") == "EN", "system to en")
check(pending("system", "ZH_HANS") == "SYSTEM", "zh to system")
check(pending("zh-Hans", "EN") == "ZH_HANS", "en to zh")
print("locale-apply-replica: all cases passed")
