import Foundation
import ZephyrContracts

/// The row actions from SCREEN_CATALOG.md 5.
///
/// Modelled as an enum so a screen cannot invent an action that has no gate;
/// ``ConnectionActions`` then owns the single decision table.
public enum ConnectionAction: String, Sendable, CaseIterable {
    case use
    case edit
    case duplicate
    case delete
    case test
    case share
}

/// Capability gating for connection actions.
///
/// SCREEN_CATALOG.md 2 requires a short capability to either hide the action
/// or disable it *with a reason*, never to show an action that fails on tap.
/// The split here follows one rule: an action the user has no business knowing
/// about is hidden, an action that exists but is unavailable for this row is
/// disabled with the reason shown.
public enum ConnectionActions {

    public static func gate(_ connection: Connection, action: ConnectionAction) -> ActionGate {
        switch action {
        case .use:
            return connection.capabilities.canUse ? .allowed : .hidden(missing: .use)

        case .edit:
            return connection.capabilities.canEdit ? .allowed : .hidden(missing: .edit)

        case .duplicate:
            /* Duplicating a shared row would create an owned copy of someone
             * else's material on this device, which SHARED_RESOURCE_RESIDENCY.md
             * forbids. Disabled rather than hidden so the user learns why
             * instead of wondering where the action went. */
            if connection.residency != .owned {
                return .disabled(missing: .edit, reason: reasonSharedNoCopy)
            }
            return connection.capabilities.canEdit ? .allowed : .hidden(missing: .edit)

        case .delete:
            return connection.capabilities.canDelete ? .allowed : .hidden(missing: .delete)

        case .test:
            // Test only needs USE: it opens a transport and closes it, and
            // never writes.
            return connection.capabilities.canUse ? .allowed : .hidden(missing: .use)

        case .share:
            // Re-sharing a resource you do not own is the owner's decision,
            // not the grantee's.
            if connection.residency != .owned {
                return .disabled(missing: .share, reason: reasonSharedNoReshare)
            }
            return connection.capabilities.canShare ? .allowed : .hidden(missing: .share)
        }
    }

    public static func visibleActions(_ connection: Connection) -> [ConnectionAction] {
        ConnectionAction.allCases.filter { gate(connection, action: $0).isVisible }
    }

    /// Shared-connection disclosure.
    ///
    /// SCREEN_CATALOG.md 2.1 bans a vague "安全连接": the user must be told,
    /// before connecting, whether the credential stays on the main end or the
    /// material lands in session memory.
    public static func sharedUseDisclosure(_ connection: Connection) -> String? {
        guard connection.residency == .sharedOnlineOnly else { return nil }
        return connection.sharedUsePolicy.materialTouchesDevice ? disclosureDirect : disclosureRelay
    }

    public static let reasonSharedNoCopy = "共享给你的连接不能复制到本机"
    public static let reasonSharedNoReshare = "只有资源所有者可以再次共享"
    public static let disclosureRelay = "主端 relay：凭据保留在主端"
    public static let disclosureDirect = "本次原生直连：加密连接材料仅驻留会话内存"
}
