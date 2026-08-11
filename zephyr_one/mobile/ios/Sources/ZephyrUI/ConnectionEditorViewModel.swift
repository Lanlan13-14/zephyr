import Combine
import Foundation
import ZephyrContracts

/// Everything the S11 form renders.
public struct ConnectionEditorUiState: Equatable, Sendable {
    public var draft: ConnectionDraft
    public var inventory: RouteInventory
    public var proxies: [Proxy]
    public var sshKeys: [SshKey]
    public var jumpHosts: [JumpHost]
    /// Populated only after a save attempt, so a pristine form is not covered
    /// in red.
    public var issues: [DraftIssue]
    public var saving: Bool
    public var testing: Bool
    public var testResult: ConnectionTestResult?

    public init(
        draft: ConnectionDraft,
        inventory: RouteInventory = RouteInventory(),
        proxies: [Proxy] = [],
        sshKeys: [SshKey] = [],
        jumpHosts: [JumpHost] = [],
        issues: [DraftIssue] = [],
        saving: Bool = false,
        testing: Bool = false,
        testResult: ConnectionTestResult? = nil
    ) {
        self.draft = draft
        self.inventory = inventory
        self.proxies = proxies
        self.sshKeys = sshKeys
        self.jumpHosts = jumpHosts
        self.issues = issues
        self.saving = saving
        self.testing = testing
        self.testResult = testResult
    }

    public var sections: [EditorSection] { draft.sections() }

    /// Route repair is shown while editing, because it reflects revoked access
    /// rather than typing.
    public var routeIssues: [DraftIssue] { draft.routeIssues(inventory: inventory) }

    public func issueFor(field: String) -> DraftIssue? {
        issues.first { $0.field == field } ?? routeIssues.first { $0.field == field }
    }
}

/// What the editor asks the host navigation to do.
public enum ConnectionEditorEvent: Equatable, Sendable {
    case dismissed

    /// - Parameter persisted: false for 不保存直接连接, where the connection
    ///   exists only for this session and must never be written to the mirror
    ///   (ZEPHYR_PARITY.md 5.1 ephemeral).
    case connect(connection: Connection, persisted: Bool)
}

/// S11 连接编辑器.
///
/// All editing rules live in ``ConnectionDraft``; this class only owns loading,
/// the route inventory and the save/test side effects. Keeping the rules out
/// of the view model is what makes them testable without a run loop.
@MainActor
public final class ConnectionEditorViewModel: ObservableObject, LockSensitiveSink {

    @Published public private(set) var page: PageState<ConnectionEditorUiState> = .initialLoading
    @Published public private(set) var event: ConnectionEditorEvent?
    @Published public private(set) var message: String?
    @Published public private(set) var sensitiveClearGeneration: UInt64 = 0

    private let connections: ConnectionStore
    private let ownerUserId: String
    private let connectionId: String?
    private let newId: () -> String
    private let tester: ConnectionTester
    private let clock: () -> Int64
    private weak var appLock: AppLock?

    public init(
        connections: ConnectionStore,
        ownerUserId: String,
        connectionId: String?,
        newId: @escaping () -> String,
        tester: ConnectionTester = UnavailableConnectionTester(),
        clock: @escaping () -> Int64 = { 0 }
    ) {
        self.connections = connections
        self.ownerUserId = ownerUserId
        self.connectionId = connectionId
        self.newId = newId
        self.tester = tester
        self.clock = clock
    }

    public func attachSensitiveLifecycle(to appLock: AppLock) {
        guard self.appLock !== appLock else { return }
        self.appLock?.unregister(self)
        self.appLock = appLock
        appLock.register(self)
    }

    public func detachSensitiveLifecycle() {
        clearSensitiveMaterial()
        appLock?.unregister(self)
        appLock = nil
    }

    public func onLocked() {
        clearSensitiveMaterial()
    }

    public func clearSensitiveMaterial() {
        mutate {
            var copy = $0
            copy.draft.password = .unchanged
            copy.draft.privateKey = .unchanged
            return copy
        }
        // The view observes this even when the draft was not loaded, ensuring
        // its independent SecureField String copies are dropped as well.
        sensitiveClearGeneration &+= 1
    }

