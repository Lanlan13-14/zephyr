import CryptoKit
import Darwin
import Foundation
import SQLCipher
import ZephyrContracts

private func trustedSQLiteLocation(
    for url: URL,
    allowMissingParentTail: Bool = false
) throws -> String {
    guard !url.path.contains("\u{0}"),
          url.path == url.standardizedFileURL.path else {
        throw SQLiteSyncRepositoryError.databaseIntegrityFailed("unsafe_database_directory")
    }
    let parent = url.deletingLastPathComponent()
    let components = parent.pathComponents
    guard url.isFileURL, components.first == "/", components.count > 1,
          !url.lastPathComponent.isEmpty else {
        throw SQLiteSyncRepositoryError.databaseIntegrityFailed("unsafe_database_directory")
    }

    // URL directory paths may gain a trailing slash, which makes lstat follow
    // a final symlink. Keep every path passed to lstat as an explicit string.
    let topLevelPath = "/" + components[1]
    var topLevelStatus = stat()
    guard lstat(topLevelPath, &topLevelStatus) == 0 else {
        throw SQLiteSyncRepositoryError.databaseIntegrityFailed("unsafe_database_directory")
    }
    var trustedParentPath: String
    if (topLevelStatus.st_mode & S_IFMT) == S_IFLNK {
        // Darwin exposes root-owned compatibility aliases such as /var ->
        // /private/var. Resolve only this privileged boundary; resolving any
        // caller-controlled descendant would bypass SQLite's NOFOLLOW jail.
        guard topLevelStatus.st_uid == 0 else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("unsafe_database_directory")
        }
        guard let resolvedTopLevel = Darwin.realpath(topLevelPath, nil) else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("unsafe_database_directory")
        }
        defer { free(resolvedTopLevel) }
        guard let resolvedTopLevelPath = String(validatingUTF8: resolvedTopLevel) else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("unsafe_database_directory")
        }
        // realpath already returned the physical canonical path. Foundation
        // may rewrite it to a compatibility alias (for example /private/var
        // back to /var), so validate its POSIX bytes without URL round-trips.
        let resolvedBytes = Array(resolvedTopLevelPath.utf8)
        guard resolvedBytes.first == 0x2F,
              resolvedBytes.count > 1,
              resolvedBytes.last != 0x2F else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("unsafe_database_directory")
        }
        let resolvedComponents = resolvedBytes.dropFirst().split(
            separator: 0x2F,
            omittingEmptySubsequences: false
        )
        guard resolvedComponents.allSatisfy({ component in
            !component.isEmpty
                && !component.elementsEqual([0x2E])
                && !component.elementsEqual([0x2E, 0x2E])
        }) else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("unsafe_database_directory")
        }
        var resolvedStatus = stat()
        guard lstat(resolvedTopLevelPath, &resolvedStatus) == 0,
              (resolvedStatus.st_mode & S_IFMT) == S_IFDIR else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("unsafe_database_directory")
        }
        trustedParentPath = resolvedTopLevelPath
    } else {
        guard (topLevelStatus.st_mode & S_IFMT) == S_IFDIR else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("unsafe_database_directory")
        }
        trustedParentPath = topLevelPath
    }

    for component in components.dropFirst(2) {
        let candidatePath = trustedParentPath + "/" + component
        var status = stat()
        if lstat(candidatePath, &status) == 0 {
            guard (status.st_mode & S_IFMT) == S_IFDIR else {
                throw SQLiteSyncRepositoryError.databaseIntegrityFailed("unsafe_database_directory")
            }
            trustedParentPath = candidatePath
            continue
        }
        if allowMissingParentTail, errno == ENOENT {
            trustedParentPath = candidatePath
            continue
        } else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("unsafe_database_directory")
        }
    }
    return trustedParentPath + "/" + url.lastPathComponent
}

public struct SQLiteSyncMigrationHooks: Sendable {
    public enum Stage: Equatable, Sendable {
        /// The authenticated, empty staging inode is durably visible. Throwing
        /// from this hook models process death and intentionally leaves it for
        /// the next initializer's ownership-verified recovery path.
        case stagingPublished
        case encryptedCopyReady
        case beforePromotion
        case promoted
    }

    public static let none = SQLiteSyncMigrationHooks()

    private let action: @Sendable (Stage) throws -> Void

    public init(action: @escaping @Sendable (Stage) throws -> Void = { _ in }) {
        self.action = action
    }

    fileprivate func callAsFunction(_ stage: Stage) throws {
        try action(stage)
    }
}

/// Applies the storage policy required for sync metadata and encrypted envelopes.
///
/// The directory is protected before SQLite creates the database or WAL sidecars, so newly-created
/// files inherit iOS data protection. Backup exclusion is applied to both the directory and every
/// currently present SQLite file. Plaintext secrets do not belong in this database.
public struct SQLiteSyncDatabaseFilePolicy: Sendable {
    public static let iOSProtectionClassName = "NSFileProtectionComplete"

    public init() {}

    public func prepare(databaseURL: URL) throws {
        try prepareDirectory(databaseURL: databaseURL)
        try refresh(databaseURL: databaseURL)
    }

    fileprivate func prepareDirectory(databaseURL: URL) throws {
        let directory = databaseURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        #if os(iOS) || os(tvOS) || os(watchOS)
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: directory.path
        )
        #endif

        try excludeFromBackup(directory)
    }

    fileprivate func refresh(databaseURL: URL) throws {
        for url in [
            databaseURL,
            URL(fileURLWithPath: databaseURL.path + "-wal"),
            URL(fileURLWithPath: databaseURL.path + "-shm"),
        ] where FileManager.default.fileExists(atPath: url.path) {
            #if os(iOS) || os(tvOS) || os(watchOS)
            try FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.complete],
                ofItemAtPath: url.path
            )
            #endif
            try excludeFromBackup(url)
        }
    }

    private func excludeFromBackup(_ url: URL) throws {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableURL = url
        try mutableURL.setResourceValues(values)
    }
}

