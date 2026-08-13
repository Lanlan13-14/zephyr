import Foundation
import ZephyrContracts

/// Connection protocols and their Zephyr default ports (ZEPHYR_PARITY.md 5.1).
///
/// Named `ConnectionProtocol` rather than the Kotlin `Protocol`: the bare word
/// collides with Swift's own vocabulary type, and every call site would need
/// backticks. The wire values are unchanged, so nothing on the wire notices.
/// Unknown wire values are preserved read-only instead of being coerced.
public enum ConnectionProtocol: String, Codable, Sendable, CaseIterable {
    case ssh = "SSH"
    case telnet = "TELNET"
    case rdp = "RDP"
    case vnc = "VNC"

    public var wireName: String { rawValue }

    public var defaultPort: Int {
        switch self {
        case .ssh: return 22
        case .telnet: return 23
        case .rdp: return 3389
        case .vnc: return 5900
        }
    }

    public var isTerminal: Bool { self == .ssh || self == .telnet }
    public var isRemoteDesktop: Bool { self == .rdp || self == .vnc }

    /// Only SSH carries SFTP, Docker, batch execution and snippet execution.
    public var supportsFiles: Bool { self == .ssh }
    public var supportsExec: Bool { self == .ssh }

    /// Telnet is cleartext; the UI must keep saying so.
    public var isCleartext: Bool { self == .telnet }

    public static func fromWire(_ value: String?) -> ConnectionProtocol? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespaces) else { return nil }
        return allCases.first { $0.wireName.caseInsensitiveCompare(trimmed) == .orderedSame }
    }
}

/// Terminal encodings Zephyr accepts. Telnet may use the legacy code pages.
public enum TerminalEncoding: String, Codable, Sendable, CaseIterable {
    case utf8 = "UTF-8"
    case gbk = "GBK"
    case big5 = "Big5"
    case latin1 = "Latin-1"

    public var wireName: String { rawValue }

    public static let standardDefault: TerminalEncoding = .utf8

    public static func fromWire(_ value: String?) -> TerminalEncoding {
        guard let trimmed = value?.trimmingCharacters(in: .whitespaces) else { return standardDefault }
        return allCases.first { $0.wireName.caseInsensitiveCompare(trimmed) == .orderedSame } ?? standardDefault
    }
}

public enum ConnectionMode: String, Codable, Sendable, CaseIterable {
    case direct
    case proxy
    case jump

    public var wireName: String { rawValue }

    public static let standardDefault: ConnectionMode = .direct

    public static func fromWire(_ value: String?) -> ConnectionMode {
        allCases.first { $0.wireName == value } ?? standardDefault
    }
}

/// Where a connection wants device files exposed. The grant itself is never
/// portable.
public enum FileSyncDirectoryIntent: String, Codable, Sendable, CaseIterable {
    case off
    case ask
    case localShare = "local_share"
    case serverBridge = "server_bridge"

    public var wireName: String { rawValue }

    public static let standardDefault: FileSyncDirectoryIntent = .off

    public static func fromWire(_ value: String?) -> FileSyncDirectoryIntent {
        allCases.first { $0.wireName == value } ?? standardDefault
    }
}

/// RDP enumerations and defaults frozen by ZEPHYR_PARITY.md 5.2. These values
/// are product contract, not renderer hints.
public enum RdpSoundMode: String, Codable, Sendable, CaseIterable {
    case local
    case remote
    case off

    public var wireName: String { rawValue }

    public static let standardDefault: RdpSoundMode = .local

    public static func fromWire(_ value: String?) -> RdpSoundMode {
        allCases.first { $0.wireName == value } ?? standardDefault
    }
}

public enum RdpResolution: String, Codable, Sendable, CaseIterable {
    case auto
    case p1080 = "1080p"
    case k2 = "2K"
    case k4 = "4K"
    case k8 = "8K"

    public var wireName: String { rawValue }

    public static let standardDefault: RdpResolution = .p1080

    public static func fromWire(_ value: String?) -> RdpResolution {
        allCases.first { $0.wireName == value } ?? standardDefault
    }
}

public enum RdpQuality: String, Codable, Sendable, CaseIterable {
    case balanced
    case performance
    case quality

