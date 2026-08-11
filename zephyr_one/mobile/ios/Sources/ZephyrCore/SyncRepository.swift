import Foundation
import ZephyrContracts

/// The exact durable binding-record publication that owns a sync runtime.
///
/// `generation` scopes durable mirror data. `bindingRecordVersion` is a random lease epoch from
/// the binding-record store and changes on every binding-record CAS, including active/restoring
/// transitions that intentionally retain the same generation. A repository must compare the
/// complete value inside the same transaction as each mutation.
public struct SyncBindingIdentity: Equatable, Hashable, Sendable {
    public static let bindingRecordVersionByteCount = 32

    public let serverID: String
    public let accountID: String
    public let deviceID: String
    public let generation: String
    public let bindingRecordVersion: Data

    public init(
        serverID: String,
        accountID: String,
        deviceID: String,
        generation: String,
        bindingRecordVersion: Data = Data()
    ) {
        self.serverID = serverID
        self.accountID = accountID
        self.deviceID = deviceID
        self.generation = generation
        self.bindingRecordVersion = bindingRecordVersion
    }

    public func replacingBindingRecordVersion(_ version: Data) -> SyncBindingIdentity {
        SyncBindingIdentity(
            serverID: serverID,
            accountID: accountID,
            deviceID: deviceID,
            generation: generation,
            bindingRecordVersion: version
        )
    }

    public func hasSameBindingGeneration(as other: SyncBindingIdentity) -> Bool {
        serverID == other.serverID && accountID == other.accountID &&
            deviceID == other.deviceID && generation == other.generation
    }
}

public enum SyncRuntimeLeaseState: Equatable, Sendable {
    case runnable
    case fenced
}

/// A durable continuation for a snapshot that has not reached its complete page yet.
public struct SyncBootstrapCheckpoint: Equatable, Sendable {
    public let stagingGeneration: String
    public let bootstrapId: String
    public let snapshotCursor: Int64
    public let nextPageToken: String
    public let pagesFetched: Int
    public let entitiesStaged: Int
    public let expiresAtMilliseconds: Int64

    public init(
        stagingGeneration: String,
        bootstrapId: String,
        snapshotCursor: Int64,
        nextPageToken: String,
        pagesFetched: Int,
        entitiesStaged: Int,
        expiresAtMilliseconds: Int64
    ) {
        self.stagingGeneration = stagingGeneration
        self.bootstrapId = bootstrapId
        self.snapshotCursor = snapshotCursor
        self.nextPageToken = nextPageToken
        self.pagesFetched = pagesFetched
        self.entitiesStaged = entitiesStaged
        self.expiresAtMilliseconds = expiresAtMilliseconds
    }

    public func isExpired(at nowMilliseconds: Int64) -> Bool {
        nowMilliseconds >= expiresAtMilliseconds
    }
}

/// The small, non-secret state needed to plan one round.
public struct SyncRepositorySnapshot: Equatable, Sendable {
    public let identity: SyncBindingIdentity
    public let runtimeLeaseState: SyncRuntimeLeaseState
    public let bindingState: BindingState
    public let appliedCursor: Int64
    public let acknowledgedCursor: Int64
    public let snapshotCursor: Int64
    public let registryHash: String?
    public let consecutiveFailures: Int
    public let nextEligibleAtMilliseconds: Int64?
    public let bootstrapCheckpoint: SyncBootstrapCheckpoint?

    public init(
        identity: SyncBindingIdentity,
        runtimeLeaseState: SyncRuntimeLeaseState = .runnable,
        bindingState: BindingState,
        appliedCursor: Int64 = 0,
        acknowledgedCursor: Int64 = 0,
        snapshotCursor: Int64 = 0,
        registryHash: String? = nil,
        consecutiveFailures: Int = 0,
        nextEligibleAtMilliseconds: Int64? = nil,
        bootstrapCheckpoint: SyncBootstrapCheckpoint? = nil
    ) {
        self.identity = identity
        self.runtimeLeaseState = runtimeLeaseState
        self.bindingState = bindingState
        self.appliedCursor = appliedCursor
        self.acknowledgedCursor = acknowledgedCursor
        self.snapshotCursor = snapshotCursor
        self.registryHash = registryHash
        self.consecutiveFailures = consecutiveFailures
        self.nextEligibleAtMilliseconds = nextEligibleAtMilliseconds
        self.bootstrapCheckpoint = bootstrapCheckpoint
    }