/// Durable, binding-scoped SQLCipher implementation of both sync persistence ports.
///
/// Every table and the database key carry server, account, device and binding-generation scope.
/// `sync_state` additionally carries the random binding-record version and runnable bit. Every
/// ordinary read and mutation verifies that complete lease in its SQLite transaction, so a
/// same-generation active/restoring handoff fences retained runtimes without deleting mirror data.
public actor SQLiteSyncRepository: SyncRepository, SyncMirrorStore {
    public nonisolated let databaseURL: URL

    private let identity: SyncBindingIdentity
    private let database: SQLiteDatabase
    private let filePolicy: SQLiteSyncDatabaseFilePolicy
    private let keyStore: any SyncDatabaseKeyStoring
    private let keyScope: SyncDatabaseKeyScope
    private var databasePreparedForDeletion = false
    private var fullyPurged = false

    public init(
        databaseURL: URL,
        identity: SyncBindingIdentity,
        initialState: BindingState = .boundNeedsBootstrap,
        requireExistingBinding: Bool = false,
        cleanupOnly: Bool = false,
        filePolicy: SQLiteSyncDatabaseFilePolicy = SQLiteSyncDatabaseFilePolicy(),
        keyStore: any SyncDatabaseKeyStoring = KeychainSyncDatabaseKeyStore.shared,
        legacyDatabaseURL: URL? = nil,
        migrationHooks: SQLiteSyncMigrationHooks = .none
    ) throws {
        guard !identity.serverID.isEmpty,
              !identity.accountID.isEmpty,
              !identity.deviceID.isEmpty,
              !identity.generation.isEmpty else {
            throw SQLiteSyncRepositoryError.invalidLocalWrite("binding identity contains an empty component")
        }
        guard Self.isValidRecordVersion(identity.bindingRecordVersion) else {
            throw SQLiteSyncRepositoryError.invalidBindingRecordVersion
        }

        self.databaseURL = databaseURL
        self.identity = identity
        self.filePolicy = filePolicy
        self.keyStore = keyStore
        let resolvedKeyScope = try SyncDatabaseKeyScope(identity: identity)
        self.keyScope = resolvedKeyScope

        // Validate every existing ancestor before createDirectory can follow
        // one. A missing tail is allowed here, then strictly re-proved after
        // creation. Final database paths remain untouched until lstat below.
        _ = try trustedSQLiteLocation(for: databaseURL, allowMissingParentTail: true)
        if let legacyDatabaseURL {
            _ = try trustedSQLiteLocation(for: legacyDatabaseURL, allowMissingParentTail: true)
        }
        // Prepare only the trusted parent before opening. Final database paths
        // are not passed through URL resource APIs until SQLite has opened
        // them with SQLITE_OPEN_NOFOLLOW.
        try filePolicy.prepareDirectory(databaseURL: databaseURL)
        try Self.requireSafeDatabaseDirectory(at: databaseURL)
        let hasTargetArtifacts = try Self.requireSafeTargetArtifacts(at: databaseURL)
        let legacyExists: Bool
        if let legacyDatabaseURL {
            legacyExists = try Self.requireSafeTargetArtifacts(at: legacyDatabaseURL)
            if legacyExists {
                try Self.requireSafeDatabaseDirectory(at: legacyDatabaseURL)
            }
        } else {
            legacyExists = false
        }

        if requireExistingBinding && !hasTargetArtifacts && !legacyExists {
            throw SQLiteSyncRepositoryError.inactiveBinding
        }

        let existingKey = try keyStore.loadKey(for: resolvedKeyScope)
        // A fixed staging name is an untrusted collision until its xattr
        // authenticates the canonical path and complete binding identity with
        // the already-durable SQLCipher key. Classify it even when the final
        // target exists, and deliberately do so before loadOrCreateKey: hostile
        // leftovers must neither manufacture fresh Keychain state nor persist
        // unnoticed beside a successfully promoted target.
        try Self.recoverOwnedMigrationStagingIfPresent(
            for: databaseURL,
            key: existingKey,
            identity: identity,
            legacyURL: legacyExists ? legacyDatabaseURL : nil,
            requiresLegacyOwner: !hasTargetArtifacts
        )
        let databaseKey: Data
        if hasTargetArtifacts {
            guard let existingKey else {
                throw SQLiteSyncRepositoryError.missingDatabaseKey
            }
            databaseKey = existingKey
        } else if cleanupOnly && !legacyExists {
            // A crash may occur after files and key are erased but before the
            // cleanup-pending binding record is cleared. An in-memory handle
            // lets that retry finish without recreating durable state.
            databaseKey = existingKey ?? Data(repeating: 0, count: KeychainSyncDatabaseKeyStore.keyByteCount)
        } else {
            databaseKey = try keyStore.loadOrCreateKey(for: resolvedKeyScope)
        }

        if !hasTargetArtifacts, let legacyDatabaseURL, legacyExists {
            try Self.migrateLegacyDatabase(
                at: legacyDatabaseURL,
                to: databaseURL,
                key: databaseKey,
                identity: identity,
                filePolicy: filePolicy,
                hooks: migrationHooks
            )
        }

        // Owner-proven migration can promote an absent target. Re-classify the
        // final path so promoted databases are opened existing-only, while a
        // genuinely absent target is the sole path allowed to use CREATE.
        let targetExistsAfterMigration = try Self.requireSafeTargetArtifacts(at: databaseURL)
        let opened: SQLiteDatabase
        if cleanupOnly && !targetExistsAfterMigration {
            opened = try SQLiteDatabase.inMemory(key: databaseKey)
        } else {
            opened = try SQLiteDatabase(
                url: databaseURL,
                key: databaseKey,
                createNew: !targetExistsAfterMigration
            )
        }
        self.database = opened
        try Self.migrate(opened)
        if cleanupOnly {
            // Cleanup must remain retryable after a crash between repository erasure and
            // credential destruction. In that state sync_state is intentionally already gone.
        } else if requireExistingBinding {
            try Self.requireExisting(identity, in: opened)
        } else {
            try Self.activate(identity, initialState: initialState, in: opened)
        }
        if !cleanupOnly {
            try Self.recoverInterruptedWork(identity, in: opened)
            try Self.requireAllMirrorOwners(identity, in: opened)
            try Self.requireAllTombstoneOwners(identity, in: opened)
        }
        do {
            // Opening verifies every existing disk page before migration or
            // binding access. Checkpoint and re-check after initialization so
            // pages written by schema and recovery work cannot remain only in
            // WAL and escape the complete encrypted-file scan.
            try opened.verifyInitializedCipherIntegrity()
        } catch {
            try? opened.close()
            throw error
        }
        try filePolicy.refresh(databaseURL: databaseURL)
        if FileManager.default.fileExists(atPath: databaseURL.path) {
            try Self.requireEncryptedHeader(at: databaseURL)
        }
        if let legacyDatabaseURL,
           legacyDatabaseURL.standardizedFileURL != databaseURL.standardizedFileURL,
           Self.hasDatabaseArtifacts(at: legacyDatabaseURL) {
            try filePolicy.prepare(databaseURL: legacyDatabaseURL)
            try Self.removeLegacyDatabaseIfOwned(at: legacyDatabaseURL, identity: identity)
        }
    }

    /// A stable, non-identifying file name for exactly one binding generation.
    public static func bindingDatabaseURL(
        in directory: URL,
        identity: SyncBindingIdentity
    ) -> URL {
        let key = Data([
            identity.serverID,
            identity.accountID,
            identity.deviceID,
            identity.generation,
        ].joined(separator: "\u{0}").utf8)
        let digest = SHA256.hash(data: key).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent("sync-" + digest + ".sqlite3", isDirectory: false)
    }

    /// Location used by the pre-SQLCipher account-scoped repository. It is
    /// consulted only by owner-proven one-time migration.
    public static func legacyAccountDatabaseURL(
        in directory: URL,
        serverID: String,
        accountID: String
    ) -> URL {
        let key = Data((serverID + "\u{0}" + accountID).utf8)
        let digest = SHA256.hash(data: key).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent("sync-" + digest + ".sqlite3", isDirectory: false)
    }

    // MARK: - SyncRepository

    public func snapshot() async throws -> SyncRepositorySnapshot? {
        guard let state = try currentStateRow() else { return nil }
        let checkpoint = try bootstrapCheckpoint(state.identity)
        return SyncRepositorySnapshot(
            identity: state.identity,
            runtimeLeaseState: state.runtimeLeaseState,
            bindingState: state.bindingState,
            appliedCursor: state.appliedCursor,
            acknowledgedCursor: state.acknowledgedCursor,
            snapshotCursor: state.snapshotCursor,
            registryHash: state.registryHash,
            consecutiveFailures: state.consecutiveFailures,
            nextEligibleAtMilliseconds: state.nextEligibleAt,
            bootstrapCheckpoint: checkpoint
        )
    }

    public func runnableSnapshot(
        for requestedIdentity: SyncBindingIdentity
    ) async throws -> SyncRepositorySnapshot? {
        guard requestedIdentity.hasSameBindingGeneration(as: identity),
              Self.isValidRecordVersion(requestedIdentity.bindingRecordVersion) else {
            return nil
        }
        var result: SyncRepositorySnapshot?
        try database.transaction {
            guard let state = try currentStateRow(), state.identity == requestedIdentity,
                  state.runtimeLeaseState == .runnable else { return }
            result = SyncRepositorySnapshot(
                identity: state.identity,
                runtimeLeaseState: state.runtimeLeaseState,
                bindingState: state.bindingState,
                appliedCursor: state.appliedCursor,
                acknowledgedCursor: state.acknowledgedCursor,
                snapshotCursor: state.snapshotCursor,
                registryHash: state.registryHash,
                consecutiveFailures: state.consecutiveFailures,
                nextEligibleAtMilliseconds: state.nextEligibleAt,
                bootstrapCheckpoint: try bootstrapCheckpoint(requestedIdentity)
            )
        }
        return result
    }

    public func fenceRuntime(
        from current: SyncBindingIdentity,
        to fenced: SyncBindingIdentity
    ) async throws {
        try requireLeaseTransition(from: current, to: fenced)
        try database.transaction {
            let state = try currentStateRowRequired()
            guard state.identity == current else {
                throw SQLiteSyncRepositoryError.bindingChanged
            }
            try database.execute(
                """
                UPDATE sync_state
                SET binding_record_version = ?, runtime_runnable = 0
                WHERE \(Self.bindingKeyWhere) AND generation = ?
                  AND binding_record_version = ?
                """,
                [.blob(fenced.bindingRecordVersion)]
                    + Self.scopeBindings(current, includeGeneration: false)
                    + [.text(current.generation), .blob(current.bindingRecordVersion)]
            )
        }
        try? filePolicy.refresh(databaseURL: databaseURL)
    }

    public func publishRuntime(
        from fenced: SyncBindingIdentity,
        to active: SyncBindingIdentity
    ) async throws {
        try requireLeaseTransition(from: fenced, to: active)
        try database.transaction {
            let state = try currentStateRowRequired()
            guard state.identity == fenced, state.runtimeLeaseState == .fenced else {
                throw SQLiteSyncRepositoryError.bindingChanged
            }
            try database.execute(
                """
                UPDATE sync_state
                SET binding_record_version = ?, runtime_runnable = 1
                WHERE \(Self.bindingKeyWhere) AND generation = ?
                  AND binding_record_version = ? AND runtime_runnable = 0
                """,
                [.blob(active.bindingRecordVersion)]
                    + Self.scopeBindings(fenced, includeGeneration: false)
                    + [.text(fenced.generation), .blob(fenced.bindingRecordVersion)]
            )
        }
        try? filePolicy.refresh(databaseURL: databaseURL)
    }

    public func recordAttempt(at milliseconds: Int64, for identity: SyncBindingIdentity) async throws {
        try mutate(for: identity) {
            try database.execute(
                "UPDATE sync_state SET last_attempt_at = ? WHERE " + Self.bindingKeyWhere,
                [.integer(milliseconds)] + Self.scopeBindings(identity, includeGeneration: false)
            )
        }
    }

    public func saveBindingState(_ state: BindingState, for identity: SyncBindingIdentity) async throws {
        try mutate(for: identity) {
            try database.execute(
                "UPDATE sync_state SET binding_state = ? WHERE " + Self.bindingKeyWhere,
                [.text(state.rawValue)] + Self.scopeBindings(identity, includeGeneration: false)
            )
        }
    }

    public func saveRegistryHash(_ hash: String, for identity: SyncBindingIdentity) async throws {
        try mutate(for: identity) {
            try database.execute(
                "UPDATE sync_state SET registry_hash = ? WHERE " + Self.bindingKeyWhere,
                [.text(hash)] + Self.scopeBindings(identity, includeGeneration: false)
            )
        }
    }

    public func resetBootstrap(for identity: SyncBindingIdentity) async throws {
        try mutate(for: identity) {
            try deleteScopedRows(table: "bootstrap_entities", identity: identity)
            try deleteScopedRows(table: "bootstrap_runs", identity: identity)
        }
    }

    public func stageBootstrapPage(
        _ page: MobileBootstrapResponse,
        requestedPageToken: String?,
        stagingGeneration: String,
        continuation: SyncBootstrapCheckpoint?,
        for identity: SyncBindingIdentity
    ) async throws -> Int {
        guard !stagingGeneration.isEmpty else {
            throw SQLiteSyncRepositoryError.invalidBootstrap("empty staging generation")
        }

        var staged = 0
        try mutate(for: identity) {
            let run = try bootstrapRun(identity)
            if let run {
                guard !run.complete,
                      run.stagingGeneration == stagingGeneration,
                      run.bootstrapId == page.bootstrapId,
                      run.snapshotCursor == page.snapshotCursor,
                      run.nextPageToken == requestedPageToken
                else {
                    throw SQLiteSyncRepositoryError.invalidBootstrap("bootstrap page does not continue the durable checkpoint")
                }
            } else if requestedPageToken != nil {
                throw SQLiteSyncRepositoryError.invalidBootstrap("bootstrap continuation has no durable checkpoint")
            }

            if page.complete {
                guard continuation == nil, page.nextPageToken == nil else {
                    throw SQLiteSyncRepositoryError.invalidBootstrap("complete bootstrap page carries a continuation")
                }
            } else {
                guard let continuation,
                      continuation.stagingGeneration == stagingGeneration,
                      continuation.bootstrapId == page.bootstrapId,
                      continuation.snapshotCursor == page.snapshotCursor,
                      continuation.nextPageToken == page.nextPageToken
                else {
                    throw SQLiteSyncRepositoryError.invalidBootstrap("incomplete bootstrap page has an inconsistent checkpoint")
                }
            }

            for change in page.entities {
                guard EntityRegistry.byType[change.entityType] != nil else { continue }
                guard Self.belongsToBinding(change, identity: identity) else {
                    throw SQLiteSyncRepositoryError.invalidBootstrap(
                        "entity owner is missing or does not match the binding"
                    )
                }

                if change.action == .delete {
                    try database.execute(
                        "DELETE FROM bootstrap_entities WHERE " + Self.scopeWhere
                            + " AND staging_generation = ? AND entity_type = ? AND entity_id = ?",
                        Self.scopeBindings(identity) + [
                            .text(stagingGeneration), .text(change.entityType), .text(change.entityId),
                        ]
                    )
                    continue
                }

                try database.execute(
                    """
                    INSERT INTO bootstrap_entities (
                        server_id, account_id, device_id, generation, staging_generation,
                        entity_type, entity_id, revision, changed_at, field_mask, payload, secret_envelopes
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(server_id, account_id, device_id, generation, staging_generation, entity_type, entity_id)
                    DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at,
                                  field_mask = excluded.field_mask, payload = excluded.payload,
                                  secret_envelopes = excluded.secret_envelopes
                    """,
                    Self.scopeBindings(identity) + [
                        .text(stagingGeneration),
                        .text(change.entityType),
                        .text(change.entityId),
                        .integer(change.revision),
                        .integer(change.changedAt),
                        .blob(try Self.encode(change.fieldMask)),
                        .blob(try Self.encode(change.payload)),
                        .blob(try Self.encode(change.secretEnvelopes ?? [:])),
                    ]
                )
                staged += 1
            }

            let pagesFetched = continuation?.pagesFetched ?? ((run?.pagesFetched ?? 0) + 1)
            let entitiesStaged = (run?.entitiesStaged ?? 0) + staged
            try database.execute(
                """
                INSERT INTO bootstrap_runs (
                    server_id, account_id, device_id, generation, staging_generation,
                    bootstrap_id, snapshot_cursor, next_page_token, pages_fetched,
                    entities_staged, expires_at, complete
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(server_id, account_id, device_id, generation)
                DO UPDATE SET staging_generation = excluded.staging_generation,
                              bootstrap_id = excluded.bootstrap_id,
                              snapshot_cursor = excluded.snapshot_cursor,
                              next_page_token = excluded.next_page_token,
                              pages_fetched = excluded.pages_fetched,
                              entities_staged = excluded.entities_staged,
                              expires_at = excluded.expires_at,
                              complete = excluded.complete
                """,
                Self.scopeBindings(identity) + [
                    .text(stagingGeneration),
                    .text(page.bootstrapId),
                    .integer(page.snapshotCursor),
                    Self.optionalText(page.nextPageToken),
                    .integer(Int64(pagesFetched)),
                    .integer(Int64(entitiesStaged)),
                    continuation.map { .integer($0.expiresAtMilliseconds) } ?? .null,
                    .integer(page.complete ? 1 : 0),
                ]
            )
        }
        return staged
    }

    public func commitBootstrap(
        stagingGeneration: String,
        snapshotCursor: Int64,
        for identity: SyncBindingIdentity
    ) async throws {
        try mutate(for: identity) {
            guard let run = try bootstrapRun(identity),
                  run.complete,
                  run.stagingGeneration == stagingGeneration,
                  run.snapshotCursor == snapshotCursor
            else {
                throw SQLiteSyncRepositoryError.invalidBootstrap("only a complete staged generation can be promoted")
            }
            try Self.promoteCompleteBootstrap(run, identity: identity, in: database)
        }
    }

    public func pendingOperations(
        limit: Int,
        for identity: SyncBindingIdentity
    ) async throws -> [MobileSyncOperation] {
        guard limit > 0 else { return [] }
        return try read(for: identity) {
            let rows = try database.query(
                "SELECT operation FROM pending_operations WHERE " + Self.scopeWhere
                    + " ORDER BY created_at, op_id LIMIT ?",
                Self.scopeBindings(identity) + [.integer(Int64(limit))]
            )
            return try rows.map { try Self.decode(MobileSyncOperation.self, from: $0.blob(0)) }
        }
    }

    public func markDispatched(
        opIds: [String],
        batchId: String,
        at milliseconds: Int64,
        for identity: SyncBindingIdentity
    ) async throws {
        guard !opIds.isEmpty else { return }
        try mutate(for: identity) {
            for opId in Set(opIds) {
                try database.execute(
                    """
                    UPDATE pending_operations
                    SET batch_id = ?, dispatched_at = ?, attempt_count = attempt_count + 1
                    WHERE \(Self.scopeWhere) AND op_id = ?
                    """,
                    [.text(batchId), .integer(milliseconds)] + Self.scopeBindings(identity) + [.text(opId)]
                )
            }
        }
    }

    public func applyPushOutcomes(
        _ outcomes: [SyncPushOutcome],
        for identity: SyncBindingIdentity
    ) async throws {
        guard !outcomes.isEmpty else { return }
        try mutate(for: identity) {
            for outcome in outcomes {
                guard let operation = try pendingOperation(outcome.opId, identity: identity) else {
                    // A response replay after the local commit is already complete.
                    continue
                }

                switch outcome {
                case .completed(let opId, _, let revision, _):
                    try database.execute(
                        """
                        INSERT OR REPLACE INTO applied_operations (
                            server_id, account_id, device_id, generation, op_id,
                            entity_type, entity_id, revision, applied_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        Self.scopeBindings(identity) + [
                            .text(opId), .text(operation.entityType), .text(operation.entityId),
                            .integer(revision), .integer(operation.clientModifiedAt ?? 0),
                        ]
                    )
                    try deletePending(opId, identity: identity)
                    try database.execute(
                        "UPDATE mirror_entities SET revision = ? WHERE " + Self.scopeWhere
                            + " AND entity_type = ? AND entity_id = ?",
                        [.integer(revision)] + Self.scopeBindings(identity)
                            + [.text(operation.entityType), .text(operation.entityId)]
                    )
                    try refreshPendingFlag(operation.entityType, operation.entityId, identity: identity)

                case .conflicted(let conflict):
                    if conflict.serverDeleted || conflict.aclRevoked {
                        try purgeEntityRows(type: conflict.entityType, id: conflict.entityId, identity: identity)
                        try database.execute(
                            """
                            INSERT OR REPLACE INTO tombstones (
                                server_id, account_id, device_id, generation, entity_type,
                                entity_id, owner_id, revision, deleted_at, authoritative
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                            Self.scopeBindings(identity) + [
                                .text(conflict.entityType), .text(conflict.entityId),
                                .text(try Self.ownerValue(
                                    entityType: conflict.entityType,
                                    identity: identity
                                ).value),
                                .integer(conflict.serverRevision), .integer(0),
                                .integer(conflict.aclRevoked ? 1 : 0),
                            ]
                        )
                    } else {
                        try storeConflict(conflict, identity: identity)
                        try deletePending(conflict.opId, identity: identity)
                        try refreshPendingFlag(conflict.entityType, conflict.entityId, identity: identity)
                    }

                case .failed(let opId, let errorCode, let drop):
                    if drop {
                        try deletePending(opId, identity: identity)
                        try refreshPendingFlag(operation.entityType, operation.entityId, identity: identity)
                    } else {
                        try database.execute(
                            "UPDATE pending_operations SET last_error = ? WHERE " + Self.scopeWhere + " AND op_id = ?",
                            [.text(errorCode)] + Self.scopeBindings(identity) + [.text(opId)]
                        )
                    }
                }
            }
        }
    }

    public func applyChangePage(
        _ page: MobileChangesResponse,
        expectedCursor: Int64,
        for identity: SyncBindingIdentity
    ) async throws -> SyncApplyResult {
        var applied = 0
        var skipped = 0
        try mutate(for: identity) {
            guard page.fromCursor == expectedCursor, page.nextCursor >= expectedCursor else {
                throw SQLiteSyncRepositoryError.invalidChangePage("change page cursor does not match the request")
            }
            guard try currentAppliedCursor(identity) == expectedCursor else {
                throw SQLiteSyncRepositoryError.invalidChangePage("durable cursor changed before page commit")
            }

            for change in page.changes {
                guard change.changeSeq > expectedCursor, change.changeSeq <= page.nextCursor else {
                    throw SQLiteSyncRepositoryError.invalidChangePage("change sequence lies outside the page cursor range")
                }
                guard EntityRegistry.byType[change.entityType] != nil else {
                    skipped += 1
                    continue
                }
                guard Self.belongsToBinding(change, identity: identity) else {
                    throw SQLiteSyncRepositoryError.invalidChangePage(
                        "entity owner is missing or does not match the binding"
                    )
                }

                let existing = try mirrorEntityRow(change.entityType, change.entityId, identity: identity)
                if change.action == .delete {
                    let aclTarget = change.entityType == "resourceAcl"
                        ? Self.aclTarget(change.payload, change.tombstone, existing?.payload)
                        : nil
                    try purgeEntityRows(type: change.entityType, id: change.entityId, identity: identity)
                    try storeTombstone(change, authoritative: change.entityType == "resourceAcl", identity: identity)
                    if let aclTarget {
                        try purgeEntityRows(type: aclTarget.type, id: aclTarget.id, identity: identity)
                        try storeTombstone(
                            type: aclTarget.type,
                            id: aclTarget.id,
                            revision: change.revision,
                            deletedAt: change.changedAt,
                            authoritative: true,
                            identity: identity
                        )
                    }
                    applied += 1
                    continue
                }

                if let existing, existing.revision >= change.revision {
                    skipped += 1
                    continue
                }

                let payload = change.fieldMask.isEmpty
                    ? change.payload
                    : Self.merge(existing?.payload ?? [:], with: change.payload, fieldMask: change.fieldMask)
                let envelopes = Self.mergeEnvelopes(existing?.secretEnvelopes ?? [:], change.secretEnvelopes ?? [:])
                try upsertMirror(
                    type: change.entityType,
                    id: change.entityId,
                    revision: change.revision,
                    serverChangedAt: change.changedAt,
                    localChangedAt: existing?.localChangedAt ?? change.changedAt,
                    fieldMask: change.fieldMask,
                    payload: payload,
                    secretEnvelopes: envelopes,
                    hasPending: false,
                    identity: identity
                )
                try deleteTombstone(type: change.entityType, id: change.entityId, identity: identity)
                try replayPending(type: change.entityType, id: change.entityId, identity: identity)

                if change.entityType == "resourceAcl",
                   Self.isRevokedACL(change.payload),
                   let target = Self.aclTarget(change.payload, change.tombstone, existing?.payload) {
                    try purgeEntityRows(type: target.type, id: target.id, identity: identity)
                    try storeTombstone(
                        type: target.type,
                        id: target.id,
                        revision: change.revision,
                        deletedAt: change.changedAt,
                        authoritative: true,
                        identity: identity
                    )
                }
                applied += 1
            }

            try database.execute(
                "UPDATE sync_state SET applied_cursor = ? WHERE " + Self.bindingKeyWhere,
                [.integer(page.nextCursor)] + Self.scopeBindings(identity, includeGeneration: false)
            )
        }
        return SyncApplyResult(applied: applied, skipped: skipped)
    }

    public func saveAcknowledgedCursor(
        _ cursor: Int64,
        for identity: SyncBindingIdentity
    ) async throws {
        try mutate(for: identity) {
            let state = try currentStateRowRequired()
            guard cursor >= state.acknowledgedCursor, cursor <= state.appliedCursor else {
                throw SQLiteSyncRepositoryError.invalidChangePage("acknowledged cursor is outside the applied range")
            }
            try database.execute(
                "UPDATE sync_state SET acknowledged_cursor = ? WHERE " + Self.bindingKeyWhere,
                [.integer(cursor)] + Self.scopeBindings(identity, includeGeneration: false)
            )
        }
    }

    public func recordSuccess(at milliseconds: Int64, for identity: SyncBindingIdentity) async throws {
        try mutate(for: identity) {
            try database.execute(
                """
                UPDATE sync_state
                SET last_success_at = ?, last_error_code = NULL, last_error_diagnostic = NULL,
                    consecutive_failures = 0, next_eligible_at = NULL
                WHERE \(Self.bindingKeyWhere)
                """,
                [.integer(milliseconds)] + Self.scopeBindings(identity, includeGeneration: false)
            )
        }
    }

    public func recordFailure(
        at milliseconds: Int64,
        error: MobileApiError,
        nextEligibleAtMilliseconds: Int64?,
        for identity: SyncBindingIdentity
    ) async throws {
        try mutate(for: identity) {
            try database.execute(
                """
                UPDATE sync_state
                SET last_attempt_at = ?, last_error_code = ?, last_error_diagnostic = ?,
                    consecutive_failures = consecutive_failures + 1, next_eligible_at = ?
                WHERE \(Self.bindingKeyWhere)
                """,
                [
                    .integer(milliseconds), .text(error.code), .text(error.description),
                    nextEligibleAtMilliseconds.map(SQLiteValue.integer) ?? .null,
                ] + Self.scopeBindings(identity, includeGeneration: false)
            )
        }
    }

    // MARK: - SyncMirrorStore

    public func entity(
        type: String,
        id: String,
        for identity: SyncBindingIdentity
    ) async throws -> SyncMirrorEntity? {
        try read(for: identity) {
            try mirrorEntityRow(type, id, identity: identity)?.model
        }
    }

    public func entities(
        type: String,
        for identity: SyncBindingIdentity
    ) async throws -> [SyncMirrorEntity] {
        try read(for: identity) {
            let rows = try database.query(
                """
                SELECT entity_type, entity_id, revision, server_changed_at, local_changed_at,
                       field_mask, payload, secret_envelopes, has_pending
                FROM mirror_entities
                WHERE \(Self.scopeWhere) AND entity_type = ?
                ORDER BY entity_id
                """,
                Self.scopeBindings(identity) + [.text(type)]
            )
            return try rows.map { row in
                let decoded = try Self.decodeMirrorRow(row)
                try Self.requireMirrorOwner(decoded, identity: identity)
                return decoded.model
            }
        }
    }

    public func conflicts(for identity: SyncBindingIdentity) async throws -> [SyncConflictRecord] {
        try read(for: identity) {
            let rows = try database.query(
                """
                SELECT op_id, entity_type, entity_id, local_base_revision, local_field_mask,
                       local_payload, local_secret_envelopes, server_revision, server_payload,
                       overlap_fields, server_deleted, acl_revoked
                FROM conflicts WHERE \(Self.scopeWhere) ORDER BY created_at, op_id
                """,
                Self.scopeBindings(identity)
            )
            return try rows.map { row in
                SyncConflictRecord(
                    opId: row.text(0),
                    entityType: row.text(1),
                    entityId: row.text(2),
                    localBaseRevision: row.integer(3),
                    localFieldMask: try Self.decode([String].self, from: row.blob(4)),
                    localPayload: try Self.decode([String: MobileJSONValue].self, from: row.blob(5)),
                    localSecretEnvelopes: try Self.decode(
                        [String: MobileSecretEnvelope].self,
                        from: row.blob(6)
                    ),
                    serverRevision: row.integer(7),
                    serverPayload: try Self.decode([String: MobileJSONValue].self, from: row.blob(8)),
                    overlapFields: try Self.decode([String].self, from: row.blob(9)),
                    serverDeleted: row.integer(10) != 0,
                    aclRevoked: row.integer(11) != 0
                )
            }
        }
    }

    public func runState(for identity: SyncBindingIdentity) async throws -> SyncRunState {
        try read(for: identity) {
            let row = try database.queryOne(
                """
                SELECT last_attempt_at, last_success_at, last_error_code, last_error_diagnostic,
                       consecutive_failures, next_eligible_at
                FROM sync_state WHERE \(Self.bindingKeyWhere)
                """,
                Self.scopeBindings(identity, includeGeneration: false)
            )
            guard let row else { throw SQLiteSyncRepositoryError.inactiveBinding }
            return SyncRunState(
                lastAttemptAtMilliseconds: row.optionalInteger(0),
                lastSuccessAtMilliseconds: row.optionalInteger(1),
                lastErrorCode: row.optionalText(2),
                lastErrorDiagnostic: row.optionalText(3),
                consecutiveFailures: Int(row.integer(4)),
                nextEligibleAtMilliseconds: row.optionalInteger(5)
            )
        }
    }

    @discardableResult
    public func writeLocal(
        _ write: SyncLocalWrite,
        for identity: SyncBindingIdentity
    ) async throws -> SyncMirrorEntity? {
        try Self.validate(write.operation)
        var result: SyncMirrorEntity?
        try mutate(for: identity) {
            let operation = write.operation
            guard try pendingOperation(operation.opId, identity: identity) == nil else {
                throw SQLiteSyncRepositoryError.invalidLocalWrite("opId already exists")
            }
            try Self.applyLocalOperation(
                operation,
                changedAt: write.localChangedAtMilliseconds,
                validateBaseRevision: true,
                identity: identity,
                database: database
            )
            try database.execute(
                """
                INSERT INTO pending_operations (
                    server_id, account_id, device_id, generation, op_id, entity_type, entity_id,
                    action, base_revision, field_mask, operation, created_at, attempt_count
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                """,
                Self.scopeBindings(identity) + [
                    .text(operation.opId), .text(operation.entityType), .text(operation.entityId),
                    .text(operation.action.rawValue), .integer(operation.baseRevision),
                    .blob(try Self.encode(operation.fieldMask)),
                    .blob(try Self.encode(operation)),
                    .integer(write.localChangedAtMilliseconds),
                ]
            )
            try refreshPendingFlag(operation.entityType, operation.entityId, identity: identity)
            result = try mirrorEntityRow(operation.entityType, operation.entityId, identity: identity)?.model
        }
        return result
    }

    public func purgeEntity(
        type: String,
        id: String,
        for identity: SyncBindingIdentity
    ) async throws {
        try mutate(for: identity) {
            try purgeEntityRows(type: type, id: id, identity: identity)
            try deleteTombstone(type: type, id: id, identity: identity)
        }
    }

    public func purgeAll(for identity: SyncBindingIdentity) async throws {
        guard identity.hasSameBindingGeneration(as: self.identity),
              Self.isValidRecordVersion(identity.bindingRecordVersion) else {
            throw SQLiteSyncRepositoryError.bindingChanged
        }
        if fullyPurged { return }

        // Classify crash staging before mutating the live database. An
        // unowned collision must fail closed while both target and key are
        // still intact; an owned leftover is disposable for this explicit
        // erasure operation.
        try Self.recoverOwnedMigrationStagingIfPresent(
            for: databaseURL,
            key: try keyStore.loadKey(for: keyScope),
            identity: identity
        )

        if !databasePreparedForDeletion {
            try database.transaction {
                let active = try database.queryOne(
                    """
                    SELECT generation, binding_record_version
                    FROM sync_state WHERE \(Self.bindingKeyWhere)
                    """,
                    Self.scopeBindings(identity, includeGeneration: false)
                )
                if let active,
                   (active.text(0) != identity.generation ||
                    active.blob(1) != identity.bindingRecordVersion) {
                    throw SQLiteSyncRepositoryError.bindingChanged
                }
                for table in Self.scopedTables {
                    try deleteScopedRows(table: table, identity: identity)
                }
                try database.execute(
                    """
                    DELETE FROM sync_state WHERE \(Self.bindingKeyWhere)
                      AND generation = ? AND binding_record_version = ?
                    """,
                    Self.scopeBindings(identity) + [.blob(identity.bindingRecordVersion)]
                )
            }
            // Logout/revocation is an erasure boundary, not a logical hide.
            // Checkpoint and VACUUM complete while the key is still available.
            try database.execute("PRAGMA wal_checkpoint(TRUNCATE);")
            try database.execute("VACUUM;")
            try database.execute("PRAGMA wal_checkpoint(TRUNCATE);")
            // Leaving WAL mode proves no live connection can recreate a sidecar.
            try database.switchToDeleteJournal()
            try database.close()
            databasePreparedForDeletion = true
        }

        // Files are removed before the key. If deletion fails, cleanupPending
        // retains the only key capable of retrying the erasure safely.
        try Self.recoverOwnedMigrationStagingIfPresent(
            for: databaseURL,
            key: try keyStore.loadKey(for: keyScope),
            identity: identity
        )
        try Self.removeDatabaseArtifacts(at: databaseURL)
        try keyStore.deleteKey(for: keyScope)
        fullyPurged = true
    }

    // MARK: - Transaction helpers

    private func read<Value>(
        for requestedIdentity: SyncBindingIdentity,
        _ body: () throws -> Value
    ) throws -> Value {
        var result: Value?
        try database.transaction {
            try ensureCurrent(requestedIdentity)
            result = try body()
        }
        return result!
    }

    private func mutate(
        for requestedIdentity: SyncBindingIdentity,
        _ body: () throws -> Void
    ) throws {
        try database.transaction {
            try ensureCurrent(requestedIdentity)
            try body()
        }
        // The directory already carries the policy. Refresh catches sidecars created after open;
        // attribute failure must not make a committed database transaction look rolled back.
        try? filePolicy.refresh(databaseURL: databaseURL)
    }

    private func ensureCurrent(_ requestedIdentity: SyncBindingIdentity) throws {
        guard requestedIdentity.hasSameBindingGeneration(as: identity),
              Self.isValidRecordVersion(requestedIdentity.bindingRecordVersion) else {
            throw SQLiteSyncRepositoryError.bindingChanged
        }
        let row = try database.queryOne(
            """
            SELECT generation, binding_record_version, runtime_runnable
            FROM sync_state WHERE \(Self.bindingKeyWhere)
            """,
            Self.scopeBindings(requestedIdentity, includeGeneration: false)
        )
        guard let row else { throw SQLiteSyncRepositoryError.inactiveBinding }
        guard row.text(0) == requestedIdentity.generation,
              row.blob(1) == requestedIdentity.bindingRecordVersion,
              row.integer(2) == 1 else {
            throw SQLiteSyncRepositoryError.bindingChanged
        }
    }

    private func currentStateRow() throws -> StateRow? {
        let row = try database.queryOne(
            """
            SELECT generation, binding_record_version, runtime_runnable, binding_state,
                   applied_cursor, acknowledged_cursor, snapshot_cursor, registry_hash,
                   consecutive_failures, next_eligible_at
            FROM sync_state WHERE \(Self.bindingKeyWhere)
            """,
            Self.scopeBindings(identity, includeGeneration: false)
        )
        guard let row else { return nil }
        let currentIdentity = identity.replacingBindingRecordVersion(row.blob(1))
        guard row.text(0) == identity.generation,
              Self.isValidRecordVersion(currentIdentity.bindingRecordVersion) else { return nil }
        guard let state = BindingState(rawValue: row.text(3)) else {
            throw SQLiteSyncRepositoryError.corruptRecord("unknown binding state")
        }
        return StateRow(
            identity: currentIdentity,
            runtimeLeaseState: row.integer(2) == 1 ? .runnable : .fenced,
            bindingState: state,
            appliedCursor: row.integer(4),
            acknowledgedCursor: row.integer(5),
            snapshotCursor: row.integer(6),
            registryHash: row.optionalText(7),
            consecutiveFailures: Int(row.integer(8)),
            nextEligibleAt: row.optionalInteger(9)
        )
    }

    private func currentStateRowRequired() throws -> StateRow {
        guard let row = try currentStateRow() else {
            throw SQLiteSyncRepositoryError.inactiveBinding
        }
        return row
    }

    private func currentAppliedCursor(_ identity: SyncBindingIdentity) throws -> Int64 {
        let row = try database.queryOne(
            "SELECT applied_cursor FROM sync_state WHERE " + Self.bindingKeyWhere,
            Self.scopeBindings(identity, includeGeneration: false)
        )
        guard let row else { throw SQLiteSyncRepositoryError.inactiveBinding }
        return row.integer(0)
    }

    private func bootstrapCheckpoint(
        _ requestedIdentity: SyncBindingIdentity
    ) throws -> SyncBootstrapCheckpoint? {
        guard let run = try bootstrapRun(requestedIdentity), !run.complete,
              let token = run.nextPageToken,
              let expiresAt = run.expiresAt
        else { return nil }
        return SyncBootstrapCheckpoint(
            stagingGeneration: run.stagingGeneration,
            bootstrapId: run.bootstrapId,
            snapshotCursor: run.snapshotCursor,
            nextPageToken: token,
            pagesFetched: run.pagesFetched,
            entitiesStaged: run.entitiesStaged,
            expiresAtMilliseconds: expiresAt
        )
    }

    private func requireLeaseTransition(
        from current: SyncBindingIdentity,
        to replacement: SyncBindingIdentity
    ) throws {
        guard current.hasSameBindingGeneration(as: identity),
              replacement.hasSameBindingGeneration(as: current),
              Self.isValidRecordVersion(current.bindingRecordVersion),
              Self.isValidRecordVersion(replacement.bindingRecordVersion),
              current.bindingRecordVersion != replacement.bindingRecordVersion else {
            throw SQLiteSyncRepositoryError.bindingChanged
        }
    }

    private func bootstrapRun(_ identity: SyncBindingIdentity) throws -> BootstrapRunRow? {
        guard let row = try database.queryOne(
            """
            SELECT staging_generation, bootstrap_id, snapshot_cursor, next_page_token,
                   pages_fetched, entities_staged, expires_at, complete
            FROM bootstrap_runs WHERE \(Self.scopeWhere)
            """,
            Self.scopeBindings(identity)
        ) else { return nil }
        return BootstrapRunRow(
            stagingGeneration: row.text(0),
            bootstrapId: row.text(1),
            snapshotCursor: row.integer(2),
            nextPageToken: row.optionalText(3),
            pagesFetched: Int(row.integer(4)),
            entitiesStaged: Int(row.integer(5)),
            expiresAt: row.optionalInteger(6),
            complete: row.integer(7) != 0
        )
    }

    private func pendingOperation(
        _ opId: String,
        identity: SyncBindingIdentity
    ) throws -> MobileSyncOperation? {
        guard let data = try database.queryOne(
            "SELECT operation FROM pending_operations WHERE " + Self.scopeWhere + " AND op_id = ?",
            Self.scopeBindings(identity) + [.text(opId)]
        )?.blob(0) else { return nil }
        return try Self.decode(MobileSyncOperation.self, from: data)
    }

    private func deletePending(_ opId: String, identity: SyncBindingIdentity) throws {
        try database.execute(
            "DELETE FROM pending_operations WHERE " + Self.scopeWhere + " AND op_id = ?",
            Self.scopeBindings(identity) + [.text(opId)]
        )
    }

    private func mirrorEntityRow(
        _ type: String,
        _ id: String,
        identity: SyncBindingIdentity
    ) throws -> MirrorRow? {
        guard let row = try database.queryOne(
            """
            SELECT entity_type, entity_id, revision, server_changed_at, local_changed_at,
                   field_mask, payload, secret_envelopes, has_pending
            FROM mirror_entities
            WHERE \(Self.scopeWhere) AND entity_type = ? AND entity_id = ?
            """,
            Self.scopeBindings(identity) + [.text(type), .text(id)]
        ) else { return nil }
        let decoded = try Self.decodeMirrorRow(row)
        try Self.requireMirrorOwner(decoded, identity: identity)
        return decoded
    }

    private static func decodeMirrorRow(_ row: SQLiteRow) throws -> MirrorRow {
        MirrorRow(
            type: row.text(0),
            id: row.text(1),
            revision: row.integer(2),
            serverChangedAt: row.integer(3),
            localChangedAt: row.integer(4),
            fieldMask: try decode([String].self, from: row.blob(5)),
            payload: try decode([String: MobileJSONValue].self, from: row.blob(6)),
            secretEnvelopes: try decode(
                [String: MobileSecretEnvelope].self,
                from: row.blob(7)
            ),
            hasPending: row.integer(8) != 0
        )
    }

    private func upsertMirror(
        type: String,
        id: String,
        revision: Int64,
        serverChangedAt: Int64,
        localChangedAt: Int64,
        fieldMask: [String],
        payload: [String: MobileJSONValue],
        secretEnvelopes: [String: MobileSecretEnvelope],
        hasPending: Bool,
        identity: SyncBindingIdentity
    ) throws {
        try Self.upsertMirror(
            type: type,
            id: id,
            revision: revision,
            serverChangedAt: serverChangedAt,
            localChangedAt: localChangedAt,
            fieldMask: fieldMask,
            payload: payload,
            secretEnvelopes: secretEnvelopes,
            hasPending: hasPending,
            identity: identity,
            database: database
        )
    }

    private static func upsertMirror(
        type: String,
        id: String,
        revision: Int64,
        serverChangedAt: Int64,
        localChangedAt: Int64,
        fieldMask: [String],
        payload: [String: MobileJSONValue],
        secretEnvelopes: [String: MobileSecretEnvelope],
        hasPending: Bool,
        identity: SyncBindingIdentity,
        database: SQLiteDatabase
    ) throws {
        try database.execute(
            """
            INSERT INTO mirror_entities (
                server_id, account_id, device_id, generation, entity_type, entity_id,
                revision, server_changed_at, local_changed_at, field_mask, payload,
                secret_envelopes, has_pending
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(server_id, account_id, device_id, generation, entity_type, entity_id)
            DO UPDATE SET revision = excluded.revision,
                          server_changed_at = excluded.server_changed_at,
                          local_changed_at = excluded.local_changed_at,
                          field_mask = excluded.field_mask,
                          payload = excluded.payload,
                          secret_envelopes = excluded.secret_envelopes,
                          has_pending = excluded.has_pending
            """,
            scopeBindings(identity) + [
                .text(type), .text(id), .integer(revision), .integer(serverChangedAt),
                .integer(localChangedAt), .blob(try encode(fieldMask)), .blob(try encode(payload)),
                .blob(try encode(secretEnvelopes)), .integer(hasPending ? 1 : 0),
            ]
        )
    }

    private func storeTombstone(
        _ change: MobileSyncChange,
        authoritative: Bool,
        identity: SyncBindingIdentity
    ) throws {
        try storeTombstone(
            type: change.entityType,
            id: change.entityId,
            revision: change.revision,
            deletedAt: change.changedAt,
            authoritative: authoritative,
            identity: identity
        )
    }

    private func storeTombstone(
        type: String,
        id: String,
        revision: Int64,
        deletedAt: Int64,
        authoritative: Bool,
        identity: SyncBindingIdentity
    ) throws {
        try database.execute(
            """
            INSERT OR REPLACE INTO tombstones (
                server_id, account_id, device_id, generation, entity_type,
                entity_id, owner_id, revision, deleted_at, authoritative
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            Self.scopeBindings(identity) + [
                .text(type), .text(id),
                .text(try Self.ownerValue(entityType: type, identity: identity).value),
                .integer(revision), .integer(deletedAt),
                .integer(authoritative ? 1 : 0),
            ]
        )
    }

    private func deleteTombstone(type: String, id: String, identity: SyncBindingIdentity) throws {
        try database.execute(
            "DELETE FROM tombstones WHERE " + Self.scopeWhere + " AND entity_type = ? AND entity_id = ?",
            Self.scopeBindings(identity) + [.text(type), .text(id)]
        )
    }

    private func purgeEntityRows(type: String, id: String, identity: SyncBindingIdentity) throws {
        for table in ["mirror_entities", "pending_operations", "conflicts"] {
            try database.execute(
                "DELETE FROM " + table + " WHERE " + Self.scopeWhere + " AND entity_type = ? AND entity_id = ?",
                Self.scopeBindings(identity) + [.text(type), .text(id)]
            )
        }
    }

    private func deleteScopedRows(table: String, identity: SyncBindingIdentity) throws {
        precondition(Self.scopedTables.contains(table))
        try database.execute(
            "DELETE FROM " + table + " WHERE " + Self.scopeWhere,
            Self.scopeBindings(identity)
        )
    }

    private func refreshPendingFlag(
        _ type: String,
        _ id: String,
        identity: SyncBindingIdentity
    ) throws {
        try database.execute(
            """
            UPDATE mirror_entities
            SET has_pending = CASE WHEN EXISTS (
                SELECT 1 FROM pending_operations p
                WHERE p.server_id = mirror_entities.server_id
                  AND p.account_id = mirror_entities.account_id
                  AND p.device_id = mirror_entities.device_id
                  AND p.generation = mirror_entities.generation
                  AND p.entity_type = mirror_entities.entity_type
                  AND p.entity_id = mirror_entities.entity_id
            ) THEN 1 ELSE 0 END
            WHERE \(Self.scopeWhere) AND entity_type = ? AND entity_id = ?
            """,
            Self.scopeBindings(identity) + [.text(type), .text(id)]
        )
    }

    private func replayPending(type: String, id: String, identity: SyncBindingIdentity) throws {
        let rows = try database.query(
            """
            SELECT operation, created_at FROM pending_operations
            WHERE \(Self.scopeWhere) AND entity_type = ? AND entity_id = ?
            ORDER BY created_at, op_id
            """,
            Self.scopeBindings(identity) + [.text(type), .text(id)]
        )
        for row in rows {
            try Self.applyLocalOperation(
                Self.decode(MobileSyncOperation.self, from: row.blob(0)),
                changedAt: row.integer(1),
                validateBaseRevision: false,
                identity: identity,
                database: database
            )
        }
    }

    private func storeConflict(
        _ conflict: SyncConflictRecord,
        identity: SyncBindingIdentity
    ) throws {
        try database.execute(
            """
            INSERT OR REPLACE INTO conflicts (
                server_id, account_id, device_id, generation, op_id, entity_type, entity_id,
                local_base_revision, local_field_mask, local_payload, local_secret_envelopes,
                server_revision, server_payload, overlap_fields, server_deleted, acl_revoked, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            Self.scopeBindings(identity) + [
                .text(conflict.opId), .text(conflict.entityType), .text(conflict.entityId),
                .integer(conflict.localBaseRevision), .blob(try Self.encode(conflict.localFieldMask)),
                .blob(try Self.encode(conflict.localPayload)),
                .blob(try Self.encode(conflict.localSecretEnvelopes)),
                .integer(conflict.serverRevision), .blob(try Self.encode(conflict.serverPayload)),
                .blob(try Self.encode(conflict.overlapFields)),
                .integer(conflict.serverDeleted ? 1 : 0), .integer(conflict.aclRevoked ? 1 : 0),
                .integer(0),
            ]
        )
    }

    // MARK: - Static persistence rules

    private static func validate(_ operation: MobileSyncOperation) throws {
        guard !operation.opId.isEmpty, !operation.entityId.isEmpty else {
            throw SQLiteSyncRepositoryError.invalidLocalWrite("opId and entityId are required")
        }
        guard let spec = EntityRegistry.byType[operation.entityType] else {
            throw SQLiteSyncRepositoryError.invalidLocalWrite("unknown entity type")
        }
        switch operation.action {
        case .upsert:
            let invalid = operation.fieldMask.first { !spec.editableFields.contains($0) }
            guard invalid == nil else {
                throw SQLiteSyncRepositoryError.invalidLocalWrite("fieldMask contains a non-editable field")
            }
            guard !operation.fieldMask.isEmpty || !(operation.secretEnvelopes ?? [:]).isEmpty else {
                throw SQLiteSyncRepositoryError.invalidLocalWrite("upsert has no editable change")
            }
            let allowedRoots = Set(operation.fieldMask.map { $0.split(separator: ".").first.map(String.init) ?? $0 })
            guard operation.payload.keys.allSatisfy(allowedRoots.contains) else {
                throw SQLiteSyncRepositoryError.invalidLocalWrite("payload contains a field outside fieldMask")
            }
        case .delete, .restore:
            guard operation.fieldMask.isEmpty, operation.payload.isEmpty else {
                throw SQLiteSyncRepositoryError.invalidLocalWrite("delete and restore cannot carry field values")
            }
        }
    }

    private static func applyLocalOperation(
        _ operation: MobileSyncOperation,
        changedAt: Int64,
        validateBaseRevision: Bool,
        identity: SyncBindingIdentity,
        database: SQLiteDatabase
    ) throws {
        let row = try database.queryOne(
            """
            SELECT revision, server_changed_at, local_changed_at, field_mask, payload, secret_envelopes
            FROM mirror_entities
            WHERE \(scopeWhere) AND entity_type = ? AND entity_id = ?
            """,
            scopeBindings(identity) + [.text(operation.entityType), .text(operation.entityId)]
        )
        let revision = row?.integer(0) ?? 0
        if validateBaseRevision && revision != operation.baseRevision {
            throw SQLiteSyncRepositoryError.invalidLocalWrite("baseRevision does not match the mirror")
        }

        switch operation.action {
        case .upsert:
            var currentPayload = try row.map {
                try decode([String: MobileJSONValue].self, from: $0.blob(4))
            } ?? [:]
            let owner = try ownerValue(entityType: operation.entityType, identity: identity)
            if let currentOwner = currentPayload[owner.field], currentOwner != .string(owner.value) {
                throw SQLiteSyncRepositoryError.invalidLocalWrite(
                    "mirror owner does not match the binding"
                )
            }
            currentPayload[owner.field] = .string(owner.value)
            let currentEnvelopes = try row.map {
                try decode([String: MobileSecretEnvelope].self, from: $0.blob(5))
            } ?? [:]
            var mergedPayload = merge(
                currentPayload,
                with: operation.payload,
                fieldMask: operation.fieldMask
            )
            mergedPayload[owner.field] = .string(owner.value)
            try upsertMirror(
                type: operation.entityType,
                id: operation.entityId,
                revision: revision,
                serverChangedAt: row?.integer(1) ?? 0,
                localChangedAt: changedAt,
                fieldMask: operation.fieldMask,
                payload: mergedPayload,
                secretEnvelopes: mergeEnvelopes(currentEnvelopes, operation.secretEnvelopes ?? [:]),
                hasPending: true,
                identity: identity,
                database: database
            )
            try database.execute(
                "DELETE FROM tombstones WHERE " + scopeWhere + " AND entity_type = ? AND entity_id = ?",
                scopeBindings(identity) + [.text(operation.entityType), .text(operation.entityId)]
            )

        case .restore:
            guard row != nil || !validateBaseRevision else {
                throw SQLiteSyncRepositoryError.invalidLocalWrite("no mirror row exists to restore")
            }
            if let row {
                var payload = try decode(
                    [String: MobileJSONValue].self,
                    from: row.blob(4)
                )
                let owner = try ownerValue(entityType: operation.entityType, identity: identity)
                if let currentOwner = payload[owner.field], currentOwner != .string(owner.value) {
                    throw SQLiteSyncRepositoryError.invalidLocalWrite(
                        "mirror owner does not match the binding"
                    )
                }
                payload[owner.field] = .string(owner.value)
                try upsertMirror(
                    type: operation.entityType,
                    id: operation.entityId,
                    revision: revision,
                    serverChangedAt: row.integer(1),
                    localChangedAt: changedAt,
                    fieldMask: try decode([String].self, from: row.blob(3)),
                    payload: payload,
                    secretEnvelopes: try decode(
                        [String: MobileSecretEnvelope].self,
                        from: row.blob(5)
                    ),
                    hasPending: true,
                    identity: identity,
                    database: database
                )
            }
            try database.execute(
                "DELETE FROM tombstones WHERE " + scopeWhere + " AND entity_type = ? AND entity_id = ? AND authoritative = 0",
                scopeBindings(identity) + [.text(operation.entityType), .text(operation.entityId)]
            )

        case .delete:
            try database.execute(
                "DELETE FROM mirror_entities WHERE " + scopeWhere + " AND entity_type = ? AND entity_id = ?",
                scopeBindings(identity) + [.text(operation.entityType), .text(operation.entityId)]
            )
            try database.execute(
                """
                INSERT OR REPLACE INTO tombstones (
                    server_id, account_id, device_id, generation, entity_type,
                    entity_id, owner_id, revision, deleted_at, authoritative
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                """,
                scopeBindings(identity) + [
                    .text(operation.entityType), .text(operation.entityId),
                    .text(try ownerValue(
                        entityType: operation.entityType,
                        identity: identity
                    ).value),
                    .integer(operation.baseRevision), .integer(changedAt),
                ]
            )
        }
    }

    private static func promoteCompleteBootstrap(
        _ run: BootstrapRunRow,
        identity: SyncBindingIdentity,
        in database: SQLiteDatabase
    ) throws {
        try database.execute(
            "DELETE FROM mirror_entities WHERE " + scopeWhere,
            scopeBindings(identity)
        )
        try database.execute(
            "DELETE FROM tombstones WHERE " + scopeWhere,
            scopeBindings(identity)
        )
        try database.execute(
            """
            INSERT INTO mirror_entities (
                server_id, account_id, device_id, generation, entity_type, entity_id,
                revision, server_changed_at, local_changed_at, field_mask, payload,
                secret_envelopes, has_pending
            )
            SELECT server_id, account_id, device_id, generation, entity_type, entity_id,
                   revision, changed_at, changed_at, field_mask, payload, secret_envelopes, 0
            FROM bootstrap_entities
            WHERE \(scopeWhere) AND staging_generation = ?
            """,
            scopeBindings(identity) + [.text(run.stagingGeneration)]
        )

        let pending = try database.query(
            "SELECT operation, created_at FROM pending_operations WHERE " + scopeWhere
                + " ORDER BY created_at, op_id",
            scopeBindings(identity)
        )
        for row in pending {
            try applyLocalOperation(
                decode(MobileSyncOperation.self, from: row.blob(0)),
                changedAt: row.integer(1),
                validateBaseRevision: false,
                identity: identity,
                database: database
            )
        }

        try database.execute(
            """
            UPDATE sync_state
            SET applied_cursor = ?, snapshot_cursor = ?
            WHERE \(bindingKeyWhere) AND generation = ?
            """,
            [.integer(run.snapshotCursor), .integer(run.snapshotCursor)]
                + scopeBindings(identity, includeGeneration: false) + [.text(identity.generation)]
        )
        try database.execute(
            "DELETE FROM bootstrap_entities WHERE " + scopeWhere,
            scopeBindings(identity)
        )
        try database.execute(
            "DELETE FROM bootstrap_runs WHERE " + scopeWhere,
            scopeBindings(identity)
        )
    }

    private static func recoverInterruptedWork(
        _ identity: SyncBindingIdentity,
        in database: SQLiteDatabase
    ) throws {
        try database.transaction {
            let lease = try database.queryOne(
                """
                SELECT generation, binding_record_version, runtime_runnable
                FROM sync_state WHERE \(bindingKeyWhere)
                """,
                scopeBindings(identity, includeGeneration: false)
            )
            guard let lease else { throw SQLiteSyncRepositoryError.inactiveBinding }
            guard lease.text(0) == identity.generation,
                  lease.blob(1) == identity.bindingRecordVersion,
                  lease.integer(2) == 1 else {
                throw SQLiteSyncRepositoryError.bindingChanged
            }

            if let row = try database.queryOne(
                """
                SELECT staging_generation, bootstrap_id, snapshot_cursor, next_page_token,
                       pages_fetched, entities_staged, expires_at, complete
                FROM bootstrap_runs WHERE \(scopeWhere) AND complete = 1
                """,
                scopeBindings(identity)
            ) {
                let run = BootstrapRunRow(
                    stagingGeneration: row.text(0),
                    bootstrapId: row.text(1),
                    snapshotCursor: row.integer(2),
                    nextPageToken: row.optionalText(3),
                    pagesFetched: Int(row.integer(4)),
                    entitiesStaged: Int(row.integer(5)),
                    expiresAt: row.optionalInteger(6),
                    complete: true
                )
                try promoteCompleteBootstrap(run, identity: identity, in: database)
            }

            // A process death cannot leave an in-flight actor. Pending dispatched rows remain
            // queued with their original opIds, so the next recovery round safely retries them.
            try database.execute(
                """
                UPDATE sync_state
                SET binding_state = ?, last_error_code = COALESCE(last_error_code, ?),
                    last_error_diagnostic = COALESCE(last_error_diagnostic, ?)
                WHERE \(bindingKeyWhere) AND generation = ? AND binding_state = ?
                """,
                [
                    .text(BindingState.idle.rawValue), .text("interrupted"),
                    .text("code=interrupted"),
                ] + scopeBindings(identity, includeGeneration: false)
                    + [.text(identity.generation), .text(BindingState.running.rawValue)]
            )

            // Staged rows without a checkpoint can never be proven complete.
            try database.execute(
                """
                DELETE FROM bootstrap_entities
                WHERE \(scopeWhere) AND NOT EXISTS (
                    SELECT 1 FROM bootstrap_runs r
                    WHERE r.server_id = bootstrap_entities.server_id
                      AND r.account_id = bootstrap_entities.account_id
                      AND r.device_id = bootstrap_entities.device_id
                      AND r.generation = bootstrap_entities.generation
                )
                """,
                scopeBindings(identity)
            )
        }
    }

    private static func activate(
        _ identity: SyncBindingIdentity,
        initialState: BindingState,
        in database: SQLiteDatabase
    ) throws {
        try database.transaction {
            let existing = try database.queryOne(
                """
                SELECT generation, binding_record_version, runtime_runnable
                FROM sync_state WHERE \(bindingKeyWhere)
                """,
                scopeBindings(identity, includeGeneration: false)
            )
            let existingGeneration = existing?.text(0)

            if let existingGeneration, existingGeneration != identity.generation {
                let previous = SyncBindingIdentity(
                    serverID: identity.serverID,
                    accountID: identity.accountID,
                    deviceID: identity.deviceID,
                    generation: existingGeneration,
                    bindingRecordVersion: existing?.blob(1) ?? Data()
                )
                for table in scopedTables {
                    try database.execute(
                        "DELETE FROM " + table + " WHERE " + scopeWhere,
                        scopeBindings(previous)
                    )
                }
                try database.execute(
                    "DELETE FROM sync_state WHERE " + bindingKeyWhere,
                    scopeBindings(identity, includeGeneration: false)
                )
            }

            if existingGeneration == nil || existingGeneration != identity.generation {
                try database.execute(
                    """
                    INSERT INTO sync_state (
                        server_id, account_id, device_id, generation, binding_record_version,
                        runtime_runnable, binding_state, applied_cursor, acknowledged_cursor,
                        snapshot_cursor, consecutive_failures
                    ) VALUES (?, ?, ?, ?, ?, 1, ?, 0, 0, 0, 0)
                    """,
                    scopeBindings(identity)
                        + [.blob(identity.bindingRecordVersion), .text(initialState.rawValue)]
                )
            } else if let existing {
                let existingVersion = existing.blob(1)
                if existingVersion.isEmpty {
                    // A schema-v2 database has no lease epoch. Its first v3 opener adopts the
                    // trusted active binding-record version exactly once.
                    try database.execute(
                        """
                        UPDATE sync_state
                        SET binding_record_version = ?, runtime_runnable = 1
                        WHERE \(bindingKeyWhere) AND generation = ?
                          AND binding_record_version IS NULL
                        """,
                        [.blob(identity.bindingRecordVersion)]
                            + scopeBindings(identity, includeGeneration: false)
                            + [.text(identity.generation)]
                    )
                } else if existingVersion != identity.bindingRecordVersion || existing.integer(2) != 1 {
                    throw SQLiteSyncRepositoryError.bindingChanged
                }
            }
        }
    }

    private static func requireExisting(
        _ identity: SyncBindingIdentity,
        in database: SQLiteDatabase
    ) throws {
        try database.transaction {
            guard let row = try database.queryOne(
                """
                SELECT generation, binding_record_version, runtime_runnable
                FROM sync_state WHERE \(bindingKeyWhere)
                """,
                scopeBindings(identity, includeGeneration: false)
            ) else {
                throw SQLiteSyncRepositoryError.inactiveBinding
            }
            guard row.text(0) == identity.generation else {
                throw SQLiteSyncRepositoryError.bindingChanged
            }
            if row.blob(1).isEmpty {
                try database.execute(
                    """
                    UPDATE sync_state
                    SET binding_record_version = ?, runtime_runnable = 1
                    WHERE \(bindingKeyWhere) AND generation = ?
                      AND binding_record_version IS NULL
                    """,
                    [.blob(identity.bindingRecordVersion)]
                        + scopeBindings(identity, includeGeneration: false)
                        + [.text(identity.generation)]
                )
            } else if row.blob(1) != identity.bindingRecordVersion || row.integer(2) != 1 {
                throw SQLiteSyncRepositoryError.bindingChanged
            }
        }
    }

    private static let sqlitePlaintextHeader = Data("SQLite format 3\u{0}".utf8)
    private static let migrationStagingOwnershipXattr =
        "com.zephyr.one.sync-migration-owner.v1"
    private static let migrationStagingProofDomain =
        Data("zephyr-one/sqlcipher-migration-owner/v1\u{0}".utf8)

    private static func requireSafeDatabaseDirectory(at url: URL) throws {
        _ = try trustedSQLiteLocation(for: url)
    }

    private static func requireSafeTargetArtifacts(at url: URL) throws -> Bool {
        let main = try artifactStatus(at: url.path)
        let sidecars = try ["-wal", "-shm", "-journal"].map {
            try artifactStatus(at: url.path + $0)
        }

        guard let main else {
            guard sidecars.allSatisfy({ status in
                if case nil = status { return true }
                return false
            }) else {
                throw SQLiteSyncRepositoryError.databaseIntegrityFailed("unsafe_database_artifact")
            }
            return false
        }
        guard (main.st_mode & S_IFMT) == S_IFREG, main.st_size > 0 else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("unsafe_database_artifact")
        }
        guard sidecars.allSatisfy({ status in
            guard let status else { return true }
            return (status.st_mode & S_IFMT) == S_IFREG
        }) else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("unsafe_database_artifact")
        }
        return true
    }

    private static func artifactStatus(at path: String) throws -> stat? {
        var status = stat()
        if lstat(path, &status) == 0 { return status }
        guard errno == ENOENT else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("database_artifact_metadata")
        }
        return nil
    }

    private static func hasDatabaseArtifacts(at url: URL) -> Bool {
        ["", "-wal", "-shm", "-journal"].contains {
            FileManager.default.fileExists(atPath: url.path + $0)
        }
    }

    private static func removeDatabaseArtifacts(at url: URL) throws {
        // Preserve the main encrypted file until all direct sidecars are gone.
        // Every path is unlinked as one leaf; never hand a caller-controlled
        // replacement to FileManager, whose directory behavior is recursive.
        let paths = [
            url.path + "-wal",
            url.path + "-shm",
            url.path + "-journal",
            url.path,
        ]
        for path in paths {
            guard let status = try artifactStatus(at: path) else { continue }
            guard (status.st_mode & S_IFMT) == S_IFREG,
                  Darwin.unlink(path) == 0 else {
                throw SQLiteSyncRepositoryError.databaseIntegrityFailed(
                    "database_artifact_removal"
                )
            }
        }
        guard try paths.allSatisfy({ try artifactStatus(at: $0) == nil }) else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("database_artifact_removal")
        }
        try synchronizeContainingDirectory(
            of: url.path,
            failure: "database_artifact_removal"
        )
    }

    private static func migrationStagingURL(for targetURL: URL) -> URL {
        URL(fileURLWithPath: targetURL.path + ".migrating", isDirectory: false)
    }

    private static func migrationStagingPaths(at stagingURL: URL) -> [String] {
        ["", "-wal", "-shm", "-journal"].map { stagingURL.path + $0 }
    }

    private static func migrationStagingProofPayload(
        stagingLocation: String,
        identity: SyncBindingIdentity
    ) -> Data {
        var payload = migrationStagingProofDomain
        for value in [
            stagingLocation,
            identity.serverID,
            identity.accountID,
            identity.deviceID,
            identity.generation,
        ] {
            let bytes = Data(value.utf8)
            var length = UInt64(bytes.count).bigEndian
            withUnsafeBytes(of: &length) { payload.append(contentsOf: $0) }
            payload.append(bytes)
        }
        return payload
    }

    private static func migrationStagingProof(
        stagingLocation: String,
        key: Data,
        identity: SyncBindingIdentity
    ) -> Data {
        let payload = migrationStagingProofPayload(
            stagingLocation: stagingLocation,
            identity: identity
        )
        return Data(HMAC<SHA256>.authenticationCode(
            for: payload,
            using: SymmetricKey(data: key)
        ))
    }

    private static func writeMigrationStagingProof(
        to descriptor: Int32,
        stagingLocation: String,
        key: Data,
        identity: SyncBindingIdentity
    ) throws {
        let proof = migrationStagingProof(
            stagingLocation: stagingLocation,
            key: key,
            identity: identity
        )
        let result = proof.withUnsafeBytes { bytes in
            migrationStagingOwnershipXattr.withCString { name in
                fsetxattr(
                    descriptor,
                    name,
                    bytes.baseAddress,
                    bytes.count,
                    0,
                    XATTR_CREATE
                )
            }
        }
        guard result == 0, Darwin.fsync(descriptor) == 0 else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed(
                "migration_staging_owner"
            )
        }
    }

    private static func hasValidMigrationStagingProof(
        descriptor: Int32,
        stagingLocation: String,
        key: Data,
        identity: SyncBindingIdentity
    ) -> Bool {
        let expectedProof = migrationStagingProof(
            stagingLocation: stagingLocation,
            key: key,
            identity: identity
        )
        var proof = Data(count: expectedProof.count)
        let bytesRead = proof.withUnsafeMutableBytes { bytes in
            migrationStagingOwnershipXattr.withCString { name in
                fgetxattr(
                    descriptor,
                    name,
                    bytes.baseAddress,
                    bytes.count,
                    0,
                    0
                )
            }
        }
        guard bytesRead == expectedProof.count else { return false }
        let payload = migrationStagingProofPayload(
            stagingLocation: stagingLocation,
            identity: identity
        )
        return HMAC<SHA256>.isValidAuthenticationCode(
            proof,
            authenticating: payload,
            using: SymmetricKey(data: key)
        )
    }

    private static func publishOwnedMigrationStaging(
        at stagingURL: URL,
        key: Data,
        identity: SyncBindingIdentity
    ) throws {
        let stagingLocation = try trustedSQLiteLocation(for: stagingURL)
        let temporaryURL = URL(
            fileURLWithPath: stagingURL.path + ".owner-" + UUID().uuidString,
            isDirectory: false
        )
        let temporaryLocation = try trustedSQLiteLocation(for: temporaryURL)
        let descriptor = Darwin.open(
            temporaryLocation,
            O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC,
            mode_t(0o600)
        )
        guard descriptor >= 0 else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed(
                "migration_staging_create"
            )
        }
        var temporaryExists = true
        defer {
            _ = Darwin.close(descriptor)
            if temporaryExists { _ = Darwin.unlink(temporaryLocation) }
        }

        try writeMigrationStagingProof(
            to: descriptor,
            stagingLocation: stagingLocation,
            key: key,
            identity: identity
        )
        guard Darwin.renamex_np(
            temporaryLocation,
            stagingLocation,
            UInt32(RENAME_EXCL)
        ) == 0 else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed(
                "migration_staging_create"
            )
        }
        temporaryExists = false
        try synchronizeContainingDirectory(
            of: stagingLocation,
            failure: "migration_staging_publish"
        )
    }

    private static func synchronizeContainingDirectory(
        of location: String,
        failure: String
    ) throws {
        let parent = URL(fileURLWithPath: location, isDirectory: false)
            .deletingLastPathComponent()
            .path
        let descriptor = Darwin.open(
            parent,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed(failure)
        }
        defer { _ = Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed(failure)
        }
    }

    private static func requireOwnedMigrationStaging(
        at stagingURL: URL,
        key: Data?,
        identity: SyncBindingIdentity
    ) throws {
        guard let key else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed(
                "migration_staging_create"
            )
        }
        let stagingLocation = try trustedSQLiteLocation(for: stagingURL)
        let descriptor = Darwin.open(
            stagingLocation,
            O_RDONLY | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed(
                "migration_staging_create"
            )
        }
        defer { _ = Darwin.close(descriptor) }

        var status = stat()
        guard Darwin.fstat(descriptor, &status) == 0,
              (status.st_mode & S_IFMT) == S_IFREG,
              status.st_nlink == 1,
              hasValidMigrationStagingProof(
                  descriptor: descriptor,
                  stagingLocation: stagingLocation,
                  key: key,
                  identity: identity
              ) else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed(
                "migration_staging_create"
            )
        }
    }

    private static func removeOwnedMigrationStagingArtifacts(
        at stagingURL: URL
    ) throws {
        // Main is removed last so its authenticated owner proof survives every
        // retry until all direct SQLite sidecars have been removed. unlink(2)
        // never recursively traverses a hostile directory or a nested
        // `.migrating.migrating*` name.
        let paths = ["-wal", "-shm", "-journal", ""].map {
            stagingURL.path + $0
        }
        for path in paths {
            guard let status = try artifactStatus(at: path) else { continue }
            guard (status.st_mode & S_IFMT) == S_IFREG,
                  Darwin.unlink(path) == 0 else {
                throw SQLiteSyncRepositoryError.databaseIntegrityFailed(
                    "migration_staging_cleanup"
                )
            }
        }
        guard try paths.allSatisfy({ try artifactStatus(at: $0) == nil }) else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed(
                "migration_staging_cleanup"
            )
        }
        try synchronizeContainingDirectory(
            of: stagingURL.path,
            failure: "migration_staging_cleanup"
        )
    }

    private static func recoverOwnedMigrationStagingIfPresent(
        for targetURL: URL,
        key: Data?,
        identity: SyncBindingIdentity,
        legacyURL: URL? = nil,
        requiresLegacyOwner: Bool = false
    ) throws {
        let stagingURL = migrationStagingURL(for: targetURL)
        let paths = migrationStagingPaths(at: stagingURL)
        let statuses = try paths.map(artifactStatus(at:))
        guard statuses.contains(where: { $0 != nil }) else { return }
        guard statuses[0] != nil else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed(
                "unsafe_database_artifact"
            )
        }
        guard statuses.dropFirst().allSatisfy({ status in
            guard let status else { return true }
            return (status.st_mode & S_IFMT) == S_IFREG
        }) else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed(
                "unsafe_database_artifact"
            )
        }
        try requireOwnedMigrationStaging(
            at: stagingURL,
            key: key,
            identity: identity
        )
        if let legacyURL {
            // The authenticated staging may contain the only complete export
            // after a real power loss. Before discarding it for a clean retry,
            // prove that the plaintext source is still intact and owned by the
            // same binding. This is an existing-only, read-only check.
            try requireOwnedLegacyDatabase(at: legacyURL, identity: identity)
        } else if requiresLegacyOwner {
            throw SQLiteSyncRepositoryError.legacyOwnerMismatch
        }
        try removeOwnedMigrationStagingArtifacts(at: stagingURL)
    }

    private static func removeLegacyDatabaseArtifacts(at url: URL) throws {
        // Preserve the owner-bearing main file until every sidecar is gone. If
        // cleanup is interrupted, the next attempt can still prove ownership.
        for suffix in ["-wal", "-shm", "-journal", ""] {
            let artifact = URL(fileURLWithPath: url.path + suffix)
            if FileManager.default.fileExists(atPath: artifact.path) {
                try FileManager.default.removeItem(at: artifact)
            }
        }
        guard !hasDatabaseArtifacts(at: url) else {
            throw SQLiteSyncRepositoryError.legacyOwnerMismatch
        }
        try synchronizeContainingDirectory(
            of: url.path,
            failure: "legacy_artifact_removal"
        )
    }

    /// Erasure fallback for a mirror that cannot be opened or purged normally.
    /// The database URL and key scope must both be derived from the same trusted binding identity.
    /// An account-scoped plaintext predecessor is erased only after its persisted owner tuple
    /// proves that it belongs to the same binding generation.
    static func eraseEncryptedStorageForCleanup(
        at databaseURL: URL,
        legacyDatabaseURL: URL?,
        identity: SyncBindingIdentity,
        keyStore: any SyncDatabaseKeyStoring
    ) throws {
        // Validate every caller-provided location before observing or mutating
        // either store. The returned path resolves only the trusted top-level
        // compatibility alias and preserves the caller's final file name.
        let trustedDatabaseURL = URL(
            fileURLWithPath: try trustedSQLiteLocation(for: databaseURL),
            isDirectory: false
        )
        let trustedLegacyDatabaseURL = try legacyDatabaseURL.map { rawURL in
            URL(
                fileURLWithPath: try trustedSQLiteLocation(for: rawURL),
                isDirectory: false
            )
        }

        let scope = try SyncDatabaseKeyScope(identity: identity)
        try recoverOwnedMigrationStagingIfPresent(
            for: trustedDatabaseURL,
            key: try keyStore.loadKey(for: scope),
            identity: identity
        )

        if let trustedLegacyDatabaseURL {
            guard trustedLegacyDatabaseURL != trustedDatabaseURL else {
                throw SQLiteSyncRepositoryError.legacyOwnerMismatch
            }
            if hasDatabaseArtifacts(at: trustedLegacyDatabaseURL) {
                try removeLegacyDatabaseIfOwned(
                    at: trustedLegacyDatabaseURL,
                    identity: identity
                )
            }
        }

        // Keep the only usable key whenever any artifact cannot be removed.
        // The durable cleanup marker can then retry without stranding an
        // encrypted database that no longer has decrypting key material.
        try removeDatabaseArtifacts(at: trustedDatabaseURL)
        try keyStore.deleteKey(for: scope)
    }

    private static func header(at url: URL) throws -> Data {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        return try handle.read(upToCount: sqlitePlaintextHeader.count) ?? Data()
    }

    private static func requireEncryptedHeader(at url: URL) throws {
        guard try header(at: url) != sqlitePlaintextHeader else {
            throw SQLiteSyncRepositoryError.plaintextDatabaseRejected
        }
    }

    private static func requirePlaintextHeader(at url: URL) throws {
        guard try header(at: url) == sqlitePlaintextHeader else {
            throw SQLiteSyncRepositoryError.plaintextDatabaseRejected
        }
    }

    private static func requireLegacyOwner(
        _ identity: SyncBindingIdentity,
        in database: SQLiteDatabase
    ) throws {
        do {
            let stateRows = try database.query(
                "SELECT server_id, account_id, device_id, generation FROM sync_state;"
            )
            guard stateRows.count == 1,
                  stateRows[0].text(0) == identity.serverID,
                  stateRows[0].text(1) == identity.accountID,
                  stateRows[0].text(2) == identity.deviceID,
                  stateRows[0].text(3) == identity.generation else {
                throw SQLiteSyncRepositoryError.legacyOwnerMismatch
            }

            let existingTables = Set(try database.query(
                """
                SELECT name FROM sqlite_master
                WHERE type = 'table' AND name NOT LIKE 'sqlite_%';
                """
            ).map { $0.text(0) })
            guard existingTables.isSubset(of: scopedTables.union(["sync_state"])) else {
                throw SQLiteSyncRepositoryError.legacyOwnerMismatch
            }
            for table in scopedTables where existingTables.contains(table) {
                let owners = try database.query(
                    "SELECT DISTINCT server_id, account_id, device_id, generation FROM \(table);"
                )
                guard owners.allSatisfy({ row in
                    row.text(0) == identity.serverID
                        && row.text(1) == identity.accountID
                        && row.text(2) == identity.deviceID
                        && row.text(3) == identity.generation
                }) else {
                    throw SQLiteSyncRepositoryError.legacyOwnerMismatch
                }
            }
        } catch let error as SQLiteSyncRepositoryError {
            if error == .legacyOwnerMismatch { throw error }
            throw SQLiteSyncRepositoryError.legacyOwnerMismatch
        } catch {
            throw SQLiteSyncRepositoryError.legacyOwnerMismatch
        }
    }

    private static func migrateLegacyDatabase(
        at legacyURL: URL,
        to targetURL: URL,
        key: Data,
        identity: SyncBindingIdentity,
        filePolicy: SQLiteSyncDatabaseFilePolicy,
        hooks: SQLiteSyncMigrationHooks
    ) throws {
        guard legacyURL.standardizedFileURL != targetURL.standardizedFileURL else {
            throw SQLiteSyncRepositoryError.plaintextDatabaseRejected
        }
        guard !hasDatabaseArtifacts(at: targetURL) else { return }
        // Upgrade the legacy file and any WAL sidecars from the old
        // complete-until-first-unlock class before reading a plaintext page.
        try filePolicy.prepare(databaseURL: legacyURL)
        try requirePlaintextHeader(at: legacyURL)

        let stagingURL = migrationStagingURL(for: targetURL)
        var ownsStaging = false
        var preservePublishedStaging = false
        do {
            let stagingStatuses = try migrationStagingPaths(at: stagingURL)
                .map(artifactStatus(at:))
            guard stagingStatuses.allSatisfy({ $0 == nil }) else {
                throw SQLiteSyncRepositoryError.databaseIntegrityFailed(
                    "migration_staging_create"
                )
            }
            // Publish a zero-byte staging inode only after its owner proof is
            // durable. RENAME_EXCL makes the fixed name an all-or-nothing
            // claim: a kill before publish leaves no blocking fixed path, and
            // a kill after publish is recoverable with the retained key.
            try publishOwnedMigrationStaging(
                at: stagingURL,
                key: key,
                identity: identity
            )
            ownsStaging = true
            do {
                try hooks(.stagingPublished)
            } catch {
                // This hook is the deterministic equivalent of power loss:
                // normal stack cleanup must not erase crash-recovery state.
                preservePublishedStaging = true
                throw error
            }

            let legacy = try SQLiteDatabase.plaintext(url: legacyURL)
            do {
                try requireLegacyOwner(identity, in: legacy)
                try legacy.preparePlaintextForCopy()
            } catch {
                try? legacy.close()
                throw error
            }

            try filePolicy.prepare(databaseURL: stagingURL)

            let exportSource = try SQLiteDatabase.plaintext(url: legacyURL)
            do {
                // Re-prove the source immediately before SQLCipher reads it
                // into a separately keyed database. PRAGMA rekey is only for
                // changing the key of an already-encrypted database.
                try requireLegacyOwner(identity, in: exportSource)
                try exportSource.exportEncryptedCopy(to: stagingURL, key: key)
                try exportSource.close()
            } catch {
                try? exportSource.close()
                throw error
            }
            try filePolicy.refresh(databaseURL: stagingURL)

            let staged = try SQLiteDatabase(url: stagingURL, key: key, createNew: false)
            do {
                // Re-prove the exported bytes before promotion.
                try requireLegacyOwner(identity, in: staged)
                try staged.verifyCipherIntegrity()
                try staged.prepareEncryptedForPromotion()
            } catch {
                try? staged.close()
                throw error
            }

            try requireEncryptedHeader(at: stagingURL)
            try hooks(.encryptedCopyReady)
            try hooks(.beforePromotion)
            try FileManager.default.moveItem(at: stagingURL, to: targetURL)
            try synchronizeContainingDirectory(
                of: targetURL.path,
                failure: "migration_promotion"
            )
            try hooks(.promoted)

            // The plaintext source remains untouched until the encrypted copy
            // has been integrity-checked and atomically promoted.
            try removeLegacyDatabaseIfOwned(at: legacyURL, identity: identity)
        } catch {
            // A failed or interrupted migration never destroys the only
            // owner-proven plaintext copy. Disposable encrypted staging is
            // retried with the same durable Keychain key on the next launch.
            if ownsStaging && !preservePublishedStaging {
                // Re-authenticate the main inode immediately before deleting
                // the four exact staging artifacts. A path substitution cannot
                // turn this catch into deletion of an unowned collision.
                if (try? requireOwnedMigrationStaging(
                    at: stagingURL,
                    key: key,
                    identity: identity
                )) != nil {
                    try? removeOwnedMigrationStagingArtifacts(at: stagingURL)
                }
            }
            throw error
        }
    }

    private static func removeLegacyDatabaseIfOwned(
        at legacyURL: URL,
        identity: SyncBindingIdentity
    ) throws {
        try requirePlaintextHeader(at: legacyURL)
        let legacy = try SQLiteDatabase.plaintext(url: legacyURL)
        do {
            try requireLegacyOwner(identity, in: legacy)
            try legacy.securelyEraseLegacyContent(tables: scopedTables)
        } catch {
            try? legacy.close()
            throw error
        }
        try removeLegacyDatabaseArtifacts(at: legacyURL)
    }

    private static func requireOwnedLegacyDatabase(
        at legacyURL: URL,
        identity: SyncBindingIdentity
    ) throws {
        try requirePlaintextHeader(at: legacyURL)
        let legacy = try SQLiteDatabase.plaintext(url: legacyURL)
        do {
            try requireLegacyOwner(identity, in: legacy)
            try legacy.close()
        } catch {
            try? legacy.close()
            throw error
        }
    }

    private static func migrate(_ database: SQLiteDatabase) throws {
        try database.execute(
            """
            CREATE TABLE IF NOT EXISTS sync_state (
                server_id TEXT NOT NULL,
                account_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                generation TEXT NOT NULL,
                binding_record_version BLOB NOT NULL,
                runtime_runnable INTEGER NOT NULL DEFAULT 0,
                binding_state TEXT NOT NULL,
                applied_cursor INTEGER NOT NULL DEFAULT 0,
                acknowledged_cursor INTEGER NOT NULL DEFAULT 0,
                snapshot_cursor INTEGER NOT NULL DEFAULT 0,
                registry_hash TEXT,
                last_attempt_at INTEGER,
                last_success_at INTEGER,
                last_error_code TEXT,
                last_error_diagnostic TEXT,
                consecutive_failures INTEGER NOT NULL DEFAULT 0,
                next_eligible_at INTEGER,
                PRIMARY KEY (server_id, account_id, device_id)
            );

            CREATE TABLE IF NOT EXISTS mirror_entities (
                server_id TEXT NOT NULL,
                account_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                generation TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                server_changed_at INTEGER NOT NULL,
                local_changed_at INTEGER NOT NULL,
                field_mask BLOB NOT NULL,
                payload BLOB NOT NULL,
                secret_envelopes BLOB NOT NULL,
                has_pending INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (server_id, account_id, device_id, generation, entity_type, entity_id)
            );
            CREATE INDEX IF NOT EXISTS mirror_type_idx
                ON mirror_entities(server_id, account_id, device_id, generation, entity_type, entity_id);

            CREATE TABLE IF NOT EXISTS pending_operations (
                server_id TEXT NOT NULL,
                account_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                generation TEXT NOT NULL,
                op_id TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                action TEXT NOT NULL,
                base_revision INTEGER NOT NULL,
                field_mask BLOB NOT NULL,
                operation BLOB NOT NULL,
                created_at INTEGER NOT NULL,
                batch_id TEXT,
                dispatched_at INTEGER,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                PRIMARY KEY (server_id, account_id, device_id, generation, op_id)
            );
            CREATE INDEX IF NOT EXISTS pending_order_idx
                ON pending_operations(server_id, account_id, device_id, generation, created_at, op_id);

            CREATE TABLE IF NOT EXISTS applied_operations (
                server_id TEXT NOT NULL,
                account_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                generation TEXT NOT NULL,
                op_id TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                applied_at INTEGER NOT NULL,
                PRIMARY KEY (server_id, account_id, device_id, generation, op_id)
            );

            CREATE TABLE IF NOT EXISTS bootstrap_runs (
                server_id TEXT NOT NULL,
                account_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                generation TEXT NOT NULL,
                staging_generation TEXT NOT NULL,
                bootstrap_id TEXT NOT NULL,
                snapshot_cursor INTEGER NOT NULL,
                next_page_token TEXT,
                pages_fetched INTEGER NOT NULL,
                entities_staged INTEGER NOT NULL,
                expires_at INTEGER,
                complete INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (server_id, account_id, device_id, generation)
            );

            CREATE TABLE IF NOT EXISTS bootstrap_entities (
                server_id TEXT NOT NULL,
                account_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                generation TEXT NOT NULL,
                staging_generation TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                changed_at INTEGER NOT NULL,
                field_mask BLOB NOT NULL,
                payload BLOB NOT NULL,
                secret_envelopes BLOB NOT NULL,
                PRIMARY KEY (
                    server_id, account_id, device_id, generation,
                    staging_generation, entity_type, entity_id
                )
            );

            CREATE TABLE IF NOT EXISTS conflicts (
                server_id TEXT NOT NULL,
                account_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                generation TEXT NOT NULL,
                op_id TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                local_base_revision INTEGER NOT NULL,
                local_field_mask BLOB NOT NULL,
                local_payload BLOB NOT NULL,
                local_secret_envelopes BLOB NOT NULL,
                server_revision INTEGER NOT NULL,
                server_payload BLOB NOT NULL,
                overlap_fields BLOB NOT NULL,
                server_deleted INTEGER NOT NULL,
                acl_revoked INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (server_id, account_id, device_id, generation, op_id)
            );

            CREATE TABLE IF NOT EXISTS tombstones (
                server_id TEXT NOT NULL,
                account_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                generation TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                deleted_at INTEGER NOT NULL,
                authoritative INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (server_id, account_id, device_id, generation, entity_type, entity_id)
            );

            """
        )

        let stateColumns = try database.query("PRAGMA table_info(sync_state);")
            .map { $0.text(1) }
        if !stateColumns.contains("binding_record_version") {
            try database.execute("ALTER TABLE sync_state ADD COLUMN binding_record_version BLOB;")
        }
        if !stateColumns.contains("runtime_runnable") {
            try database.execute(
                "ALTER TABLE sync_state ADD COLUMN runtime_runnable INTEGER NOT NULL DEFAULT 0;"
            )
        }

        let tombstoneColumns = try database.query("PRAGMA table_info(tombstones);")
            .map { $0.text(1) }
        if !tombstoneColumns.contains("owner_id") {
            try database.transaction {
                try database.execute("ALTER TABLE tombstones ADD COLUMN owner_id TEXT;")
                let legacyRows = try database.query(
                    "SELECT rowid, entity_type, server_id, account_id FROM tombstones"
                )
                for row in legacyRows {
                    guard let spec = EntityRegistry.byType[row.text(1)] else {
                        throw SQLiteSyncRepositoryError.corruptRecord(
                            "legacy tombstone has an unknown entity type"
                        )
                    }
                    let owner = spec.ownerField.lowercased().contains("server")
                        ? row.text(2)
                        : row.text(3)
                    try database.execute(
                        "UPDATE tombstones SET owner_id = ? WHERE rowid = ?",
                        [.text(owner), .integer(row.integer(0))]
                    )
                }
            }
        }
        try database.execute("PRAGMA user_version = 3;")
    }

    private static func belongsToBinding(
        _ change: MobileSyncChange,
        identity: SyncBindingIdentity
    ) -> Bool {
        guard let spec = EntityRegistry.byType[change.entityType] else { return false }
        let ownership = change.action == .delete ? change.tombstone : change.payload
        guard let ownership,
              case .string(let owner)? = ownership[spec.ownerField],
              !owner.isEmpty else { return false }
        let expected = expectedOwner(spec: spec, identity: identity)
        return owner == expected
    }

    private static func requireMirrorOwner(
        _ row: MirrorRow,
        identity: SyncBindingIdentity
    ) throws {
        guard let spec = EntityRegistry.byType[row.type],
              case .string(let owner)? = row.payload[spec.ownerField],
              owner == expectedOwner(spec: spec, identity: identity) else {
            throw SQLiteSyncRepositoryError.corruptRecord(
                "mirror entity owner is missing or does not match the binding"
            )
        }
    }

    private static func requireAllMirrorOwners(
        _ identity: SyncBindingIdentity,
        in database: SQLiteDatabase
    ) throws {
        let rows = try database.query(
            """
            SELECT entity_type, entity_id, revision, server_changed_at, local_changed_at,
                   field_mask, payload, secret_envelopes, has_pending
            FROM mirror_entities WHERE \(scopeWhere)
            """,
            scopeBindings(identity)
        )
        for row in rows {
            try requireMirrorOwner(try decodeMirrorRow(row), identity: identity)
        }
    }

    private static func requireAllTombstoneOwners(
        _ identity: SyncBindingIdentity,
        in database: SQLiteDatabase
    ) throws {
        let rows = try database.query(
            "SELECT entity_type, owner_id FROM tombstones WHERE " + scopeWhere,
            scopeBindings(identity)
        )
        for row in rows {
            guard let spec = EntityRegistry.byType[row.text(0)],
                  row.text(1) == expectedOwner(spec: spec, identity: identity) else {
                throw SQLiteSyncRepositoryError.corruptRecord(
                    "tombstone owner is missing or does not match the binding"
                )
            }
        }
    }

    private static func expectedOwner(
        spec: SyncEntitySpec,
        identity: SyncBindingIdentity
    ) -> String {
        spec.ownerField.lowercased().contains("server") ? identity.serverID : identity.accountID
    }

    private static func ownerValue(
        entityType: String,
        identity: SyncBindingIdentity
    ) throws -> (field: String, value: String) {
        guard let spec = EntityRegistry.byType[entityType] else {
            throw SQLiteSyncRepositoryError.invalidLocalWrite("unknown entity type")
        }
        let expected = expectedOwner(spec: spec, identity: identity)
        return (spec.ownerField, expected)
    }

    private static func isRevokedACL(_ payload: [String: MobileJSONValue]) -> Bool {
        if case .null? = payload["revokedAt"] { return false }
        return payload["revokedAt"] != nil
    }

    private static func aclTarget(
        _ payload: [String: MobileJSONValue],
        _ tombstone: [String: MobileJSONValue]?,
        _ existing: [String: MobileJSONValue]?
    ) -> (type: String, id: String)? {
        let sources = [payload, tombstone ?? [:], existing ?? [:]]
        for source in sources {
            let type = ["resourceType", "entityType"].compactMap { key -> String? in
                guard case .string(let value)? = source[key] else { return nil }
                return value
            }.first
            let id = ["resourceId", "entityId"].compactMap { key -> String? in
                guard case .string(let value)? = source[key] else { return nil }
                return value
            }.first
            if let type, let id, type != "resourceAcl" { return (type, id) }
        }
        return nil
    }

    private static func merge(
        _ current: [String: MobileJSONValue],
        with incoming: [String: MobileJSONValue],
        fieldMask: [String]
    ) -> [String: MobileJSONValue] {
        guard !fieldMask.isEmpty else { return incoming }
        var result = current
        for field in fieldMask {
            let path = field.split(separator: ".").map(String.init)
            guard !path.isEmpty, let value = value(at: path, in: incoming) else { continue }
            set(value, at: path, in: &result)
        }
        return result
    }

    private static func value(
        at path: [String],
        in object: [String: MobileJSONValue]
    ) -> MobileJSONValue? {
        guard let head = path.first, let value = object[head] else { return nil }
        guard path.count > 1 else { return value }
        guard case .object(let nested) = value else { return nil }
        return self.value(at: Array(path.dropFirst()), in: nested)
    }

    private static func set(
        _ value: MobileJSONValue,
        at path: [String],
        in object: inout [String: MobileJSONValue]
    ) {
        guard let head = path.first else { return }
        guard path.count > 1 else {
            object[head] = value
            return
        }
        var nested: [String: MobileJSONValue]
        if case .object(let existing)? = object[head] { nested = existing } else { nested = [:] }
        set(value, at: Array(path.dropFirst()), in: &nested)
        object[head] = .object(nested)
    }

    private static func mergeEnvelopes(
        _ current: [String: MobileSecretEnvelope],
        _ incoming: [String: MobileSecretEnvelope]
    ) -> [String: MobileSecretEnvelope] {
        current.merging(incoming) { _, new in new }
    }

    private static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(value)
    }

    private static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw SQLiteSyncRepositoryError.corruptRecord(String(describing: type))
        }
    }

    private static func optionalText(_ value: String?) -> SQLiteValue {
        value.map(SQLiteValue.text) ?? .null
    }

    private static func isValidRecordVersion(_ version: Data) -> Bool {
        version.count == SyncBindingIdentity.bindingRecordVersionByteCount
    }

    private static func scopeBindings(
        _ identity: SyncBindingIdentity,
        includeGeneration: Bool = true
    ) -> [SQLiteValue] {
        var values: [SQLiteValue] = [
            .text(identity.serverID), .text(identity.accountID), .text(identity.deviceID),
        ]
        if includeGeneration { values.append(.text(identity.generation)) }
        return values
    }

    private static let bindingKeyWhere = "server_id = ? AND account_id = ? AND device_id = ?"
    private static let scopeWhere = bindingKeyWhere + " AND generation = ?"
    private static let scopedTables: Set<String> = [
        "mirror_entities", "pending_operations", "applied_operations", "bootstrap_runs",
        "bootstrap_entities", "conflicts", "tombstones",
    ]
}

