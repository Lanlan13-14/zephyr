import Foundation

/// The eight S11 sections, in the frozen order.
///
/// SCREEN_CATALOG.md 6 fixes the order, so it lives in an enum rather than in
/// the view: a screen that renders ``EditorSection/allCases`` cannot silently
/// reorder or drop one.
public enum EditorSection: String, Sendable, CaseIterable {
    case basic
    case auth
    case route
    case rdpChannels
    case rdpDisplay
    case fileSync
    case metadata
}

/// One validation failure, tied to the field that caused it so the editor can
/// scroll to it.
public struct DraftIssue: Equatable, Sendable {
    public let field: String
    public let message: String

    public init(field: String, message: String) {
        self.field = field
        self.message = message
    }
}

/// Which route dependencies the current user may actually select.
///
/// ZEPHYR_PARITY.md 5.3 requires a dependency to exist *and* carry USE before
/// a connection may reference it. Passing the usable ids in keeps
/// ``ConnectionDraft`` pure: the repository resolves capability, the draft
/// only decides what that means for this edit.
public struct RouteInventory: Equatable, Sendable {
    public var usableProxyIds: Set<String>
    public var usableSshKeyIds: Set<String>
    public var usableJumpHostIds: Set<String>

    public init(
        usableProxyIds: Set<String> = [],
        usableSshKeyIds: Set<String> = [],
        usableJumpHostIds: Set<String> = []
    ) {
        self.usableProxyIds = usableProxyIds
        self.usableSshKeyIds = usableSshKeyIds
        self.usableJumpHostIds = usableJumpHostIds
    }
}

/// The S11 editor state.
///
/// Holds `original` alongside `current` because almost every rule in the
/// section depends on the difference between them: the fieldMask is a diff,
/// "unsaved changes" is a diff, and a masked secret is precisely a field that
/// must *not* be diffed. A draft that only carried the edited values could not
/// tell "user cleared the password" from "user never touched it".
public struct ConnectionDraft: Equatable, Sendable {

    /// nil when creating. A create pushes the whole editable field set,
    /// because the server has no row to merge against.
    public var original: Connection?
    public var current: Connection

    /// Once true, switching protocol stops moving the port
    /// (ZEPHYR_PARITY.md 5.1).
    public var portWasEdited: Bool
    public var password: SecretState
    public var privateKey: SecretState

    public init(
        original: Connection?,
        current: Connection,
        portWasEdited: Bool = false,
        password: SecretState = .unchanged,
        privateKey: SecretState = .unchanged
    ) {
        self.original = original
        self.current = current
        self.portWasEdited = portWasEdited
        self.password = password
        self.privateKey = privateKey
    }

    public var isCreate: Bool { original == nil }

    /// True when leaving the editor would lose work.
    ///
    /// SCREEN_CATALOG.md 6 requires a confirmation on back with unsaved
    /// changes, so this has to include the secret tri-state: replacing a
    /// password and changing nothing else is still work.
    public var isDirty: Bool {
        isCreate ||
            current != original ||
            password.contributesToFieldMask ||
            privateKey.contributesToFieldMask
    }

    /// Device-local directory intent, which the frozen entity registry does
    /// not publish as a syncable field. Tracked separately from
    /// ``changedFields()`` so it can never enter a fieldMask.
    public var fileSyncIntentChanged: Bool {
        original == nil || original?.fileSyncIntent != current.fileSyncIntent
    }

    // ---- editing ----------------------------------------------------------------

    /// Protocol switch.
    ///
    /// Delegates the field clearing to ``Connection/withProtocol(_:portWasEdited:)``
    /// so the rule lives in one place, and adds the secret half: dropping to
    /// Telnet clears a stored private key rather than leaving an unreachable
    /// secret behind, while the in-band password survives (SCREEN_CATALOG.md 6).
    public func withProtocol(_ next: ConnectionProtocol) -> ConnectionDraft {
        if next == current.`protocol` { return self }
        let moved = current.withProtocol(next, portWasEdited: portWasEdited)
        let nextPrivateKey: SecretState
        if next == .telnet && hadStoredPrivateKey() {
            nextPrivateKey = .clear
        } else if next == .telnet {
            nextPrivateKey = .unchanged
        } else {
            nextPrivateKey = privateKey
        }
        var copy = self
        copy.current = moved
        copy.privateKey = nextPrivateKey
        return copy
    }