    public var canRunSync: Bool {
        runtimeLeaseState == .runnable && bindingState.canRunSync
    }
}

public struct SyncApplyResult: Equatable, Sendable {
    public let applied: Int
    public let skipped: Int

    public init(applied: Int, skipped: Int) {
        self.applied = applied
        self.skipped = skipped
    }
}

/// A conflict is keyed by opId. Replaying an uncertain push therefore updates the same row.
/// Secret values are represented only by their encrypted envelopes.
public struct SyncConflictRecord: Equatable, Sendable {
    public let opId: String
    public let entityType: String
    public let entityId: String
    public let localBaseRevision: Int64
    public let localFieldMask: [String]
    public let localPayload: [String: MobileJSONValue]
    public let localSecretEnvelopes: [String: MobileSecretEnvelope]
    public let serverRevision: Int64
    public let serverPayload: [String: MobileJSONValue]
    public let overlapFields: [String]
    public let serverDeleted: Bool
    public let aclRevoked: Bool

    public init(
        opId: String,
        entityType: String,
        entityId: String,
        localBaseRevision: Int64,
        localFieldMask: [String],
        localPayload: [String: MobileJSONValue],
        localSecretEnvelopes: [String: MobileSecretEnvelope],
        serverRevision: Int64,
        serverPayload: [String: MobileJSONValue],
        overlapFields: [String],
        serverDeleted: Bool,
        aclRevoked: Bool
    ) {
        self.opId = opId
        self.entityType = entityType
        self.entityId = entityId
        self.localBaseRevision = localBaseRevision
        self.localFieldMask = localFieldMask
        self.localPayload = localPayload
        self.localSecretEnvelopes = localSecretEnvelopes
        self.serverRevision = serverRevision
        self.serverPayload = serverPayload
        self.overlapFields = overlapFields
        self.serverDeleted = serverDeleted
        self.aclRevoked = aclRevoked
    }
}

/// Durable effects of a push response, ordered by the original operation batch.
public enum SyncPushOutcome: Equatable, Sendable {
    case completed(opId: String, entityId: String, revision: Int64, duplicate: Bool)
    case conflicted(SyncConflictRecord)
    case failed(opId: String, errorCode: String, drop: Bool)

    public var opId: String {
        switch self {
        case .completed(let opId, _, _, _), .failed(let opId, _, _): return opId
        case .conflicted(let conflict): return conflict.opId
        }
    }

    public var errorCode: String? {
        guard case .failed(_, let errorCode, _) = self else { return nil }
        return errorCode
    }
}

/// Persistence boundary for one sync binding.
///
/// Implementations are responsible for transactionality: change page + cursor, bootstrap page +
/// continuation, bootstrap promotion + cursor, and push outcomes must each commit atomically.
/// Every mutating call must fail without writing if `identity` is no longer current.
public protocol SyncRepository: Sendable {
    /// Inspection snapshot used by restore/cleanup reporting. It may describe a fenced lease.
    func snapshot() async throws -> SyncRepositorySnapshot?

    /// Returns a snapshot only when the complete expected lease is still current and runnable.
    func runnableSnapshot(for identity: SyncBindingIdentity) async throws -> SyncRepositorySnapshot?

    /// Atomically advances an exact current lease to a fresh, non-runnable record version.
    /// This covers active -> restoring and fenced restoring -> cleanup handoffs.
    func fenceRuntime(
        from current: SyncBindingIdentity,
        to fenced: SyncBindingIdentity
    ) async throws

    /// Atomically publishes a fresh active version from the exact fenced predecessor.
    func publishRuntime(
        from fenced: SyncBindingIdentity,
        to active: SyncBindingIdentity
    ) async throws

    func recordAttempt(at milliseconds: Int64, for identity: SyncBindingIdentity) async throws
    func saveBindingState(_ state: BindingState, for identity: SyncBindingIdentity) async throws
    func saveRegistryHash(_ hash: String, for identity: SyncBindingIdentity) async throws

