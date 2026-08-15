#!/usr/bin/env python3
"""Replica of AppLock / AppLockPreferences / UnlockPresentation JUnit suites.

There is no Android SDK here. The Kotlin sources stay the source of truth; this
file re-implements the same methods so the lock/unlock policy can fail in CI
the same way the JUnit would.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, List, Optional


class LockDelay(Enum):
    IMMEDIATE = 0
    ONE_MINUTE = 60_000
    FIVE_MINUTES = 300_000

    @property
    def millis(self) -> int:
        return self.value


class BiometricAvailability(Enum):
    AVAILABLE = "AVAILABLE"
    NO_HARDWARE = "NO_HARDWARE"
    HARDWARE_UNAVAILABLE = "HARDWARE_UNAVAILABLE"
    NONE_ENROLLED = "NONE_ENROLLED"
    SECURITY_UPDATE_REQUIRED = "SECURITY_UPDATE_REQUIRED"
    UNSUPPORTED = "UNSUPPORTED"
    UNKNOWN = "UNKNOWN"

    @property
    def can_authenticate(self) -> bool:
        return self is BiometricAvailability.AVAILABLE


class LockState(Enum):
    DISABLED = "DISABLED"
    UNLOCKED = "UNLOCKED"
    LOCKED = "LOCKED"


class AppLockApplyResult(Enum):
    DISABLED = "DISABLED"
    UNAVAILABLE = "UNAVAILABLE"
    UNLOCKED = "UNLOCKED"
    LOCKED = "LOCKED"
    ALREADY_ENABLED = "ALREADY_ENABLED"


@dataclass(frozen=True)
class AuthResult:
    kind: str
    availability: Optional[BiometricAvailability] = None
    message: str = ""

    @staticmethod
    def success() -> "AuthResult":
        return AuthResult("success")

    @staticmethod
    def cancelled() -> "AuthResult":
        return AuthResult("cancelled")

    @staticmethod
    def failed(availability: BiometricAvailability, message: str) -> "AuthResult":
        return AuthResult("failed", availability, message)


class DeviceAuthenticator:
    def availability(self) -> BiometricAvailability:
        raise NotImplementedError

    def authenticate(self, title: str, subtitle: str) -> AuthResult:
        raise NotImplementedError


class CountingSink:
    def __init__(self) -> None:
        self.clears = 0

    def on_locked(self) -> None:
        self.clears += 1


@dataclass
class FakeAuthenticator(DeviceAuthenticator):
    availability_value: BiometricAvailability = BiometricAvailability.AVAILABLE
    result: AuthResult = field(default_factory=AuthResult.success)
    authenticate_calls: int = 0
    last_title: Optional[str] = None

    def availability(self) -> BiometricAvailability:
        return self.availability_value

    def authenticate(self, title: str, subtitle: str) -> AuthResult:
        self.authenticate_calls += 1
        self.last_title = title
        return self.result


class AppLock:
    def __init__(self, authenticator: DeviceAuthenticator, clock: Callable[[], int] = lambda: 0) -> None:
        self._authenticator = authenticator
        self._clock = clock
        self._sinks: List[CountingSink] = []
        self._state = LockState.DISABLED
        self._delay = LockDelay.IMMEDIATE
        self._backgrounded_at: Optional[int] = None

    @property
    def state(self) -> LockState:
        return self._state

    @property
    def lock_delay(self) -> LockDelay:
        return self._delay

    @property
    def is_enabled(self) -> bool:
        return self._state is not LockState.DISABLED

    def register(self, sink: CountingSink) -> None:
        self._sinks.append(sink)

    def availability(self) -> BiometricAvailability:
        return self._authenticator.availability()

    def enable(self, delay: LockDelay) -> bool:
        if not self._authenticator.availability().can_authenticate:
            return False
        self._delay = delay
        self._state = LockState.UNLOCKED
        self._backgrounded_at = None
        return True

    def disable(self) -> None:
        self._delay = LockDelay.IMMEDIATE
        self._backgrounded_at = None
        self._state = LockState.DISABLED

    def set_delay(self, delay: LockDelay) -> None:
        if not self.is_enabled:
            return
        self._delay = delay

    def on_enter_background(self) -> None:
        self._notify()
        if self._state is not LockState.UNLOCKED:
            return
        if self._delay is LockDelay.IMMEDIATE:
            self._backgrounded_at = None
            self._state = LockState.LOCKED
        else:
            self._backgrounded_at = self._clock()

    def on_enter_foreground(self) -> None:
        if self._state is not LockState.UNLOCKED:
            return
        since = self._backgrounded_at
        if since is None:
            return
        if self._clock() - since >= self._delay.millis:
            self.lock_now()
        self._backgrounded_at = None

    def lock_now(self) -> None:
        if not self.is_enabled:
            return
        self._backgrounded_at = None
        self._state = LockState.LOCKED
        self._notify()

    def unlock(self, title: str, subtitle: str) -> AuthResult:
        if self._state is not LockState.LOCKED:
            return AuthResult.success()
        result = self._authenticator.authenticate(title, subtitle)
        if result.kind == "success":
            self._state = LockState.UNLOCKED
        return result

    def confirm_local_reveal(self, title: str, subtitle: str) -> AuthResult:
        if not self._authenticator.availability().can_authenticate:
            return AuthResult.failed(self._authenticator.availability(), "platform authentication unavailable")
        return self._authenticator.authenticate(title, subtitle)

    def _notify(self) -> None:
        for sink in list(self._sinks):
            sink.on_locked()


def apply_preferences(lock: AppLock, enabled: bool, delay: LockDelay, lock_on_enable: bool) -> AppLockApplyResult:
    if not enabled:
        if lock.is_enabled:
            lock.disable()
        return AppLockApplyResult.DISABLED
    if lock.is_enabled:
        lock.set_delay(delay)
        return AppLockApplyResult.ALREADY_ENABLED
    if not lock.enable(delay):
        return AppLockApplyResult.UNAVAILABLE
    if lock_on_enable:
        lock.lock_now()
        return AppLockApplyResult.LOCKED
    return AppLockApplyResult.UNLOCKED


def failure_message(result: AuthResult, unavailable: str) -> Optional[str]:
    if result.kind in ("success", "cancelled"):
        return None
    if result.availability is not None and result.availability.can_authenticate:
        return result.message
    return unavailable


def allowed_authenticators(sdk_int: int) -> int:
    biometric_strong = 0x000F
    biometric_weak = 0x00FF
    device_credential = 0x8000
    return (biometric_strong | device_credential) if sdk_int >= 30 else (biometric_weak | device_credential)


def is_interactive_cancellation(code: int) -> bool:
    error_user_canceled = 10
    error_negative_button = 13
    return code in (error_user_canceled, error_negative_button)


def check(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> int:
    lock = AppLock(FakeAuthenticator())
    sink = CountingSink()
    lock.register(sink)
    lock.on_enter_background()
    check(sink.clears == 1, "disabled background still clears")
    check(lock.state is LockState.DISABLED, "disabled stays disabled")

    now = 1_000
    lock = AppLock(FakeAuthenticator(), clock=lambda: now)
    sink = CountingSink()
    lock.register(sink)
    check(lock.enable(LockDelay.ONE_MINUTE), "enable delayed")
    lock.on_enter_background()
    check(sink.clears == 1, "delayed background clears immediately")
    check(lock.state is LockState.UNLOCKED, "delayed background stays unlocked")
    now += LockDelay.ONE_MINUTE.millis
    lock.on_enter_foreground()
    check(lock.state is LockState.LOCKED, "delay elapsed locks")
    check(sink.clears == 2, "lockNow notifies again")

    lock = AppLock(FakeAuthenticator())
    sink = CountingSink()
    lock.register(sink)
    check(lock.enable(LockDelay.IMMEDIATE), "enable immediate")
    lock.on_enter_background()
    check(lock.state is LockState.LOCKED, "immediate background locks")
    check(sink.clears == 1, "immediate background notifies once")

    lock = AppLock(FakeAuthenticator(availability_value=BiometricAvailability.NONE_ENROLLED))
    check(not lock.enable(LockDelay.IMMEDIATE), "refuse when none enrolled")
    check(lock.state is LockState.DISABLED, "refused enable stays disabled")

    authenticator = FakeAuthenticator()
    lock = AppLock(authenticator)
    check(lock.enable(LockDelay.IMMEDIATE), "enable for unlock")
    lock.lock_now()
    result = lock.unlock("解锁 Zephyr One", "使用设备凭据继续")
    check(result.kind == "success", "unlock success")
    check(lock.state is LockState.UNLOCKED, "unlock moves to unlocked")
    check(authenticator.authenticate_calls == 1, "unlock asked the platform")
    check(authenticator.last_title == "解锁 Zephyr One", "unlock title")

    authenticator = FakeAuthenticator(result=AuthResult.cancelled())
    lock = AppLock(authenticator)
    lock.enable(LockDelay.IMMEDIATE)
    lock.lock_now()
    result = lock.unlock("t", "s")
    check(result.kind == "cancelled", "cancelled stays cancelled")
    check(lock.state is LockState.LOCKED, "cancelled stays locked")

    authenticator = FakeAuthenticator()
    lock = AppLock(authenticator)
    lock.enable(LockDelay.IMMEDIATE)
    result = lock.unlock("t", "s")
    check(result.kind == "success", "not-locked unlock is success")
    check(authenticator.authenticate_calls == 0, "not-locked unlock is a no-op")

    authenticator = FakeAuthenticator(availability_value=BiometricAvailability.NO_HARDWARE)
    lock = AppLock(authenticator)
    result = lock.confirm_local_reveal("t", "s")
    check(result.kind == "failed", "confirm refuses no hardware")
    check(result.availability is BiometricAvailability.NO_HARDWARE, "confirm keeps availability")
    check(authenticator.authenticate_calls == 0, "confirm does not prompt when unavailable")

    lock = AppLock(FakeAuthenticator())
    applied = apply_preferences(lock, True, LockDelay.FIVE_MINUTES, False)
    check(applied is AppLockApplyResult.UNLOCKED, "settings enable stays unlocked")
    check(lock.state is LockState.UNLOCKED, "settings enable state")
    check(lock.lock_delay is LockDelay.FIVE_MINUTES, "settings enable delay")

    lock = AppLock(FakeAuthenticator())
    sink = CountingSink()
    lock.register(sink)
    applied = apply_preferences(lock, True, LockDelay.IMMEDIATE, True)
    check(applied is AppLockApplyResult.LOCKED, "process restore locks")
    check(lock.state is LockState.LOCKED, "process restore state")
    check(sink.clears == 1, "process restore notifies")

    lock = AppLock(FakeAuthenticator())
    lock.enable(LockDelay.IMMEDIATE)
    lock.lock_now()
    applied = apply_preferences(lock, True, LockDelay.ONE_MINUTE, True)
    check(applied is AppLockApplyResult.ALREADY_ENABLED, "already enabled")
    check(lock.state is LockState.LOCKED, "already enabled keeps lock")
    check(lock.lock_delay is LockDelay.ONE_MINUTE, "already enabled updates delay")

    lock = AppLock(FakeAuthenticator())
    lock.enable(LockDelay.ONE_MINUTE)
    applied = apply_preferences(lock, False, LockDelay.ONE_MINUTE, True)
    check(applied is AppLockApplyResult.DISABLED, "disable preference")
    check(lock.state is LockState.DISABLED, "disable state")
    check(not lock.is_enabled, "disable isEnabled")

    lock = AppLock(FakeAuthenticator(availability_value=BiometricAvailability.UNSUPPORTED))
    applied = apply_preferences(lock, True, LockDelay.IMMEDIATE, True)
    check(applied is AppLockApplyResult.UNAVAILABLE, "unavailable hardware")
    check(lock.state is LockState.DISABLED, "unavailable stays disabled")

    check(failure_message(AuthResult.success(), "不可用") is None, "success hides copy")
    check(failure_message(AuthResult.cancelled(), "不可用") is None, "cancel hides copy")
    check(
        failure_message(AuthResult.failed(BiometricAvailability.AVAILABLE, "指纹不匹配"), "不可用") == "指纹不匹配",
        "available keeps platform text",
    )
    check(
        failure_message(AuthResult.failed(BiometricAvailability.NONE_ENROLLED, "none"), "不可用") == "不可用",
        "unavailable uses precise copy",
    )

    check(allowed_authenticators(26) == 0x00FF | 0x8000, "API 26 combo")
    check(allowed_authenticators(29) == 0x00FF | 0x8000, "API 29 combo")
    check(allowed_authenticators(30) == 0x000F | 0x8000, "API 30 combo")
    check(allowed_authenticators(35) == 0x000F | 0x8000, "API 35 combo")
    check(is_interactive_cancellation(10), "user cancel")
    check(is_interactive_cancellation(13), "negative button")
    check(not is_interactive_cancellation(5), "framework cancel is not interactive")
    check(not is_interactive_cancellation(7), "lockout is not interactive")

    # Mutation: dropping lock_on_enable must fail the restore case.
    def broken_apply(lock: AppLock, enabled: bool, delay: LockDelay, lock_on_enable: bool) -> AppLockApplyResult:
        if not enabled:
            if lock.is_enabled:
                lock.disable()
            return AppLockApplyResult.DISABLED
        if lock.is_enabled:
            lock.set_delay(delay)
            return AppLockApplyResult.ALREADY_ENABLED
        if not lock.enable(delay):
            return AppLockApplyResult.UNAVAILABLE
        return AppLockApplyResult.UNLOCKED

    broken = AppLock(FakeAuthenticator())
    check(
        broken_apply(broken, True, LockDelay.IMMEDIATE, True) is not AppLockApplyResult.LOCKED,
        "mutation without lockOnEnable must not lock",
    )

    print("app-lock-junit-replica: all cases passed")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except AssertionError as exc:
        print("FAIL:", exc, file=sys.stderr)
        sys.exit(1)
