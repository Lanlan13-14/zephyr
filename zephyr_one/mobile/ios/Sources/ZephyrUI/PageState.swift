import Foundation
import ZephyrContracts

/// Every list, detail and editor screen implements this contract (SCREEN_CATALOG.md 2).
///
/// A direct port of the Kotlin `PageState` in core-model. Modelling it as a type
/// stops screens from inventing partial state sets, and keeping it free of any
/// SwiftUI dependency is what lets `swift test` exercise every screen's state
/// derivation on the macOS CI runner, where UIKit does not exist.
public enum PageState<Value> {
    case initialLoading

    case content(value: Value, pendingSync: Bool, conflict: Bool, savingLocal: Bool)

    case empty(EmptyReason)

    /// Owned data has a local mirror, so offline still shows content.
    case offlineWithCache(value: Value, lastSyncedAt: Int64?)

    /// Shared-to-me resources have no mirror, so offline is terminal for them
    /// (SHARED_RESOURCE_RESIDENCY.md).
    case offlineNoCache

    case permissionDenied(missing: Capability, reason: String?)

    case notFoundOrRevoked

    case retryableError(MobileError)

    case fatalIncompatible(MobileError)

    /// The flags Kotlin gives default arguments; enum cases cannot carry
    /// defaults in Swift, so the convenience lives here.
    public static func content(
        _ value: Value,
        pendingSync: Bool = false,
        conflict: Bool = false,
        savingLocal: Bool = false
    ) -> PageState<Value> {
        .content(value: value, pendingSync: pendingSync, conflict: conflict, savingLocal: savingLocal)
    }

    public var isTerminal: Bool {
        switch self {
        case .notFoundOrRevoked, .fatalIncompatible, .offlineNoCache:
            return true
        default:
            return false
        }
    }
}

extension PageState: Equatable where Value: Equatable {}
extension PageState: Sendable where Value: Sendable {}

public enum EmptyReason: String, Sendable, CaseIterable {
    case noData
    case noMatchingFilter
    case notYetSynced
}

/// Capability gate outcome for a single action.
public enum ActionGate: Equatable, Sendable {
    case allowed

    /// Hidden entirely: the user has no business knowing the action exists.
    case hidden(missing: Capability)

    /// Visible but disabled, with a reason the UI must show.
    case disabled(missing: Capability, reason: String)

    public var isAllowed: Bool {
        if case .allowed = self { return true }
        return false
    }

    public var isVisible: Bool {
        if case .hidden = self { return false }
        return true
    }
}
