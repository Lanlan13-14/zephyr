import Foundation
import ZephyrContracts

/// Events that drive the binding state machine (SYNC_STATE_MACHINE.md 3).
public enum SyncEvent: String, Sendable, CaseIterable {
    case bindSuccess = "bind_success"
    case run = "run"
    case snapshotComplete = "snapshot_complete"
    case bootstrapExpired = "bootstrap_expired"
    case success = "success"
    case trigger = "trigger"
    case conflictOnly = "conflict_only"
    case conflictsResolved = "conflicts_resolved"
    case rebindSuccess = "rebind_success"
    case refreshInvalid = "refresh_invalid"
    case tokenMissing = "token_missing"
    case tokenRotated = "token_rotated"
    case deviceRevoked = "device_revoked"
    case accountUnavailable = "account_unavailable"
    case registryIncompatible = "registry_incompatible"
    case protocolIncompatible = "protocol_incompatible"
    case cursorExpired = "cursor_expired"
    case sidExpired = "sid_expired"

    public var wireName: String { rawValue }

    public static func fromWire(_ value: String) -> SyncEvent? {
        SyncEvent(rawValue: value)
    }
}

/// The binding state machine from SYNC_STATE_MACHINE.md, ported transition for
/// transition from the Kotlin core-model. The transition table is verified
/// against the frozen `sync-cases.json` fixture by ZephyrUITests, so the Swift
/// port cannot drift from the table Kotlin and Node are checked against.
public enum BindingStateMachine {

    private static let transitions: [BindingState: [SyncEvent: BindingState]] = [
        .unbound: [.bindSuccess: .boundNeedsBootstrap],
        .boundNeedsBootstrap: [.run: .bootstrapping],
        .bootstrapping: [
            .snapshotComplete: .catchingUp,
            .bootstrapExpired: .boundNeedsBootstrap,
        ],
        .catchingUp: [.success: .idle],
        .idle: [.trigger: .running],
        .running: [
            .success: .idle,
            .conflictOnly: .conflicted,
        ],
        .conflicted: [
            .conflictsResolved: .idle,
            .trigger: .running,
        ],
        .reauthRequired: [.rebindSuccess: .boundNeedsBootstrap],
        .revoked: [.rebindSuccess: .boundNeedsBootstrap],
    ]

    /// Events that win from any bound state. cursor_expired lands on
    /// BOUND_NEEDS_BOOTSTRAP rather than an error state because the mirror is
    /// still valid; only the cursor is unusable, and pushing must stop until a
    /// fresh snapshot exists.
    private static let boundOverrides: [SyncEvent: BindingState] = [
        .refreshInvalid: .reauthRequired,
        .tokenMissing: .reauthRequired,
        .tokenRotated: .reauthRequired,
        .deviceRevoked: .revoked,
        .accountUnavailable: .revoked,
        .registryIncompatible: .fatalIncompatible,
        .protocolIncompatible: .fatalIncompatible,
        .cursorExpired: .boundNeedsBootstrap,
    ]

    /// SID expiry is a management-plane event only: the data plane keeps
    /// running on the device access credential, so the binding state is
    /// deliberately unchanged.
    public static func next(_ current: BindingState, _ event: SyncEvent) -> BindingState {
        if event == .sidExpired { return current }
        if current != .unbound, let forced = boundOverrides[event] {
            return forced
        }
        return transitions[current]?[event] ?? current
    }

    /// A never-bootstrapped binding must run the snapshot phases before it may
    /// push.
    public static func phasesFor(_ state: BindingState) -> [SyncPhase] {
        if state == .boundNeedsBootstrap || state == .bootstrapping {
            return SyncContract.firstBindPhases
        }
        return SyncContract.normalPhases
    }

    /// "立即同步" stays tappable whenever the device is bound, including while
    /// conflicted or awaiting re-auth: hiding it is an explicit release blocker
    /// in PRODUCT_REQUIREMENTS.md 12.
    public static func canRunManualSync(_ state: BindingState) -> Bool {
        state != .unbound && state != .revoked && state != .fatalIncompatible
    }

    /// Automatic rounds additionally require a binding that can authenticate
    /// unattended. REAUTH_REQUIRED must not burn background retries, but manual
    /// sync still works so the user can surface the re-auth prompt.
    public static func canRunAutomaticSync(_ state: BindingState, automaticEnabled: Bool) -> Bool {
        automaticEnabled && canRunManualSync(state) && state != .reauthRequired
    }

    /// - Parameter jitter: clamped to 0.5..1.5 so a thundering herd cannot
    ///   form, per SYNC_STATE_MACHINE.md 9.
    public static func backoffMs(_ attempt: Int, jitter: Double = 1.0) -> Int64 {
        let steps = SyncContract.retryBackoffMs
        let index = min(max(attempt, 0), steps.count - 1)
        let clamped = min(max(jitter, 0.5), 1.5)
        return Int64((Double(steps[index]) * clamped).rounded())
    }
}
