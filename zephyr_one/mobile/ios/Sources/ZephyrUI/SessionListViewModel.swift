import Combine
import Foundation

/// The in-memory session registry behind S20.
///
/// Process-local runtime state by design: sessions are not mirrored entities,
/// so there is no sync queue here, and workspace restore never dials
/// (SCREEN_CATALOG.md 7). The registry owns row identity and lifecycle only;
/// transports belong to the engine layer and are reached through the close
/// closure the view model is handed.
public final class SessionRegistry {

    public private(set) var rows: [SessionRow] = []

    private var observers: [() -> Void] = []

    public init() {}

    /// Both the S20 list and an open S21/S22 tab observe the same registry,
    /// so observers are a list rather than a single closure.
    public func addObserver(_ observer: @escaping () -> Void) {
        observers.append(observer)
    }

    private func notifyObservers() {
        for observer in observers { observer() }
    }

    public func row(_ sessionId: String) -> SessionRow? {
        rows.first { $0.sessionId == sessionId }
    }

    /// Inserts or replaces by session id. Row identity survives a reconnect,
    /// which is why this keys on ``SessionRow/sessionId`` rather than
    /// appending blindly.
    public func upsert(_ row: SessionRow) {
        if let index = rows.firstIndex(where: { $0.sessionId == row.sessionId }) {
            rows[index] = row
        } else {
            rows.append(row)
        }
        notifyObservers()
    }

    public func setTransport(_ sessionId: String, _ transport: SessionTransport, _ nowMs: Int64) {
        guard var row = row(sessionId) else { return }
        row.transport = transport
        if transport == .closed && row.endedAt == nil {
            row.endedAt = nowMs
        }
        if transport != .closed {
            row.endedAt = nil
        }
        upsert(row)
    }

    public func setMinimised(_ sessionId: String, _ minimised: Bool) {
        guard var row = row(sessionId) else { return }
        row.minimised = minimised
        upsert(row)
    }

    public func setLatency(_ sessionId: String, _ latencyMs: Int64?) {
        guard var row = row(sessionId) else { return }
        row.latencyMs = latencyMs
        upsert(row)
    }

    public func markUnread(_ sessionId: String) {
        guard var row = row(sessionId), row.transport.isLive else { return }
        row.unreadOutput = true
        upsert(row)
    }

    public func markRead(_ sessionId: String) {
        guard var row = row(sessionId), row.unreadOutput else { return }
        row.unreadOutput = false
        upsert(row)
    }

    /// ACL revocation keeps the row and its explanation but strips
    /// restorability (SCREEN_CATALOG.md 7).
    public func markRevoked(_ sessionId: String, reason: String?) {
        guard var row = row(sessionId) else { return }
        row.revoked = true
        row.revokedReason = reason ?? SessionActions.reasonRevoked
        upsert(row)
    }

    /// Moves the row to history. The caller tears the transport down
    /// afterwards: a socket that hangs on close must not leave a session
    /// sitting in 已连接 that the user cannot get rid of.
    public func close(_ sessionId: String, _ nowMs: Int64) {
        guard var row = row(sessionId), row.transport != .closed else { return }
        row.transport = .closed
        row.minimised = false
        row.unreadOutput = false
        row.endedAt = nowMs
        upsert(row)
    }

    /// Bulk close. The gate decides what is actually closable, so a history
    /// row already in the selection cannot be double-closed.
    ///
    /// - Returns: the session ids that moved to history, so the caller can
    ///   tear down exactly those transports.
    @discardableResult
    public func closeAll(_ nowMs: Int64, sessionIds: Set<String>? = nil) -> [String] {
        let targets = SessionGrouping.closableRows(rows).filter { row in
            sessionIds?.contains(row.sessionId) ?? true
        }
        for target in targets {
            close(target.sessionId, nowMs)
        }
        return targets.map { $0.sessionId }
    }

    public func clearHistory() {
        let kept = rows.filter { $0.transport != .closed }
        if kept.count != rows.count {
            rows = kept
            notifyObservers()
        }
    }