private struct StateRow {
    let identity: SyncBindingIdentity
    let runtimeLeaseState: SyncRuntimeLeaseState
    let bindingState: BindingState
    let appliedCursor: Int64
    let acknowledgedCursor: Int64
    let snapshotCursor: Int64
    let registryHash: String?
    let consecutiveFailures: Int
    let nextEligibleAt: Int64?
}

private struct BootstrapRunRow {
    let stagingGeneration: String
    let bootstrapId: String
    let snapshotCursor: Int64
    let nextPageToken: String?
    let pagesFetched: Int
    let entitiesStaged: Int
    let expiresAt: Int64?
    let complete: Bool
}

private struct MirrorRow {
    let type: String
    let id: String
    let revision: Int64
    let serverChangedAt: Int64
    let localChangedAt: Int64
    let fieldMask: [String]
    let payload: [String: MobileJSONValue]
    let secretEnvelopes: [String: MobileSecretEnvelope]
    let hasPending: Bool

    var model: SyncMirrorEntity {
        SyncMirrorEntity(
            entityType: type,
            entityId: id,
            revision: revision,
            serverChangedAtMilliseconds: serverChangedAt,
            localChangedAtMilliseconds: localChangedAt,
            fieldMask: fieldMask,
            payload: payload,
            secretEnvelopes: secretEnvelopes,
            hasPendingWrite: hasPending
        )
    }
}

