// GENERATED FILE - DO NOT EDIT.
// Source: mobile/contracts. Regenerate with `node mobile/tools/generate.mjs`.

import Foundation

/// Persisted binding state from SYNC_STATE_MACHINE.md section 1.
public enum BindingState: String, Sendable, CaseIterable, Codable {
    case unbound = "UNBOUND"
    case boundNeedsBootstrap = "BOUND_NEEDS_BOOTSTRAP"
    case bootstrapping = "BOOTSTRAPPING"
    case catchingUp = "CATCHING_UP"
    case idle = "IDLE"
    case running = "RUNNING"
    case conflicted = "CONFLICTED"
    case reauthRequired = "REAUTH_REQUIRED"
    case revoked = "REVOKED"
    case fatalIncompatible = "FATAL_INCOMPATIBLE"

    public var isBound: Bool { self != .unbound }

    public var canRunSync: Bool {
        switch self {
        case .unbound, .revoked, .fatalIncompatible, .reauthRequired: return false
        default: return true
        }
    }
}

/// Runtime phase from SYNC_STATE_MACHINE.md section 2.
public enum SyncPhase: String, Sendable, CaseIterable, Codable {
    case validateBinding = "VALIDATE_BINDING"
    case recoverBootstrap = "RECOVER_BOOTSTRAP"
    case bootstrapPage = "BOOTSTRAP_PAGE"
    case catchUpPull = "CATCH_UP_PULL"
    case pushPending = "PUSH_PENDING"
    case pullChanges = "PULL_CHANGES"
    case applyBlobs = "APPLY_BLOBS"
    case ackCursor = "ACK_CURSOR"
    case commitSuccess = "COMMIT_SUCCESS"
}

public enum SyncAction: String, Sendable, CaseIterable, Codable {
    case upsert
    case delete
    case restore
}

public enum PushStatus: String, Sendable, CaseIterable, Codable {
    case accepted
    case duplicate
    case conflict
    case rejected
    case dependencyMissing = "dependency_missing"
}

public enum ConflictResolution: String, Sendable, CaseIterable, Codable {
    case useServer = "use_server"
    case keepLocal = "keep_local"
    case copyAsNew = "copy_as_new"
    case manualMerge = "manual_merge"
}

/// Fixed ACL capability set shared with Zephyr authz.js.
public enum Capability: String, Sendable, CaseIterable, Codable {
    case discover = "discover"
    case view = "view"
    case use = "use"
    case observe = "observe"
    case control = "control"
    case execute = "execute"
    case fileRead = "fileRead"
    case fileWrite = "fileWrite"
    case edit = "edit"
    case share = "share"
    case delete = "delete"
    case revealSecret = "revealSecret"
    case administer = "administer"
}

public enum SyncContract {
    public static let protocolVersion = 1
    public static let maxOpsPerBatch = 200
    public static let minIntervalSec = 30
    public static let maxIntervalSec = 86400
    public static let defaultIntervalSec = 300
    public static let appliedOpRetentionDays = 180
    public static let tombstoneRetentionDays = 180
    public static let bootstrapPageTokenTtlMinutes = 30
    public static let blobChunkBytes = 4 * 1024 * 1024

    public static let firstBindPhases: [SyncPhase] = [.validateBinding, .bootstrapPage, .catchUpPull, .pushPending, .pullChanges, .applyBlobs, .ackCursor, .commitSuccess]
    public static let normalPhases: [SyncPhase] = [.validateBinding, .pushPending, .pullChanges, .applyBlobs, .ackCursor, .commitSuccess]

    /// Retry backoff in milliseconds, jittered 0.5x-1.5x by the caller.
    public static let retryBackoffMs: [Int] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 60_000, 900_000]

    public static func clampIntervalSec(_ value: Int) -> Int {
        min(maxIntervalSec, max(minIntervalSec, value))
    }
}