    /// Restores a persisted workspace.
    ///
    /// Every restored row is disconnected and flagged, so the list renders
    /// 断线可恢复 with an explicit reconnect and nothing dials by itself
    /// (SCREEN_CATALOG.md 7). Rows whose connection lost `use` since the
    /// workspace was saved come back revoked rather than silently restorable.
    public func restore(
        _ snapshots: [SessionRow],
        capabilitiesFor: (String) -> CapabilitySet?,
        residencyFor: (String) -> Residency
    ) {
        for snapshot in snapshots where snapshot.transport != .closed {
            var row = snapshot
            row.transport = .disconnected
            row.minimised = false
            row.unreadOutput = false
            row.restoredFromWorkspace = true
            row.residency = residencyFor(snapshot.connectionId)
            if let capabilities = capabilitiesFor(snapshot.connectionId) {
                row.capabilities = capabilities
                if !capabilities.canUse {
                    row.revoked = true
                    row.revokedReason = SessionActions.reasonUseRevoked
                }
            }
            upsert(row)
        }
    }

    /// Live rows only; history would come back as fake tabs.
    public func snapshot() -> [SessionRow] {
        rows.filter { $0.transport != .closed }
    }
}

/// What S20 renders.
///
/// Carries the grouped sections rather than a flat list so the screen cannot
/// regroup and disagree with ``SessionGrouping``. The counts travel with it
/// because the bulk-close confirmation must state a truthful number and the
/// island badge must not count history.
public struct SessionListContent: Equatable, Sendable {
    public let groups: [SessionGroupSection]
    public let liveCount: Int
    public let closableCount: Int
    public let unreadCount: Int
    /// False while offline: a resumable tab cannot dial, so 重连 is disabled
    /// with a reason.
    public let online: Bool

    public init(
        groups: [SessionGroupSection],
        liveCount: Int,
        closableCount: Int,
        unreadCount: Int,
        online: Bool
    ) {
        self.groups = groups
        self.liveCount = liveCount
        self.closableCount = closableCount
        self.unreadCount = unreadCount
        self.online = online
    }

    public var total: Int { groups.reduce(0) { $0 + $1.rows.count } }


}

/// Page state for the session list.
///
/// SCREEN_CATALOG.md 2 requires every list to implement the frozen state
/// contract, but sessions are process-local runtime state rather than
/// mirrored entities, so only a subset can actually occur: there is no
/// pending-sync, no conflict and no permission-denied for the *list* itself.
/// Rather than fabricate unreachable branches, this derives exactly the
/// states that can happen and lets the row gates carry the per-row
/// capability story.
public enum SessionListStates {

    /// - Parameter restoreComplete: false only during app start, while the
    ///   persisted workspace is still being read. Without it an empty
    ///   registry would render 无会话 for a frame and then flash the restored
    ///   tabs in, which reads as a bug.
    public static func derive(
        rows: [SessionRow],
        restoreComplete: Bool,
        online: Bool
    ) -> PageState<SessionListContent> {
        if !restoreComplete { return .initialLoading }
        if rows.isEmpty { return .empty(.noData) }
        return .content(
            SessionListContent(
                groups: SessionGrouping.grouped(rows),
                liveCount: SessionGrouping.liveCount(rows),
                closableCount: SessionGrouping.closableRows(rows).count,
                unreadCount: SessionGrouping.unreadCount(rows),
                online: online
            )
        )
    }
}

/// Where a row action wants to go.
///
/// Navigation is an event rather than a call so the view model never opens a
/// transport: the frozen rule in SCREEN_CATALOG.md 7 is that restoring a
/// workspace connects nothing, and a list that could dial would be one
/// refactor away from breaking it. ``reconnect`` therefore carries an
/// *intent* that the terminal screen acts on after the user is looking at it.
public enum SessionListEvent: Equatable, Sendable {
    case openTerminal(sessionId: String, connectionId: String)
    case openRemote(sessionId: String, connectionId: String)
    case reconnect(sessionId: String, connectionId: String)
    case details(sessionId: String)
}

/// S20 会话列表.
///
/// Owns no transport. Closing a session is delegated to `closeTransport`
/// because the registry is a list of rows, not a list of sockets, and the
/// row must disappear from 已连接 even if the socket teardown fails.
public final class SessionListViewModel: ObservableObject {

    @Published public private(set) var state: PageState<SessionListContent> = .initialLoading
    @Published public private(set) var selection: Set<String> = []
    @Published public private(set) var event: SessionListEvent?
    @Published public private(set) var message: String?

    public let registry: SessionRegistry