    public func load() {
        guard let connectionId else {
            page = .content(
                ConnectionEditorUiState(draft: ConnectionDraft.create(ownerUserId: ownerUserId, connectionId: newId()))
            )
            return
        }
        let existing = connections.find(connectionId)
        if existing == nil || existing?.isDeleted == true {
            page = .notFoundOrRevoked
        } else if let row = existing, !row.capabilities.canEdit {
            // A row the user may see but not edit opens read-only rather than
            // pretending to save.
            page = .permissionDenied(missing: .edit, reason: ConnectionEditorViewModel.reasonNoEdit)
        } else if let row = existing {
            page = .content(ConnectionEditorUiState(draft: ConnectionDraft.edit(row)))
        }
    }

    /// Only rows carrying USE may be referenced by a route
    /// (ZEPHYR_PARITY.md 5.3).
    ///
    /// Applied as an observation rather than read once: an ACL revocation
    /// while the editor is open must turn into "路由需要修复" instead of a
    /// save-time surprise.
    public func applyInventory(proxies: [Proxy], sshKeys: [SshKey], jumpHosts: [JumpHost]) {
        let usable = RouteInventory(
            usableProxyIds: Set(proxies.filter { $0.capabilities.canUse && $0.deletedAt == nil }.map { $0.id }),
            usableSshKeyIds: Set(sshKeys.filter { $0.capabilities.canUse && $0.deletedAt == nil }.map { $0.id }),
            usableJumpHostIds: Set(jumpHosts.filter { $0.capabilities.canUse && $0.deletedAt == nil }.map { $0.id })
        )
        mutate {
            var copy = $0
            copy.inventory = usable
            copy.proxies = proxies
            copy.sshKeys = sshKeys
            copy.jumpHosts = jumpHosts
            return copy
        }
    }

    private func mutate(_ block: (ConnectionEditorUiState) -> ConnectionEditorUiState) {
        guard case let .content(value, pendingSync, conflict, savingLocal) = page else { return }
        page = .content(
            value: block(value),
            pendingSync: pendingSync,
            conflict: conflict,
            savingLocal: savingLocal
        )
    }

    private func edit(_ block: (ConnectionDraft) -> ConnectionDraft) {
        // Clearing stale issues on every keystroke keeps a fixed field from
        // staying red until the next save attempt.
        mutate {
            var copy = $0
            copy.draft = block(copy.draft)
            copy.issues = []
            copy.testResult = nil
            return copy
        }
    }

    public var draft: ConnectionDraft? {
        guard case let .content(value, _, _, _) = page else { return nil }
        return value.draft
    }

    // ---- field intents -----------------------------------------------------------

    public func setName(_ value: String) { edit { $0.withName(value) } }
    public func setHost(_ value: String) { edit { $0.withHost(value) } }
    public func setUsername(_ value: String) { edit { $0.withUsername(value) } }
    public func setRemark(_ value: String) { edit { $0.withRemark(value) } }
    public func setTags(_ value: [String]) { edit { $0.withTags(value) } }
    public func setProtocol(_ value: ConnectionProtocol) { edit { $0.withProtocol(value) } }
    public func setConnectionMode(_ value: ConnectionMode) { edit { $0.withConnectionMode(value) } }
    public func setEncoding(_ value: TerminalEncoding) { edit { $0.withEncoding(value) } }
    public func setProxy(_ value: String?) { edit { $0.withProxy(value) } }
    public func setSshKey(_ value: String?) { edit { $0.withSshKey(value) } }
    public func setFileSyncIntent(_ value: FileSyncDirectoryIntent) { edit { $0.withFileSyncIntent(value) } }
    public func setPassword(_ value: SecretState) { edit { $0.withPassword(value) } }
    public func setPrivateKey(_ value: SecretState) { edit { $0.withPrivateKey(value) } }
    public func setRdp(_ value: RdpSettings) { edit { $0.withRdp(value) } }
    public func setVisibility(_ value: String) { edit { $0.withVisibility(value) } }
    public func addJumpHost(_ value: String) { edit { $0.withJumpHostAdded(value) } }
    public func removeJumpHost(_ value: String) { edit { $0.withJumpHostRemoved(value) } }
    public func moveJumpHost(from: Int, to: Int) { edit { $0.withJumpHostMoved(from: from, to: to) } }

    /// Non-numeric input leaves the port untouched rather than resetting it to
    /// zero.
    public func setPort(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard let parsed = Int(trimmed) else { return }
        edit { $0.withPort(parsed) }
    }

    /// Clears a dependency the user no longer has access to.
    public func repairRoute(_ field: String) {
        edit { current in
            switch field {
            case "proxyId":
                return current.withProxy(nil)
            case "sshKeyId":
                return current.withSshKey(nil)
            case "jumpHostIds":
                var copy = current
                copy.current.jumpHostIds = []
                return copy
            default:
                return current
            }
        }
    }