// MARK: - Minimal SQLite binding

private enum SQLiteValue {
    case null
    case integer(Int64)
    case real(Double)
    case text(String)
    case blob(Data)
}

private enum SQLiteCell {
    case null
    case integer(Int64)
    case real(Double)
    case text(String)
    case blob(Data)
}

private struct SQLiteRow {
    let cells: [SQLiteCell]

    func integer(_ index: Int) -> Int64 {
        guard case .integer(let value) = cells[index] else { return 0 }
        return value
    }

    func optionalInteger(_ index: Int) -> Int64? {
        guard case .integer(let value) = cells[index] else { return nil }
        return value
    }

    func text(_ index: Int) -> String {
        guard case .text(let value) = cells[index] else { return "" }
        return value
    }

    func optionalText(_ index: Int) -> String? {
        guard case .text(let value) = cells[index] else { return nil }
        return value
    }

    func blob(_ index: Int) -> Data {
        guard case .blob(let value) = cells[index] else { return Data() }
        return value
    }
}

private final class SQLiteDatabase {
    private static let expectedCipherVersion = "4.10.0"
    private static let expectedSQLiteVersion = "3.50.4"
    private static let sqliteNotADatabasePrimaryCode: Int32 = 26
    private var handle: OpaquePointer?
    private var isInMemory = false
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init(url: URL, key: Data, createNew: Bool) throws {
        try open(location: Self.sqliteLocation(for: url), key: key, createNew: createNew)
    }

