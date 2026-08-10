import Foundation

/// A proxy the S11 route section may reference. Only the fields the editor
/// needs are ported; the wire row carries more.
public struct Proxy: Equatable, Sendable {
    public var id: String
    public var name: String
    public var host: String
    public var port: Int
    public var deletedAt: Int64?
    public var capabilities: CapabilitySet

    public init(
        id: String,
        name: String,
        host: String = "",
        port: Int = 0,
        deletedAt: Int64? = nil,
        capabilities: CapabilitySet = .owner
    ) {
        self.id = id
        self.name = name
        self.host = host
        self.port = port
        self.deletedAt = deletedAt
        self.capabilities = capabilities
    }

    public static let entityType = "proxy"
}

/// A saved SSH key the S11 auth section may reference.
public struct SshKey: Equatable, Sendable {
    public var id: String
    public var name: String
    public var deletedAt: Int64?
    public var capabilities: CapabilitySet

    public init(
        id: String,
        name: String,
        deletedAt: Int64? = nil,
        capabilities: CapabilitySet = .owner
    ) {
        self.id = id
        self.name = name
        self.deletedAt = deletedAt
        self.capabilities = capabilities
    }

    public static let entityType = "sshKey"
}

/// A jump host is a named pointer at an SSH connection, so deleting it is
/// reference-checked.
public struct JumpHost: Equatable, Sendable {
    public var id: String
    public var name: String
    public var connectionId: String
    public var deletedAt: Int64?
    public var capabilities: CapabilitySet

    public init(
        id: String,
        name: String,
        connectionId: String = "",
        deletedAt: Int64? = nil,
        capabilities: CapabilitySet = .owner
    ) {
        self.id = id
        self.name = name
        self.connectionId = connectionId
        self.deletedAt = deletedAt
        self.capabilities = capabilities
    }

    public static let entityType = "jumpHost"
}

/// A Client Token as listed during the S02 bind flow. The token secret itself
/// is only ever shown once by the main end; One sees metadata.
public struct ClientToken: Equatable, Sendable {
    public var id: String
    public var ownerUserId: String
    public var name: String
    public var createdAt: Int64
    public var updatedAt: Int64
    public var lastUsedAt: Int64?
    public var linkedOneDeviceCount: Int
    public var linkedLegacyAgentCount: Int

    public init(
        id: String,
        ownerUserId: String,
        name: String,
        createdAt: Int64 = 0,
        updatedAt: Int64 = 0,
        lastUsedAt: Int64? = nil,
        linkedOneDeviceCount: Int = 0,
        linkedLegacyAgentCount: Int = 0
    ) {
        self.id = id
        self.ownerUserId = ownerUserId
        self.name = name
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastUsedAt = lastUsedAt
        self.linkedOneDeviceCount = linkedOneDeviceCount
        self.linkedLegacyAgentCount = linkedLegacyAgentCount
    }

    public static let entityType = "clientToken"
}
