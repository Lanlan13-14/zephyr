import Combine
import Foundation

/// Local app lock.
///
/// DEVELOPMENT.md is explicit: One must never ask the user to create a Zephyr
/// One unlock password. The only credential is the platform one
/// (LocalAuthentication: biometrics, or the device credential as fallback).
/// When platform authentication is unavailable the feature reports unavailable
/// rather than degrading to an app-built password.
///
/// App lock is a local convenience only. It never substitutes for main-end
/// sensitive verification, which still requires the account password or TOTP.
public enum LockDelay: Int64, Sendable, CaseIterable {
    case immediate = 0
    case oneMinute = 60_000
    case fiveMinutes = 300_000

    public var millis: Int64 { rawValue }

    public static let standardDefault: LockDelay = .immediate
}

/// Why the platform cannot authenticate, so the settings page can say so
/// precisely.
public enum BiometricAvailability: String, Sendable, CaseIterable {
    case available
    case noHardware
    case hardwareUnavailable
    case noneEnrolled
    case securityUpdateRequired
    case unsupported
    case unknown

    public var canAuthenticate: Bool { self == .available }
}

public enum AuthResult: Equatable, Sendable {
    case success

    /// User dismissed the prompt. The app stays locked; no fallback credential
    /// is offered.
    case cancelled

    case failed(availability: BiometricAvailability, message: String)
}

/// Platform authentication port. The LocalAuthentication implementation lives
/// in the host app because it needs UIKit; keeping it behind an interface lets
/// the lock state machine be unit tested without a device.
public protocol DeviceAuthenticator: AnyObject {
    func availability() -> BiometricAvailability
    func authenticate(title: String, subtitle: String) async -> AuthResult
}

public enum LockState: String, Sendable, CaseIterable {
    case disabled
    case unlocked
    case locked
}

/// Anything holding decrypted material must register here so a lock event
/// drops it. Registered sinks are also cleared on unbind and on device
/// revocation.
public protocol LockSensitiveSink: AnyObject {
    func onLocked()
}

/// The S01 lock policy, ported from the Kotlin core-security `AppLock`.
///
/// ObservableObject so the root view can gate the whole app on ``AppLock/state``;
/// every rule still lives in plain methods so `swift test` drives them without
/// a run loop.
public final class AppLock: ObservableObject {

    private let authenticator: DeviceAuthenticator
    private let clock: () -> Int64

    private let sinkLock = NSLock()
    private var sinks: [LockSensitiveSink] = []

    @Published public private(set) var state: LockState = .disabled
    private var delay: LockDelay = .standardDefault
    private var backgroundedAt: Int64?

    public init(authenticator: DeviceAuthenticator, clock: @escaping () -> Int64) {
        self.authenticator = authenticator
        self.clock = clock
    }

    public var lockDelay: LockDelay { delay }
    public var isEnabled: Bool { state != .disabled }

    public func register(_ sink: LockSensitiveSink) {
        sinkLock.lock()
        sinks.append(sink)
        sinkLock.unlock()
    }

    public func unregister(_ sink: LockSensitiveSink) {
        sinkLock.lock()
        sinks.removeAll { $0 === sink }
        sinkLock.unlock()
    }

    public func availability() -> BiometricAvailability {
        authenticator.availability()
    }

    /// - Returns: false when the platform cannot authenticate; the caller must
    ///   show the unavailable reason instead of enabling a weaker local gate.
    @discardableResult
    public func enable(_ delay: LockDelay) -> Bool {
        guard authenticator.availability().canAuthenticate else { return false }
        self.delay = delay
        // Enabling from inside the app leaves it unlocked; the delay applies
        // from the next background transition.
        state = .unlocked
        backgroundedAt = nil
        return true
    }

    public func disable() {
        delay = .standardDefault
        backgroundedAt = nil
        state = .disabled
    }

    public func setDelay(_ delay: LockDelay) {
        guard isEnabled else { return }
        self.delay = delay
    }

    public func onEnterBackground() {
        guard state == .unlocked else { return }
        if delay == .immediate {
            lockNow()
        } else {
            backgroundedAt = clock()
        }
    }

    public func onEnterForeground() {
        guard state == .unlocked else { return }
        guard let since = backgroundedAt else { return }
        if clock() - since >= delay.millis { lockNow() }
        backgroundedAt = nil
    }

    /// Locking hides the UI and clears decrypted secrets; ciphertext at rest
    /// is untouched. Masking the app-switcher snapshot is the host's job: it
    /// subscribes to ``state`` and covers the window, which is UIKit and
    /// therefore lives above this target.
    public func lockNow() {
        guard isEnabled else { return }
        backgroundedAt = nil
        state = .locked
        notifySinks()
    }

    @discardableResult
    public func unlock(title: String, subtitle: String) async -> AuthResult {
        guard state == .locked else { return .success }
        let result = await authenticator.authenticate(title: title, subtitle: subtitle)
        if result == .success { state = .unlocked }
        return result
    }

    /// Sensitive local reveals reuse the platform prompt, but callers must
    /// still hold a main-end grant for the sensitive actions.
    public func confirmLocalReveal(title: String, subtitle: String) async -> AuthResult {
        guard authenticator.availability().canAuthenticate else {
            return .failed(
                availability: authenticator.availability(),
                message: "platform authentication unavailable"
            )
        }
        return await authenticator.authenticate(title: title, subtitle: subtitle)
    }

    /// Unbind and device revoke clear in-memory material regardless of lock
    /// configuration.
    public func clearSensitiveMaterial() {
        notifySinks()
    }

    private func notifySinks() {
        sinkLock.lock()
        let snapshot = sinks
        sinkLock.unlock()
        for sink in snapshot { sink.onLocked() }
    }
}