    static func inMemory(key: Data) throws -> SQLiteDatabase {
        let database = SQLiteDatabase()
        try database.open(location: ":memory:", key: key, createNew: true)
        return database
    }

    static func plaintext(url: URL) throws -> SQLiteDatabase {
        let database = SQLiteDatabase()
        try database.open(location: sqliteLocation(for: url), key: nil, createNew: false)
        return database
    }

    private init() {}

    private static func sqliteLocation(for url: URL) throws -> String {
        try trustedSQLiteLocation(for: url)
    }

    private func open(location: String, key: Data?, createNew: Bool) throws {
        isInMemory = location == ":memory:"
        var opened: OpaquePointer?
        var flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        if createNew { flags |= SQLITE_OPEN_CREATE }
        if !isInMemory { flags |= SQLITE_OPEN_NOFOLLOW }
        let code = sqlite3_open_v2(
            location,
            &opened,
            flags,
            nil
        )
        guard code == SQLITE_OK, let opened else {
            let message = opened.map { String(cString: sqlite3_errmsg($0)) } ?? "cannot open database"
            if let opened { sqlite3_close_v2(opened) }
            throw SQLiteSyncRepositoryError.database(code: code, message: message)
        }
        handle = opened
        do {
            if let key {
                guard key.count == KeychainSyncDatabaseKeyStore.keyByteCount else {
                    throw SyncDatabaseKeyStoreError.invalidStoredKey
                }
                // SQLCipher requires keying to be the first statement after
                // sqlite3_open_v2 and before any page or schema access.
                try applyKey(key)
                try execute("PRAGMA cipher_memory_security = ON;")
                try verifyCipherIntegrity()
                let journal = try query("PRAGMA journal_mode = WAL;")
                let expectedJournal = isInMemory ? "memory" : "wal"
                guard journal.count == 1,
                      journal[0].text(0).lowercased() == expectedJournal else {
                    throw SQLiteSyncRepositoryError.databaseIntegrityFailed(
                        "journal_mode_transition"
                    )
                }
            } else {
                // Force a read now: an encrypted or corrupt file must never be
                // accepted by the plaintext-only legacy migration path.
                _ = try query("SELECT count(*) FROM sqlite_master;")
            }
            try execute("PRAGMA synchronous = FULL;")
            try execute("PRAGMA foreign_keys = ON;")
            try execute("PRAGMA secure_delete = ON;")
            try execute("PRAGMA busy_timeout = 5000;")
        } catch let error {
            sqlite3_close_v2(opened)
            handle = nil
            if key != nil,
               let repositoryError = error as? SQLiteSyncRepositoryError,
               case .database(let code, _) = repositoryError,
               (code & 0xFF) == Self.sqliteNotADatabasePrimaryCode {
                throw SQLiteSyncRepositoryError.databaseAuthenticationFailed
            }
            throw error
        }
    }

