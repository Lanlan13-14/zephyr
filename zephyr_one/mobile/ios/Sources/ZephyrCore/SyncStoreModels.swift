import Foundation

/// A row in the account-owned server mirror. Secret values never appear here in plaintext;
/// encrypted envelopes may be retained until a platform secret-store adapter consumes them.
public struct SyncMirrorEntity: Equatable, Sendable {
    public let entityType: String
    public let entityId: String
    public let revision: Int64
    public let serverChangedAtMilliseconds: Int64
    public let localChangedAtMilliseconds: Int64
    public let fieldMask: [String]
    public let payload: [String: MobileJSONValue]
    public let secretEnvelopes: [String: MobileSecretEnvelope]
    public let hasPendingWrite: Bool

    public init(
        entityType: String,
        entityId: String,
        revision: Int64,
        serverChangedAtMilliseconds: Int64,
        localChangedAtMilliseconds: Int64,
        fieldMask: [String],
        payload: [String: MobileJSONValue],
        secretEnvelopes: [String: MobileSecretEnvelope] = [:],
        hasPendingWrite: Bool
    ) {
        self.entityType = entityType
        self.entityId = entityId
        self.revision = revision
        self.serverChangedAtMilliseconds = serverChangedAtMilliseconds
        self.localChangedAtMilliseconds = localChangedAtMilliseconds
        self.fieldMask = fieldMask
        self.payload = payload
        self.secretEnvelopes = secretEnvelopes
        self.hasPendingWrite = hasPendingWrite
    }
}

/// Persisted diagnostics for the most recent round. Error text is deliberately restricted to
/// `MobileApiError.description`, which excludes server messages, URLs, details and credentials.
public struct SyncRunState: Equatable, Sendable {
    public let lastAttemptAtMilliseconds: Int64?
    public let lastSuccessAtMilliseconds: Int64?
    public let lastErrorCode: String?
    public let lastErrorDiagnostic: String?
    public let consecutiveFailures: Int
    public let nextEligibleAtMilliseconds: Int64?

    public init(
        lastAttemptAtMilliseconds: Int64?,
        lastSuccessAtMilliseconds: Int64?,
        lastErrorCode: String?,
        lastErrorDiagnostic: String?,
        consecutiveFailures: Int,
        nextEligibleAtMilliseconds: Int64?
    ) {
        self.lastAttemptAtMilliseconds = lastAttemptAtMilliseconds
        self.lastSuccessAtMilliseconds = lastSuccessAtMilliseconds
        self.lastErrorCode = lastErrorCode
        self.lastErrorDiagnostic = lastErrorDiagnostic
        self.consecutiveFailures = consecutiveFailures
        self.nextEligibleAtMilliseconds = nextEligibleAtMilliseconds
    }
}

/// One optimistic local mutation. The repository derives the durable mirror value from the
/// operation payload and commits that value with the operation in one SQLite transaction.
public struct SyncLocalWrite: Equatable, Sendable {
    public let operation: MobileSyncOperation
    public let localChangedAtMilliseconds: Int64

    public init(operation: MobileSyncOperation, localChangedAtMilliseconds: Int64) {
        self.operation = operation
        self.localChangedAtMilliseconds = localChangedAtMilliseconds
    }
}

/// UI/data-repository boundary layered beside `SyncRepository`.
///
/// A local entity cannot be written without its pending operation. This API intentionally has no
/// mirror-only mutation method, making the local-write atomicity rule structural.
public protocol SyncMirrorStore: Sendable {
    func entity(
        type: String,
        id: String,
        for identity: SyncBindingIdentity
    ) async throws -> SyncMirrorEntity?

    func entities(type: String, for identity: SyncBindingIdentity) async throws -> [SyncMirrorEntity]
    func conflicts(for identity: SyncBindingIdentity) async throws -> [SyncConflictRecord]
    func runState(for identity: SyncBindingIdentity) async throws -> SyncRunState

    @discardableResult
    func writeLocal(_ write: SyncLocalWrite, for identity: SyncBindingIdentity) async throws
        -> SyncMirrorEntity?

    /// Removes a row and all queued/conflict material that could recreate it.
    func purgeEntity(type: String, id: String, for identity: SyncBindingIdentity) async throws

    /// Logout/unbind erasure. Once called, this repository no longer has an active snapshot.
    func purgeAll(for identity: SyncBindingIdentity) async throws
}

public enum SQLiteSyncRepositoryError: Error, Equatable, Sendable {
    case bindingChanged
    case inactiveBinding
    case invalidBindingRecordVersion
    case missingDatabaseKey
    case plaintextDatabaseRejected
    case databaseAuthenticationFailed
    case databaseIntegrityFailed(String)
    case legacyOwnerMismatch
    case invalidLocalWrite(String)
    case invalidChangePage(String)
    case invalidBootstrap(String)
    case corruptRecord(String)
    case database(code: Int32, message: String)
}