    public var wireName: String { rawValue }

    public static let standardDefault: RdpQuality = .balanced

    public static func fromWire(_ value: String?) -> RdpQuality {
        allCases.first { $0.wireName == value } ?? standardDefault
    }
}

public enum RdpFps: Int, Codable, Sendable, CaseIterable {
    case f30 = 30
    case f45 = 45
    case f60 = 60
    case f120 = 120
    case f144 = 144

    public var value: Int { rawValue }

    public static let standardDefault: RdpFps = .f30

    public static func fromValue(_ value: Int?) -> RdpFps {
        allCases.first { $0.value == value } ?? standardDefault
    }
}

/// direct maps a finger to the remote pointer; relative drives it like a
/// trackpad.
public enum RdpTouchMode: String, Codable, Sendable, CaseIterable {
    case direct
    case relative

    public var wireName: String { rawValue }

    public static let standardDefault: RdpTouchMode = .direct

    public static func fromWire(_ value: String?) -> RdpTouchMode {
        allCases.first { $0.wireName == value } ?? standardDefault
    }
}

public enum RdpChannel: String, Codable, Sendable, CaseIterable {
    case audio
    case clipboard
    case microphone
    case camera
    case drive
    case location
}

public struct RdpSettings: Codable, Equatable, Sendable {
    public var soundMode: RdpSoundMode
    public var clipboard: Bool
    public var microphone: Bool
    public var camera: Bool
    public var storage: Bool
    public var location: Bool
    public var resolution: RdpResolution
    public var quality: RdpQuality
    public var fps: RdpFps
    public var touchMode: RdpTouchMode
    public var touchSensitivity: Double
    public var domain: String

    public init(
        soundMode: RdpSoundMode = .standardDefault,
        clipboard: Bool = true,
        microphone: Bool = false,
        camera: Bool = false,
        storage: Bool = false,
        location: Bool = false,
        resolution: RdpResolution = .standardDefault,
        quality: RdpQuality = .standardDefault,
        fps: RdpFps = .standardDefault,
        touchMode: RdpTouchMode = .standardDefault,
        touchSensitivity: Double = RdpSettings.defaultSensitivity,
        domain: String = ""
    ) {
        /* A `require` in Kotlin, a precondition here: both mean an out-of-range
         * sensitivity is a programming error, not user input. UI input arrives
         * through ``clampSensitivity``. */
        precondition(
            touchSensitivity >= RdpSettings.minSensitivity &&
                touchSensitivity <= RdpSettings.maxSensitivity,
            "rdpTouchSensitivity must be within 0.5..3.0"
        )
        self.soundMode = soundMode
        self.clipboard = clipboard
        self.microphone = microphone
        self.camera = camera
        self.storage = storage
        self.location = location
        self.resolution = resolution
        self.quality = quality
        self.fps = fps
        self.touchMode = touchMode
        self.touchSensitivity = touchSensitivity
        self.domain = domain
    }

    /// Channels the session may request. A denied permission closes one
    /// channel, not the session.
    public var requestedChannels: Set<RdpChannel> {
        var channels: Set<RdpChannel> = []
        if soundMode != .off { channels.insert(.audio) }
        if clipboard { channels.insert(.clipboard) }
        if microphone { channels.insert(.microphone) }
        if camera { channels.insert(.camera) }
        if storage { channels.insert(.drive) }
        if location { channels.insert(.location) }
        return channels
    }

    public static let minSensitivity = 0.5
    public static let maxSensitivity = 3.0
    public static let defaultSensitivity = 1.5

    public static func clampSensitivity(_ value: Double) -> Double {
        min(maxSensitivity, max(minSensitivity, value))
    }
}

/// Residency is the hard product boundary from SHARED_RESOURCE_RESIDENCY.md:
/// owned resources are mirrored locally, shared-to-me resources are
/// online-only and must never touch the local DB, SecretStore, search index,
/// offline cache, backup, logs or notifications.
public enum Residency: String, Codable, Sendable, CaseIterable {
    /// ownerUserId == boundUserId. Full local mirror, offline capable.
    case owned