    deinit {
        if let handle { sqlite3_close_v2(handle) }
    }

    func close() throws {
        guard let handle else { return }
        let code = sqlite3_close_v2(handle)
        guard code == SQLITE_OK else { throw databaseError(code) }
        self.handle = nil
    }

    func exportEncryptedCopy(to url: URL, key: Data) throws {
        guard key.count == KeychainSyncDatabaseKeyStore.keyByteCount else {
            throw SyncDatabaseKeyStoreError.invalidStoredKey
        }
        try execute("PRAGMA cipher_memory_security = ON;")
        let digits = Array("0123456789abcdef".utf8)
        var rawKeySpec = Data([0x78, 0x27])
        rawKeySpec.reserveCapacity((key.count * 2) + 3)
        for byte in key {
            rawKeySpec.append(digits[Int(byte >> 4)])
            rawKeySpec.append(digits[Int(byte & 0x0F)])
        }
        rawKeySpec.append(0x27)
        let location = try Self.sqliteLocation(for: url)
        try execute(
            "ATTACH DATABASE ? AS encrypted KEY ?;",
            [.text(location), .blob(rawKeySpec)]
        )
        do {
            _ = try query("SELECT sqlcipher_export('encrypted');")
            try execute("DETACH DATABASE encrypted;")
        } catch {
            try? execute("DETACH DATABASE encrypted;")
            throw error
        }
    }