    private func hadStoredPrivateKey() -> Bool {
        original?.privateKey.hasValue == true || isReplacing(privateKey)
    }

    private func isReplacing(_ state: SecretState) -> Bool {
        if case .replace = state { return true }
        return false
    }

    public func withConnectionMode(_ next: ConnectionMode) -> ConnectionDraft {
        var copy = self
        copy.current = current.withConnectionMode(next)
        return copy
    }

    /// Marks the port as user-owned, which freezes it against later protocol
    /// switches.
    public func withPort(_ port: Int) -> ConnectionDraft {
        var copy = self
        copy.current.port = port
        copy.portWasEdited = true
        return copy
    }

    public func withName(_ name: String) -> ConnectionDraft {
        var copy = self
        copy.current.name = name
        return copy
    }

    public func withHost(_ host: String) -> ConnectionDraft {
        var copy = self
        copy.current.host = host
        return copy
    }

    public func withUsername(_ username: String) -> ConnectionDraft {
        var copy = self
        copy.current.username = username
        return copy
    }

    public func withRemark(_ remark: String) -> ConnectionDraft {
        var copy = self
        copy.current.remark = remark
        return copy
    }

    public func withTags(_ tags: [String]) -> ConnectionDraft {
        var copy = self
        copy.current.tags = tags
        return copy
    }

    public func withEncoding(_ encoding: TerminalEncoding) -> ConnectionDraft {
        var copy = self
        copy.current.encoding = encoding
        return copy
    }

    public func withProxy(_ proxyId: String?) -> ConnectionDraft {
        var copy = self
        copy.current.proxyId = proxyId
        return copy
    }

    public func withSshKey(_ sshKeyId: String?) -> ConnectionDraft {
        var copy = self
        copy.current.sshKeyId = sshKeyId
        return copy
    }

    public func withRdp(_ settings: RdpSettings) -> ConnectionDraft {
        var copy = self
        copy.current.rdp = settings
        return copy
    }

    public func withVisibility(_ visibility: String) -> ConnectionDraft {
        var copy = self
        copy.current.visibility = visibility
        return copy
    }

    public func withFileSyncIntent(_ intent: FileSyncDirectoryIntent) -> ConnectionDraft {
        var copy = self
        copy.current.fileSyncIntent = intent
        return copy
    }

    /// Appends one hop.
    ///
    /// Duplicates are refused rather than deduplicated silently, because a
    /// jump chain is ordered and dropping a repeat would quietly change the
    /// route the user described.
    public func withJumpHostAdded(_ jumpHostId: String) -> ConnectionDraft {
        if current.jumpHostIds.contains(jumpHostId) { return self }
        if current.jumpHostIds.count >= Connection.maxJumpDepth { return self }
        var copy = self
        copy.current.jumpHostIds.append(jumpHostId)
        return copy
    }

    public func withJumpHostRemoved(_ jumpHostId: String) -> ConnectionDraft {
        var copy = self
        copy.current.jumpHostIds.removeAll { $0 == jumpHostId }
        return copy
    }

    /// Reorders one hop. Out-of-range targets are clamped so a drag cannot
    /// throw.
    public func withJumpHostMoved(from: Int, to: Int) -> ConnectionDraft {
        let chain = current.jumpHostIds
        guard chain.indices.contains(from) else { return self }
        let target = min(max(to, 0), chain.count - 1)
        if from == target { return self }
        var copy = self
        let hop = copy.current.jumpHostIds.remove(at: from)
        copy.current.jumpHostIds.insert(hop, at: target)
        return copy
    }

    /// Secret tri-state.
    ///
    /// A blank replacement is folded to ``SecretState/clear``: the user emptied
    /// the field, and sending an empty plaintext as a new secret would store a
    /// credential that cannot authenticate.
    public func withPassword(_ state: SecretState) -> ConnectionDraft {
        var copy = self
        copy.password = ConnectionDraft.foldSecret(state)
        return copy
    }

    public func withPrivateKey(_ state: SecretState) -> ConnectionDraft {
        var copy = self
        copy.privateKey = ConnectionDraft.foldSecret(state)
        return copy
    }

    private static func foldSecret(_ state: SecretState) -> SecretState {
        if case let .replace(plaintext) = state,
           plaintext.trimmingCharacters(in: .whitespaces).isEmpty {
            return .clear
        }
        return state
    }