    func resetBootstrap(for identity: SyncBindingIdentity) async throws
    func stageBootstrapPage(
        _ page: MobileBootstrapResponse,
        requestedPageToken: String?,
        stagingGeneration: String,
        continuation: SyncBootstrapCheckpoint?,
        for identity: SyncBindingIdentity
    ) async throws -> Int
    func commitBootstrap(
        stagingGeneration: String,
        snapshotCursor: Int64,
        for identity: SyncBindingIdentity
    ) async throws

    /// Returned operations already own durable opIds. A retry must return the same values.
    func pendingOperations(limit: Int, for identity: SyncBindingIdentity) async throws -> [MobileSyncOperation]
    func markDispatched(
        opIds: [String],
        batchId: String,
        at milliseconds: Int64,
        for identity: SyncBindingIdentity
    ) async throws
    func applyPushOutcomes(_ outcomes: [SyncPushOutcome], for identity: SyncBindingIdentity) async throws

    func applyChangePage(
        _ page: MobileChangesResponse,
        expectedCursor: Int64,
        for identity: SyncBindingIdentity
    ) async throws -> SyncApplyResult
    func saveAcknowledgedCursor(_ cursor: Int64, for identity: SyncBindingIdentity) async throws

    func recordSuccess(at milliseconds: Int64, for identity: SyncBindingIdentity) async throws
    func recordFailure(
        at milliseconds: Int64,
        error: MobileApiError,
        nextEligibleAtMilliseconds: Int64?,
        for identity: SyncBindingIdentity
    ) async throws
}

public extension SyncRepository {
    func runnableSnapshot(for identity: SyncBindingIdentity) async throws -> SyncRepositorySnapshot? {
        guard let snapshot = try await snapshot(), snapshot.identity == identity,
              snapshot.runtimeLeaseState == .runnable else { return nil }
        return snapshot
    }

    func fenceRuntime(
        from current: SyncBindingIdentity,
        to fenced: SyncBindingIdentity
    ) async throws {
        throw SQLiteSyncRepositoryError.bindingChanged
    }

    func publishRuntime(
        from fenced: SyncBindingIdentity,
        to active: SyncBindingIdentity
    ) async throws {
        throw SQLiteSyncRepositoryError.bindingChanged
    }
}

/// Network boundary. Its signatures intentionally match MobileApiClient so the production client
/// can conform without an adapter or a second encoding path.
public protocol SyncTransport: Sendable {
    func capabilities() async throws -> MobileCapabilitiesResponse
    func bootstrap(pageToken: String?, limit: Int?) async throws -> MobileBootstrapResponse
    func changes(cursor: Int64, limit: Int?) async throws -> MobileChangesResponse
    func push(_ request: MobilePushRequest) async throws -> MobilePushResponse
    func ack(_ request: MobileAckRequest) async throws -> MobileAckResponse
}

extension MobileApiClient: SyncTransport {}

public protocol SyncClock: Sendable {
    func nowMilliseconds() -> Int64
}

public struct SystemSyncClock: SyncClock {
    public init() {}

    public func nowMilliseconds() -> Int64 {
        Int64((Date().timeIntervalSince1970 * 1_000).rounded(.down))
    }
}

public enum SyncRetryPolicy {
    /// Retry-After wins over local exponential backoff. Jitter is frozen to 0.5x...1.5x.
    public static func delayMilliseconds(
        for error: MobileApiError,
        consecutiveFailures: Int,
        jitter: Double
    ) -> Int64? {
        guard error.retryable || error.isRegistryRetryable else { return nil }
        if let seconds = error.retryAfterSeconds {
            let nonnegative = max(0, seconds)
            return nonnegative > Int64.max / 1_000 ? Int64.max : nonnegative * 1_000
        }

        let steps = SyncContract.retryBackoffMs
        let index = min(max(consecutiveFailures, 0), steps.count - 1)
        let finiteJitter = jitter.isFinite ? jitter : 1
        let boundedJitter = min(max(finiteJitter, 0.5), 1.5)
        return Int64((Double(steps[index]) * boundedJitter).rounded())
    }
}