    /// Shared with the bound account through ACL. Online-only, zero local
    /// residency.
    case sharedOnlineOnly

    public var isMirrored: Bool { self == .owned }
    public var allowsLocalPersistence: Bool { self == .owned }
    public var allowsOfflineCache: Bool { self == .owned }
    public var allowsSearchIndex: Bool { self == .owned }
    public var allowsBackup: Bool { self == .owned }
}

/// The capability set the server most recently reported. Client-side gating is
/// presentation only; every server call recomputes it (ZEPHYR_PARITY.md 4.2).
public struct CapabilitySet: Codable, Equatable, Sendable {
    public let capabilities: Set<Capability>

    public init(_ capabilities: Set<Capability>) {
        self.capabilities = capabilities
    }

    public func contains(_ capability: Capability) -> Bool {
        capabilities.contains(capability)
    }

    public var canView: Bool { capabilities.contains(.view) }
    public var canUse: Bool { capabilities.contains(.use) }
    public var canObserve: Bool { capabilities.contains(.observe) }
    public var canControl: Bool { capabilities.contains(.control) }
    public var canExecute: Bool { capabilities.contains(.execute) }
    public var canReadFiles: Bool { capabilities.contains(.fileRead) }
    public var canWriteFiles: Bool { capabilities.contains(.fileWrite) }
    public var canEdit: Bool { capabilities.contains(.edit) }
    public var canShare: Bool { capabilities.contains(.share) }
    public var canDelete: Bool { capabilities.contains(.delete) }

    /// Never implied by shared use. Owner policy may withhold it permanently.
    public var canRevealSecret: Bool { capabilities.contains(.revealSecret) }

    /// A resource with no EDIT capability must not queue local write
    /// operations.
    public var allowsLocalWriteQueue: Bool { canEdit }

    public func wireNames() -> [String] {
        capabilities.map { $0.rawValue }.sorted()
    }

    public static let owner = CapabilitySet(Set(Capability.allCases))
    public static let none = CapabilitySet([])

    /// Implicit grants from shared_users/shared_admins/shared_all.
    public static let implicitShare = CapabilitySet([.discover, .view, .use, .observe])

    public static func fromWire(_ values: [String]?) -> CapabilitySet {
        CapabilitySet(Set((values ?? []).compactMap { Capability(rawValue: $0) }))
    }
}

/// How a shared connection is allowed to be opened. Owner policy decides; One
/// never downgrades.
public enum SharedUsePolicy: String, Codable, Sendable, CaseIterable {
    /// Credentials stay on the Zephyr main end. Always available as the safe
    /// default.
    case relayOnly

    /// Owner permits a single short-lived encrypted use envelope for a native
    /// direct session.
    case directAllowed

    /// A direct session means connection material was present in One's memory.
    /// The UI must say so rather than claiming the secret never reached the
    /// device.
    public var materialTouchesDevice: Bool { self == .directAllowed }
}

/// Secret editing is an explicit tri-state (ZEPHYR_PARITY.md 5.3). A masked
/// placeholder is never a new secret, so "unchanged" must be representable and
/// must never reach a fieldMask.
public enum SecretState: Equatable, Sendable {
    /// Keep whatever the server already holds. Produces no fieldMask entry.
    case unchanged

    /// Replace with a new plaintext value, which is enveloped before it leaves
    /// the device.
    case replace(String)

    /// Explicitly clear the stored secret.
    case clear

    public var contributesToFieldMask: Bool { self != .unchanged }
}

/// List payloads only ever carry presence, never the secret. Mirrors Zephyr's
/// hasX/masked contract.
public struct SecretPresence: Codable, Equatable, Sendable {
    public let hasValue: Bool
    public let secretRef: String?

    public init(hasValue: Bool, secretRef: String? = nil) {
        self.hasValue = hasValue
        self.secretRef = secretRef
    }

    public static let absent = SecretPresence(hasValue: false)
    public static let mask = "******"
}

/// Local mirror state for any entity row.
public enum SyncState: String, Codable, Sendable, CaseIterable {
    case synced
    case pendingLocal
    case conflicted

    /// Present on the server but not authorized for this device to edit.
    case readOnlyRemote
}