    // ---- normalisation and mask ---------------------------------------------------

    /// The row to persist.
    ///
    /// Trims the host (ZEPHYR_PARITY.md 5.1) and drops blank tags while
    /// preserving order and any unknown Unicode. Repeated tags collapse to
    /// their first occurrence: a duplicate chip is an input artefact, not user
    /// intent, and the server stores a set-like array.
    ///
    /// An ephemeral connection with no name gets one derived from protocol and
    /// host, which is the documented fallback for a deep-link connection that
    /// the user never named.
    public func normalized() -> Connection {
        let trimmedHost = current.host.trimmingCharacters(in: .whitespaces)
        var seen: Set<String> = []
        let tags = current.tags
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .filter { seen.insert($0).inserted }
        var trimmedName = current.name.trimmingCharacters(in: .whitespaces)
        if trimmedName.isEmpty && current.ephemeral {
            trimmedName = current.`protocol`.wireName + " " + trimmedHost
        }
        var copy = current
        copy.name = trimmedName
        copy.host = trimmedHost
        copy.username = current.username.trimmingCharacters(in: .whitespaces)
        copy.tags = tags
        copy.rdp.domain = current.rdp.domain.trimmingCharacters(in: .whitespaces)
        return copy
    }

    /// The fieldMask for this save.
    ///
    /// A create names every field the protocol actually uses, because the
    /// server is building a new row. An edit names only what changed, which is
    /// what keeps a concurrent edit of a different field from turning into a
    /// conflict (SYNC_STATE_MACHINE.md 4.3).
    ///
    /// The device-local directory intent is deliberately absent: the frozen
    /// registry publishes it in neither editableFields nor deviceLocalFields,
    /// so it is stored on the device only.
    public func changedFields() -> [String] {
        let applicable = ConnectionDraft.fieldsFor(current.`protocol`)
        guard let base = original else { return applicable }
        let candidate = normalized()
        let readers = ConnectionDraft.fieldReadersByName
        return applicable.filter { field in
            /* A field with no reader is simply never masked, which fails
             * closed. */
            guard let read = readers[field] else { return false }
            return read(candidate) != read(base)
        }
    }

    /// Secret states keyed by registry field name, for the repository call.
    public func secretStates() -> [String: SecretState] {
        var states: [String: SecretState] = ["password": password]
        // Telnet has no key auth, so a private-key state would be meaningless
        // there other than a clear, which withProtocol already produced.
        if current.`protocol` != .telnet || privateKey == .clear {
            states["privateKey"] = privateKey
        }
        return states
    }

    // ---- validation ----------------------------------------------------------------

    /// Client-side validation.
    ///
    /// The server is authoritative, so this only enforces the rules that are
    /// frozen in ZEPHYR_PARITY.md 5.1 and the ones that would otherwise produce
    /// a guaranteed server rejection. No invented length caps: a limit One
    /// made up would reject input Zephyr accepts.
    public func validate(inventory: RouteInventory = RouteInventory()) -> [DraftIssue] {
        let candidate = normalized()
        var issues: [DraftIssue] = []
        if candidate.name.isEmpty {
            issues.append(DraftIssue(field: "name", message: ConnectionDraft.msgNameRequired))
        }
        if candidate.host.isEmpty {
            issues.append(DraftIssue(field: "host", message: ConnectionDraft.msgHostRequired))
        }
        if candidate.port < ConnectionDraft.minPort || candidate.port > ConnectionDraft.maxPort {
            issues.append(DraftIssue(field: "port", message: ConnectionDraft.msgPortRange))
        }
        // SSH is the only protocol Zephyr requires a username for.
        if candidate.`protocol` == .ssh && candidate.username.isEmpty {
            issues.append(DraftIssue(field: "username", message: ConnectionDraft.msgUsernameRequired))
        }
        switch candidate.connectionMode {
        case .direct:
            break
        case .proxy:
            if candidate.proxyId == nil {
                issues.append(DraftIssue(field: "proxyId", message: ConnectionDraft.msgProxyRequired))
            }
        case .jump:
            if candidate.jumpHostIds.isEmpty {
                issues.append(DraftIssue(field: "jumpHostIds", message: ConnectionDraft.msgJumpRequired))
            }
        }
        if candidate.jumpHostIds.count > Connection.maxJumpDepth {
            issues.append(DraftIssue(field: "jumpHostIds", message: ConnectionDraft.msgJumpTooDeep))
        }
        if Set(candidate.jumpHostIds).count != candidate.jumpHostIds.count {
            issues.append(DraftIssue(field: "jumpHostIds", message: ConnectionDraft.msgJumpDuplicate))
        }
        issues.append(contentsOf: routeIssues(inventory: inventory))
        return issues
    }

