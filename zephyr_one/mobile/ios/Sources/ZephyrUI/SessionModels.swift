import Foundation
import ZephyrContracts

/// Transport-level session state.
///
/// Deliberately *only* transport: 已最小化 and ACL 已撤销 are orthogonal flags,
/// not transport states, and folding them in would make a minimised-and-
/// disconnected session appear in two S20 groups at once.
public enum SessionTransport: String, Sendable, CaseIterable {
    /// Handshake, auth, host-key decision, jump chain.
    case connecting

    case connected

    /// The transport dropped but the session record survives, so 重连 is
    /// offered. Distinct from ``closed`` because a closed session is history
    /// and must never offer a reconnect that silently makes a new session
    /// (SCREEN_CATALOG.md 7).
    case disconnected

    /// Ended by the user, by the peer, or by a fatal error. Terminal.
    case closed

    public var isLive: Bool { self == .connecting || self == .connected }
}

/// The five S20 groups, in the frozen render order.
public enum SessionGroup: String, Sendable, CaseIterable {
    case connecting
    case connected
    case resumable
    case minimised
    case history

    public var title: String {
        switch self {
        case .connecting: return "连接中"
        case .connected: return "已连接"
        case .resumable: return "断线可恢复"
        case .minimised: return "已最小化"
        case .history: return "历史任务"
        }
    }
}

/// Where the bytes actually flow (SCREEN_CATALOG.md 7: 本地/主端执行).
public enum SessionExecution: String, Sendable, CaseIterable {
    /// Native transport opened by this device.
    case local

    /// Main-end relay; credentials stay on the server.
    case relay
}

/// One row of the S20 session list.
///
/// A value type with no engine handle: the list must render a session whose
/// engine is blocked or already gone, and a row holding a live transport
/// reference would keep a dead session's buffers alive.
public struct SessionRow: Equatable, Sendable, Identifiable {
    /// Stable for the lifetime of the row, including across a reconnect, so
    /// the S20 row and the terminal tab cannot disagree about identity.
    public var sessionId: String
    public var connectionId: String
    public var `protocol`: ConnectionProtocol
    public var name: String
    public var host: String
    public var port: Int
    public var transport: SessionTransport
    public var execution: SessionExecution
    public var capabilities: CapabilitySet
    public var residency: Residency
    public var minimised: Bool
    public var revoked: Bool
    /// Set together with ``revoked``. The frozen wire value is
    /// `resource_revoked`, and the row keeps explaining itself after it stops
    /// being restorable.
    public var revokedReason: String?
    public var startedAt: Int64
    public var endedAt: Int64?
    /// Last measured round trip. Nil while connecting or once the transport
    /// is gone.
    public var latencyMs: Int64?
    /// Unread output since the user last looked, for the session badge.
    public var unreadOutput: Bool
    /// True when this row came back from a persisted workspace and has never
    /// been connected in this process.
    public var restoredFromWorkspace: Bool
    public var detail: String?

    public init(
        sessionId: String,
        connectionId: String,
        `protocol`: ConnectionProtocol,
        name: String,
        host: String,
        port: Int,
        transport: SessionTransport,
        execution: SessionExecution = .local,
        capabilities: CapabilitySet = .owner,
        residency: Residency = .owned,
        minimised: Bool = false,
        revoked: Bool = false,
        revokedReason: String? = nil,
        startedAt: Int64 = 0,
        endedAt: Int64? = nil,
        latencyMs: Int64? = nil,
        unreadOutput: Bool = false,
        restoredFromWorkspace: Bool = false,
        detail: String? = nil
    ) {
        self.sessionId = sessionId
        self.connectionId = connectionId
        self.`protocol` = `protocol`
        self.name = name
        self.host = host
        self.port = port
        self.transport = transport
        self.execution = execution
        self.capabilities = capabilities
        self.residency = residency
        self.minimised = minimised
        self.revoked = revoked
        self.revokedReason = revokedReason
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.latencyMs = latencyMs
        self.unreadOutput = unreadOutput
        self.restoredFromWorkspace = restoredFromWorkspace
        self.detail = detail
    }

    public var id: String { sessionId }

    public var displayAddress: String { host + ":" + String(port) }

    /// Which group the row belongs to.
    ///
    /// Checked in a fixed order so every row lands in exactly one group.
    /// History wins over minimised because a closed session is no longer a
    /// live tab, and minimised wins over disconnected because the user's own
    /// explicit action is the more informative fact.
    public var group: SessionGroup {
        if transport == .closed { return .history }
        if minimised { return .minimised }
        if transport == .disconnected { return .resumable }
        if transport == .connecting { return .connecting }
        return .connected
    }

    /// A revoked tab is explicitly *not* restorable: the frozen rule is that
    /// it keeps its explanation and loses its actions.
    public var restorable: Bool { !revoked && transport != .closed }

    /// Wall-clock duration, for the row's 延迟/时长 column.
    public func durationMs(_ nowMs: Int64) -> Int64 {
        (endedAt ?? nowMs) - startedAt
    }
}