    // ---- fixed actions -------------------------------------------------------------

    /// 保存 / 保存并连接.
    ///
    /// The completion wording is local-first ("已保存，待同步"): the row is
    /// committed to this device and an operation is queued, which is exactly
    /// what happened regardless of connectivity (SCREEN_CATALOG.md 2).
    public func save(thenConnect: Bool = false) async {
        guard case let .content(ui, _, _, _) = page else { return }
        let issues = ui.draft.validate(inventory: ui.inventory)
        guard issues.isEmpty else {
            mutate {
                var copy = $0
                copy.issues = issues
                return copy
            }
            return
        }
        let row = ui.draft.normalized()
        mutate {
            var copy = $0
            copy.saving = true
            return copy
        }
        let mask = ui.draft.changedFields()
        let secrets = ui.draft.secretStates()
        let hasSecretChange = secrets.values.contains { $0.contributesToFieldMask }
        do {
            /* An empty mask with no secret change would be rejected as
             * empty_field_mask, so the overlay-only case (the user changed
             * nothing but the device-local directory intent) deliberately
             * skips the gateway instead of failing. */
            if !mask.isEmpty || hasSecretChange {
                try await connections.save(
                    connection: row,
                    mask: mask,
                    secrets: secrets,
                    ownerUserId: ownerUserId,
                    createdLocally: ui.draft.isCreate
                )
            }
            if ui.draft.fileSyncIntentChanged {
                try await connections.setFileSyncIntent(row.id, row.fileSyncIntent, clock())
            }
            mutate {
                var copy = $0
                copy.saving = false
                // The saved row becomes the new baseline so the form is no
                // longer dirty.
                copy.draft = ConnectionDraft.edit(row)
                return copy
            }
            clearSensitiveMaterial()
            message = ConnectionEditorViewModel.msgSaved
            event = thenConnect ? .connect(connection: row, persisted: true) : .dismissed
        } catch {
            mutate {
                var copy = $0
                copy.saving = false
                return copy
            }
            if let rejected = error as? LocalWriteRejected {
                message = ConnectionEditorViewModel.rejectionMessage(rejected)
            } else {
                message = ConnectionEditorViewModel.msgSaveFailed
            }
        }
    }

    private static func rejectionMessage(_ rejected: LocalWriteRejected) -> String {
        switch rejected.reason {
        case "capability_denied":
            return reasonNoEdit
        case "empty_field_mask":
            return msgNothingChanged
        default:
            return msgSaveFailed
        }
    }

    /// 不保存直接连接.
    ///
    /// Marked ephemeral so nothing reaches the mirror: the connection lives
    /// for this session and is cleaned up after the frozen TTL.
    public func connectWithoutSaving() {
        guard case let .content(ui, _, _, _) = page else { return }
        let issues = ui.draft.validate(inventory: ui.inventory)
        guard issues.isEmpty else {
            mutate {
                var copy = $0
                copy.issues = issues
                return copy
            }
            return
        }
        var row = ui.draft.normalized()
        row.ephemeral = true
        event = .connect(connection: row, persisted: false)
        clearSensitiveMaterial()
    }

    public func test() async {
        guard case let .content(ui, _, _, _) = page else { return }
        let issues = ui.draft.validate(inventory: ui.inventory)
        guard issues.isEmpty else {
            mutate {
                var copy = $0
                copy.issues = issues
                return copy
            }
            return
        }
        mutate {
            var copy = $0
            copy.testing = true
            copy.testResult = nil
            return copy
        }
        let row = ui.draft.normalized()
        let result: ConnectionTestResult
        do {
            result = try await tester.test(row)
        } catch {
            result = .failed(
                MobileError.local(
                    code: "test_failed",
                    message: ConnectionEditorViewModel.msgTestFailed,
                    retryable: true
                )
            )
        }
        mutate {
            var copy = $0
            copy.testing = false
            copy.testResult = result
            return copy
        }
    }

    public func dismiss() {
        clearSensitiveMaterial()
        event = .dismissed
    }

    public func consumeEvent() {
        event = nil
    }

    public func consumeMessage() {
        message = nil
    }

    public static let reasonNoEdit = "你没有编辑此连接的权限"
    public static let msgSaved = "已保存，待同步"
    public static let msgSaveFailed = "保存未完成，请重试"
    public static let msgNothingChanged = "没有需要保存的修改"
    public static let msgTestFailed = "测试未完成"
}