    /// Dependencies that are gone or no longer usable.
    ///
    /// SCREEN_CATALOG.md 6 wants this surfaced as "路由需要修复" rather than as
    /// a save failure, so it is reported per dependency and the editor can
    /// offer to clear each one.
    public func routeIssues(inventory: RouteInventory) -> [DraftIssue] {
        var issues: [DraftIssue] = []
        if let proxyId = current.proxyId, !inventory.usableProxyIds.contains(proxyId) {
            issues.append(DraftIssue(field: "proxyId", message: ConnectionDraft.msgRouteRepair))
        }
        if let sshKeyId = current.sshKeyId, !inventory.usableSshKeyIds.contains(sshKeyId) {
            issues.append(DraftIssue(field: "sshKeyId", message: ConnectionDraft.msgRouteRepair))
        }
        for id in current.jumpHostIds where !inventory.usableJumpHostIds.contains(id) {
            issues.append(DraftIssue(field: "jumpHostIds", message: ConnectionDraft.msgRouteRepair))
            break
        }
        return issues
    }

    public var canSave: Bool { validate().isEmpty && (isDirty || isCreate) }

    // ---- section and option visibility ---------------------------------------------

    /// Sections to render, in frozen order.
    ///
    /// RDP sections appear only for RDP because their fields have no meaning
    /// elsewhere, and the file sync section appears only where a file channel
    /// exists: SFTP for SSH, the drive channel for RDP. Telnet and VNC carry
    /// no file transport at all, so offering a directory intent there would
    /// promise something the protocol cannot do.
    public func sections() -> [EditorSection] {
        EditorSection.allCases.filter { section in
            switch section {
            case .rdpChannels, .rdpDisplay:
                return current.`protocol` == .rdp
            case .fileSync:
                return current.`protocol`.supportsFiles || current.`protocol` == .rdp
            default:
                return true
            }
        }
    }

    /// rdpDomain sits in the basic section per the catalog, but only RDP has a
    /// Windows domain.
    public var showsDomainField: Bool { current.`protocol` == .rdp }

    /// Encoding is a terminal concern; a framebuffer protocol has no character
    /// set.
    public var showsEncodingField: Bool { current.`protocol`.isTerminal }

    public var showsSshKeyField: Bool { current.`protocol` == .ssh }

    // ---- constants and the field table ---------------------------------------------

    public static let minPort = 1
    public static let maxPort = 65535

    public static let msgNameRequired = "请填写连接名称"
    public static let msgHostRequired = "请填写主机地址"
    public static let msgPortRange = "端口需在 1–65535 之间"
    public static let msgUsernameRequired = "SSH 连接需要用户名"
    public static let msgProxyRequired = "代理模式需要选择一个代理"
    public static let msgJumpRequired = "跳板模式需要至少一级跳板"
    public static let msgJumpTooDeep = "跳板链最多 8 级"
    public static let msgJumpDuplicate = "跳板链中存在重复项"
    public static let msgRouteRepair = "路由需要修复：依赖已不存在或权限已撤销"

    /// A brand-new draft. Port follows the protocol default until the user
    /// edits it.
    public static func create(
        ownerUserId: String,
        connectionId: String,
        `protocol`: ConnectionProtocol = .ssh
    ) -> ConnectionDraft {
        ConnectionDraft(
            original: nil,
            current: Connection(
                id: connectionId,
                ownerUserId: ownerUserId,
                protocol: `protocol`,
                name: "",
                host: "",
                port: `protocol`.defaultPort
            )
        )
    }

    /// An editor opened on a stored row.
    ///
    /// portWasEdited is derived rather than assumed: a port that still equals
    /// its protocol's default was never deliberately chosen, so it should keep
    /// following the default when the protocol changes, while a custom port
    /// must survive the switch (ZEPHYR_PARITY.md 5.1).
    public static func edit(_ connection: Connection) -> ConnectionDraft {
        ConnectionDraft(
            original: connection,
            current: connection,
            portWasEdited: connection.port != connection.`protocol`.defaultPort
        )
    }