/// The row actions from SCREEN_CATALOG.md 7.
public enum SessionAction: String, Sendable, CaseIterable {
    /// Bring a minimised or backgrounded tab back to the foreground. Opens
    /// no transport.
    case restore

    /// Open a new transport for a dropped session, keeping the same row
    /// identity.
    case reconnect

    case close

    case details
}

/// Capability and state gating for session rows.
///
/// The two interesting rules both come from SCREEN_CATALOG.md 7: a revoked
/// tab is disabled *with its reason* rather than hidden, and 恢复 is not the
/// same action as 重连 -- conflating them is how a "restore" ends up dialling
/// a host the user did not ask to dial.
public enum SessionActions {

    public static func gate(_ row: SessionRow, action: SessionAction) -> ActionGate {
        switch action {
        case .restore:
            // Restoring is a pure UI move: it needs no capability, only a
            // live-or-resumable row.
            if row.revoked {
                return .disabled(missing: .use, reason: reasonFor(row))
            }
            if row.transport == .closed {
                return .hidden(missing: .use)
            }
            return .allowed

        case .reconnect:
            // Reconnecting opens a transport, so the grant must still be
            // there. A revoked grant is the common case and gets the explicit
            // reason rather than a vanished button.
            if row.revoked {
                return .disabled(missing: .use, reason: reasonFor(row))
            }
            if !row.capabilities.canUse {
                return .disabled(missing: .use, reason: reasonUseRevoked)
            }
            if row.transport == .connected || row.transport == .connecting {
                return .hidden(missing: .use)
            }
            return .allowed

        case .close:
            // Always permitted on a live row: the user must be able to end a
            // session even after the grant is gone, otherwise a revoked tab
            // could not be dismissed.
            return row.transport == .closed ? .hidden(missing: .use) : .allowed

        case .details:
            return .allowed
        }
    }

    public static func visibleActions(_ row: SessionRow) -> [SessionAction] {
        SessionAction.allCases.filter { gate(row, action: $0).isVisible }
    }

    /// Disclosure for a shared session, mirroring the connection-library
    /// wording so the same connection is not described one way before
    /// connecting and another way afterwards (SCREEN_CATALOG.md 2.1).
    public static func executionDisclosure(_ row: SessionRow) -> String? {
        guard row.residency == .sharedOnlineOnly else { return nil }
        switch row.execution {
        case .relay: return disclosureRelay
        case .local: return disclosureDirect
        }
    }

    static func reasonFor(_ row: SessionRow) -> String {
        row.revokedReason ?? reasonRevoked
    }

    /// The frozen wire reason for a revoked tab.
    public static let wireResourceRevoked = "resource_revoked"

    public static let reasonRevoked = "资源权限已撤销，此标签保留说明但不能恢复"
    public static let reasonUseRevoked = "已失去该连接的使用权限"
    public static let disclosureRelay = "主端 relay：凭据保留在主端"
    public static let disclosureDirect = "本次原生直连：加密连接材料仅驻留会话内存"
}

/// Grouping for the S20 list.
/// One rendered section of the S20 list. A nominal type rather than a tuple
/// so SwiftUI can key a `ForEach` on it.
public struct SessionGroupSection: Equatable, Sendable, Identifiable {
    public let group: SessionGroup
    public let rows: [SessionRow]

    public init(group: SessionGroup, rows: [SessionRow]) {
        self.group = group
        self.rows = rows
    }

    public var id: SessionGroup { group }
}

public enum SessionGrouping {

    /// Groups and orders the rows.
    ///
    /// Live rows sort oldest-first so a long-running session keeps its place
    /// instead of jumping whenever a new one appears; history sorts
    /// newest-first because the most recently closed session is the one a
    /// user looks for.
    public static func grouped(_ rows: [SessionRow]) -> [SessionGroupSection] {
        var result: [SessionGroupSection] = []
        for group in SessionGroup.allCases {
            let bucket = rows.filter { $0.group == group }
            if bucket.isEmpty { continue }
            let ordered: [SessionRow]
            if group == .history {
                ordered = bucket.sorted { ($0.endedAt ?? $0.startedAt) > ($1.endedAt ?? $1.startedAt) }
            } else {
                ordered = bucket.sorted { $0.startedAt < $1.startedAt }
            }
            result.append(SessionGroupSection(group: group, rows: ordered))
        }
        return result
    }

    public static func liveCount(_ rows: [SessionRow]) -> Int {
        rows.filter { $0.transport.isLive }.count
    }

    /// Rows a bulk close would actually affect, so the confirmation can
    /// state a real number.
    public static func closableRows(_ rows: [SessionRow]) -> [SessionRow] {
        rows.filter { SessionActions.gate($0, action: .close).isAllowed }
    }

    public static func unreadCount(_ rows: [SessionRow]) -> Int {
        rows.filter { $0.unreadOutput && $0.transport.isLive }.count
    }
}