    func verifyCipherIntegrity() throws {
        let version = try query("PRAGMA cipher_version;")
        guard version.count == 1,
              version[0].text(0).hasPrefix(Self.expectedCipherVersion) else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("unexpected_cipher_version")
        }
        let sqliteVersion = try query("SELECT sqlite_version();")
        guard sqliteVersion.count == 1,
              sqliteVersion[0].text(0) == Self.expectedSQLiteVersion else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("unexpected_sqlite_version")
        }
        _ = try query("SELECT count(*) FROM sqlite_master;")
        // SQLCipher 4.10 reports "database file is undefined" for this
        // file-level check on :memory: databases. The version and schema-read
        // checks above still prove the keyed cleanup-only handle is usable.
        guard !isInMemory else { return }
        let result = try query("PRAGMA cipher_integrity_check;")
        guard result.isEmpty else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("cipher_integrity_check")
        }
    }

    func verifyInitializedCipherIntegrity() throws {
        if !isInMemory {
            try checkpointTruncate()
        }
        try verifyCipherIntegrity()
    }

    func preparePlaintextForCopy() throws {
        try checkpointTruncate()
        try switchToDeleteJournal()
        try close()
    }

    func prepareEncryptedForPromotion() throws {
        try checkpointTruncate()
        try switchToDeleteJournal()
        try close()
    }

    func securelyEraseLegacyContent(tables: Set<String>) throws {
        let existingTables = Set(try query(
            "SELECT name FROM sqlite_master WHERE type = 'table';"
        ).map { $0.text(0) })
        try transaction {
            for table in tables where existingTables.contains(table) {
                // Names come from SQLiteSyncRepository.scopedTables, not from
                // the database, so this interpolation cannot inject SQL.
                try execute("DELETE FROM \(table);")
            }
        }
        // Keep sync_state until unlink: if filesystem removal fails, its exact
        // owner tuple permits a safe cleanup retry while all mirror payloads
        // and free-page remnants have already been removed.
        try checkpointTruncate()
        try execute("VACUUM;")
        try checkpointTruncate()
        try switchToDeleteJournal()
        try close()
    }

    func switchToDeleteJournal() throws {
        let result = try query("PRAGMA journal_mode = DELETE;")
        let expected = isInMemory ? "memory" : "delete"
        guard result.count == 1, result[0].text(0).lowercased() == expected else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("journal_mode_transition")
        }
    }

    private func checkpointTruncate() throws {
        let rows = try query("PRAGMA wal_checkpoint(TRUNCATE);")
        if let row = rows.first, row.integer(0) != 0 {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("wal_checkpoint_busy")
        }
    }

    private func applyKey(_ key: Data) throws {
        let hexadecimal = key.map { String(format: "%02x", $0) }.joined()
        try rawExecute("PRAGMA key = \"x'\(hexadecimal)'\";")
    }

    private func rawExecute(_ sql: String) throws {
        guard handle != nil else { throw SQLiteSyncRepositoryError.inactiveBinding }
        var message: UnsafeMutablePointer<CChar>?
        let code = sqlite3_exec(handle, sql, nil, nil, &message)
        guard code == SQLITE_OK else {
            let text = message.map { String(cString: $0) } ?? errorMessage
            sqlite3_free(message)
            throw SQLiteSyncRepositoryError.database(code: code, message: text)
        }
    }

    func transaction(_ body: () throws -> Void) throws {
        try execute("BEGIN IMMEDIATE;")
        do {
            try body()
            try execute("COMMIT;")
        } catch {
            try? execute("ROLLBACK;")
            throw error
        }
    }

    func execute(_ sql: String, _ bindings: [SQLiteValue] = []) throws {
        guard handle != nil else { throw SQLiteSyncRepositoryError.inactiveBinding }
        if bindings.isEmpty && sql.contains(";") {
            var message: UnsafeMutablePointer<CChar>?
            let code = sqlite3_exec(handle, sql, nil, nil, &message)
            guard code == SQLITE_OK else {
                let text = message.map { String(cString: $0) } ?? errorMessage
                sqlite3_free(message)
                throw SQLiteSyncRepositoryError.database(code: code, message: text)
            }
            return
        }

        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        try bind(bindings, to: statement)
        let code = sqlite3_step(statement)
        guard code == SQLITE_DONE else { throw databaseError(code) }
    }

    func queryOne(_ sql: String, _ bindings: [SQLiteValue] = []) throws -> SQLiteRow? {
        try query(sql, bindings).first
    }

    func query(_ sql: String, _ bindings: [SQLiteValue] = []) throws -> [SQLiteRow] {
        guard handle != nil else { throw SQLiteSyncRepositoryError.inactiveBinding }
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        try bind(bindings, to: statement)
        var rows: [SQLiteRow] = []
        while true {
            let code = sqlite3_step(statement)
            if code == SQLITE_DONE { return rows }
            guard code == SQLITE_ROW else { throw databaseError(code) }
            var cells: [SQLiteCell] = []
            for index in 0..<sqlite3_column_count(statement) {
                switch sqlite3_column_type(statement, index) {
                case SQLITE_INTEGER:
                    cells.append(.integer(sqlite3_column_int64(statement, index)))
                case SQLITE_FLOAT:
                    cells.append(.real(sqlite3_column_double(statement, index)))
                case SQLITE_TEXT:
                    if let pointer = sqlite3_column_text(statement, index) {
                        cells.append(.text(String(cString: pointer)))
                    } else {
                        cells.append(.null)
                    }
                case SQLITE_BLOB:
                    let count = Int(sqlite3_column_bytes(statement, index))
                    if count == 0 {
                        cells.append(.blob(Data()))
                    } else if let pointer = sqlite3_column_blob(statement, index) {
                        cells.append(.blob(Data(bytes: pointer, count: count)))
                    } else {
                        cells.append(.null)
                    }
                default:
                    cells.append(.null)
                }
            }
            rows.append(SQLiteRow(cells: cells))
        }
    }

    private func prepare(_ sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        let code = sqlite3_prepare_v2(handle, sql, -1, &statement, nil)
        guard code == SQLITE_OK, let statement else { throw databaseError(code) }
        return statement
    }

    private func bind(_ values: [SQLiteValue], to statement: OpaquePointer) throws {
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1)
            let code: Int32
            switch value {
            case .null:
                code = sqlite3_bind_null(statement, index)
            case .integer(let value):
                code = sqlite3_bind_int64(statement, index, value)
            case .real(let value):
                code = sqlite3_bind_double(statement, index, value)
            case .text(let value):
                code = sqlite3_bind_text(statement, index, value, -1, Self.transient)
            case .blob(let value):
                code = value.withUnsafeBytes { buffer in
                    sqlite3_bind_blob(statement, index, buffer.baseAddress, Int32(buffer.count), Self.transient)
                }
            }
            guard code == SQLITE_OK else { throw databaseError(code) }
        }
    }

    private var errorMessage: String {
        handle.map { String(cString: sqlite3_errmsg($0)) } ?? "database is closed"
    }

    private func databaseError(_ code: Int32) -> SQLiteSyncRepositoryError {
        .database(code: code, message: errorMessage)
    }
}