    /* Field readers keyed by registry field name.
     *
     * A table rather than a switch-chain so ``changedFields()`` and the mapper
     * cannot drift apart: a field with no reader here is simply never masked,
     * which fails closed. Ordered like the Kotlin linkedMap, because the mask
     * lists fields in this order. */
    private static let fieldReaders: [(field: String, read: (Connection) -> AnyHashable?)] = [
        ("name", { AnyHashable($0.name) }),
        ("host", { AnyHashable($0.host) }),
        ("port", { AnyHashable($0.port) }),
        ("protocol", { AnyHashable($0.`protocol`) }),
        ("username", { AnyHashable($0.username) }),
        ("remark", { AnyHashable($0.remark) }),
        ("tags", { AnyHashable($0.tags) }),
        ("connectionMode", { AnyHashable($0.connectionMode) }),
        ("proxyId", { $0.proxyId.map { AnyHashable($0) } }),
        ("sshKeyId", { $0.sshKeyId.map { AnyHashable($0) } }),
        ("jumpHostIds", { AnyHashable($0.jumpHostIds) }),
        /* Legacy single-hop mirror of the chain. Kept in the mask so a server
         * that only reads jumpHostId still sees the first hop instead of
         * silently losing the route. */
        ("jumpHostId", { $0.jumpHostIds.first.map { AnyHashable($0) } }),
        ("rdpSoundMode", { AnyHashable($0.rdp.soundMode) }),
        ("rdpClipboard", { AnyHashable($0.rdp.clipboard) }),
        ("rdpMicrophone", { AnyHashable($0.rdp.microphone) }),
        ("rdpCamera", { AnyHashable($0.rdp.camera) }),
        ("rdpStorage", { AnyHashable($0.rdp.storage) }),
        ("rdpLocation", { AnyHashable($0.rdp.location) }),
        ("rdpResolution", { AnyHashable($0.rdp.resolution) }),
        ("rdpQuality", { AnyHashable($0.rdp.quality) }),
        ("rdpFps", { AnyHashable($0.rdp.fps) }),
        ("rdpTouchMode", { AnyHashable($0.rdp.touchMode) }),
        ("rdpTouchSensitivity", { AnyHashable($0.rdp.touchSensitivity) }),
        ("rdpDomain", { AnyHashable($0.rdp.domain) }),
        ("encoding", { AnyHashable($0.encoding) }),
        ("visibility", { AnyHashable($0.visibility) }),
    ]

    private static let fieldReadersByName: [String: (Connection) -> AnyHashable?] =
        Dictionary(uniqueKeysWithValues: fieldReaders.map { ($0.field, $0.read) })

    private static let rdpOnlyFields: Set<String> = [
        "rdpSoundMode",
        "rdpClipboard",
        "rdpMicrophone",
        "rdpCamera",
        "rdpStorage",
        "rdpLocation",
        "rdpResolution",
        "rdpQuality",
        "rdpFps",
        "rdpTouchMode",
        "rdpTouchSensitivity",
        "rdpDomain",
    ]

    private static let terminalOnlyFields: Set<String> = ["encoding"]

    /// Fields a protocol may name.
    ///
    /// Omitting an inapplicable field from the mask leaves the server value
    /// untouched, so a user who switches a connection to SSH and back does not
    /// lose their RDP settings.
    public static func fieldsFor(_ connectionProtocol: ConnectionProtocol) -> [String] {
        fieldReaders.map { $0.field }.filter { field in
            if rdpOnlyFields.contains(field) { return connectionProtocol == .rdp }
            if terminalOnlyFields.contains(field) { return connectionProtocol.isTerminal }
            if field == "sshKeyId" { return connectionProtocol == .ssh }
            return true
        }
    }

    /// Telnet is the only protocol Zephyr allows the legacy code pages on.
    public static func availableEncodings(_ connectionProtocol: ConnectionProtocol) -> [TerminalEncoding] {
        connectionProtocol == .telnet ? TerminalEncoding.allCases : [.utf8]
    }

    /// Presence shown for a secret the user has not touched in this session.
    public static func presenceFor(state: SecretState, stored: SecretPresence) -> SecretPresence {
        switch state {
        case .unchanged:
            return stored
        case .clear:
            return .absent
        case .replace:
            return SecretPresence(hasValue: true)
        }
    }
}
