import Foundation

/// A Zephyr connection as mirrored on the device. Field names track the entity
/// registry so a fieldMask can be produced without a translation table.
public struct Connection: Equatable, Sendable, Identifiable {
    public var id: String
    public var ownerUserId: String
    public var `protocol`: ConnectionProtocol
    public var name: String
    public var host: String
    public var port: Int
    public var username: String
    public var remark: String
    public var tags: [String]
    public var encoding: TerminalEncoding
    public var connectionMode: ConnectionMode
    public var proxyId: String?
    public var sshKeyId: String?
    public var jumpHostIds: [String]
    public var rdp: RdpSettings
    public var fileSyncIntent: FileSyncDirectoryIntent
    public var visibility: String
    public var password: SecretPresence
    public var privateKey: SecretPresence
    public var revision: Int64
    public var updatedAt: Int64
    public var lastConnectedAt: Int64?
    public var deletedAt: Int64?
    public var residency: Residency
    public var capabilities: CapabilitySet
    public var sharedOwnerLabel: String?
    public var sharedUsePolicy: SharedUsePolicy
    public var grantExpiresAt: Int64?
    public var syncState: SyncState
    /// Fields One does not understand. Preserved verbatim, never named in a
    /// fieldMask.
    public var opaque: [String: String]
    /// One-shot deep link connection: never listed, never mirrored, cleaned up
    /// after TTL.
    public var ephemeral: Bool

    public init(
        id: String,
        ownerUserId: String,
        `protocol`: ConnectionProtocol,
        name: String,
        host: String,
        port: Int,
        username: String = "",
        remark: String = "",
        tags: [String] = [],
        encoding: TerminalEncoding = .standardDefault,
        connectionMode: ConnectionMode = .standardDefault,
        proxyId: String? = nil,
        sshKeyId: String? = nil,
        jumpHostIds: [String] = [],
        rdp: RdpSettings = RdpSettings(),
        fileSyncIntent: FileSyncDirectoryIntent = .standardDefault,
        visibility: String = "private",
        password: SecretPresence = .absent,
        privateKey: SecretPresence = .absent,
        revision: Int64 = 0,
        updatedAt: Int64 = 0,
        lastConnectedAt: Int64? = nil,
        deletedAt: Int64? = nil,
        residency: Residency = .owned,
        capabilities: CapabilitySet = .owner,
        sharedOwnerLabel: String? = nil,
        sharedUsePolicy: SharedUsePolicy = .relayOnly,
        grantExpiresAt: Int64? = nil,
        syncState: SyncState = .synced,
        opaque: [String: String] = [:],
        ephemeral: Bool = false
    ) {
        self.id = id
        self.ownerUserId = ownerUserId
        self.`protocol` = `protocol`
        self.name = name
        self.host = host
        self.port = port
        self.username = username
        self.remark = remark
        self.tags = tags
        self.encoding = encoding
        self.connectionMode = connectionMode
        self.proxyId = proxyId
        self.sshKeyId = sshKeyId
        self.jumpHostIds = jumpHostIds
        self.rdp = rdp
        self.fileSyncIntent = fileSyncIntent
        self.visibility = visibility
        self.password = password
        self.privateKey = privateKey
        self.revision = revision
        self.updatedAt = updatedAt
        self.lastConnectedAt = lastConnectedAt
        self.deletedAt = deletedAt
        self.residency = residency
        self.capabilities = capabilities
        self.sharedOwnerLabel = sharedOwnerLabel
        self.sharedUsePolicy = sharedUsePolicy
        self.grantExpiresAt = grantExpiresAt
        self.syncState = syncState
        self.opaque = opaque
        self.ephemeral = ephemeral
    }

    public var displayAddress: String { host + ":" + String(port) }

    public var isDeleted: Bool { deletedAt != nil }

    /// Jump chain depth is capped at 8 levels by Zephyr's route planner.
    public var jumpDepth: Int { jumpHostIds.count }

    public var dependencyIds: [String] {
        var ids: [String] = []
        if let proxyId { ids.append(proxyId) }
        if let sshKeyId { ids.append(sshKeyId) }
        ids.append(contentsOf: jumpHostIds)
        return ids
    }

    /// Switching protocol clears incompatible fields but keeps the rest of the
    /// draft.
    public func withProtocol(_ next: ConnectionProtocol, portWasEdited: Bool) -> Connection {
        if next == self.`protocol` { return self }
        let nextPort = portWasEdited ? port : next.defaultPort
        var copy = self
        copy.`protocol` = next
        copy.port = nextPort
        if next == .telnet {
            copy.sshKeyId = nil
            copy.privateKey = .absent
        }
        return copy
    }

    public func withConnectionMode(_ next: ConnectionMode) -> Connection {
        var copy = self
        copy.connectionMode = next
        switch next {
        case .direct:
            copy.proxyId = nil
            copy.jumpHostIds = []
        case .proxy:
            copy.jumpHostIds = []
        case .jump:
            copy.proxyId = nil
        }
        return copy
    }

    public static let maxJumpDepth = 8
    public static let entityType = "connection"
    public static let ephemeralTtlMs: Int64 = 6 * 60 * 60 * 1000

    /// Zephyr's connection visibility values. Kept as the wire strings
    /// because the server owns them.
    public static let visibilityOptions = ["private", "shared_users", "shared_admins", "shared_all"]
}