    private let closeTransport: (SessionRow) -> Void
    private let clock: () -> Int64
    private var online = true
    private var restoreComplete = false

    public init(
        registry: SessionRegistry,
        closeTransport: @escaping (SessionRow) -> Void = { _ in },
        clock: @escaping () -> Int64 = { 0 }
    ) {
        self.registry = registry
        self.closeTransport = closeTransport
        self.clock = clock
        registry.addObserver { [weak self] in self?.recompute() }
    }

    // ---- snapshot inputs ------------------------------------------------------

    /// Restores the persisted workspace. Called once by the app layer after
    /// the connection mirror has answered, so restored rows can be gated
    /// against current capabilities.
    public func restoreWorkspace(
        _ snapshots: [SessionRow],
        capabilitiesFor: @escaping (String) -> CapabilitySet? = { _ in nil },
        residencyFor: @escaping (String) -> Residency = { _ in .owned }
    ) {
        registry.restore(snapshots, capabilitiesFor: capabilitiesFor, residencyFor: residencyFor)
        restoreComplete = true
        recompute()
    }

    /// No workspace to restore: the list still has to leave initialLoading.
    public func markRestoreComplete() {
        restoreComplete = true
        recompute()
    }

    public func updateConnectivity(online: Bool) {
        self.online = online
        recompute()
    }

    private func recompute() {
        state = SessionListStates.derive(
            rows: registry.rows,
            restoreComplete: restoreComplete,
            online: online
        )
    }

    // ---- row actions -------------------------------------------------------------

    /// A row action.
    ///
    /// The gate is re-checked here rather than trusted from the screen: the
    /// row may have been revoked between the render and the tap, and a
    /// disabled button is a presentation detail, not a permission check.
    public func onAction(_ row: SessionRow, action: SessionAction) {
        let gate = SessionActions.gate(row, action: action)
        if !gate.isAllowed {
            message = reasonOf(gate)
            return
        }
        switch action {
        case .restore:
            registry.markRead(row.sessionId)
            event = navigationFor(row)
        case .reconnect:
            // A resumable tab cannot dial while offline; the button is
            // disabled in the UI and the tap guard explains why.
            guard online else {
                message = SessionListViewModel.msgOfflineReconnect
                return
            }
            registry.markRead(row.sessionId)
            event = .reconnect(sessionId: row.sessionId, connectionId: row.connectionId)
        case .close:
            close(row)
        case .details:
            event = .details(sessionId: row.sessionId)
        }
    }

    private func navigationFor(_ row: SessionRow) -> SessionListEvent {
        if row.`protocol`.isRemoteDesktop {
            return .openRemote(sessionId: row.sessionId, connectionId: row.connectionId)
        }
        return .openTerminal(sessionId: row.sessionId, connectionId: row.connectionId)
    }

    /// Closes one session: the row moves to history first and the transport
    /// is torn down afterwards.
    public func close(_ row: SessionRow) {
        registry.close(row.sessionId, clock())
        selection.remove(row.sessionId)
        closeTransport(row)
    }

    // ---- bulk close ------------------------------------------------------------------------------

    public func toggleSelection(_ sessionId: String) {
        if selection.contains(sessionId) {
            selection.remove(sessionId)
        } else {
            selection.insert(sessionId)
        }
    }

    public func clearSelection() {
        selection = []
    }

    /// Bulk close, after the confirmation the spec requires.
    ///
    /// - Parameter sessionIds: nil closes every closable row.
    public func closeAll(sessionIds: Set<String>? = nil) {
        let rowsBefore = registry.rows
        let closed = registry.closeAll(clock(), sessionIds: sessionIds)
        selection = []
        for sessionId in closed {
            guard let row = rowsBefore.first(where: { $0.sessionId == sessionId }) else { continue }
            closeTransport(row)
        }
    }

    public func clearHistory() {
        registry.clearHistory()
    }

    public func consumeEvent() {
        event = nil
    }

    public func consumeMessage() {
        message = nil
    }

    private func reasonOf(_ gate: ActionGate) -> String {
        switch gate {
        case let .disabled(_, reason): return reason
        case .hidden: return SessionActions.reasonUseRevoked
        case .allowed: return ""
        }
    }

    public static let msgOfflineReconnect = "离线状态下不能重连，恢复网络后重试"
}