import Foundation
import SQLCipher
import XCTest
@testable import ZephyrCore
import ZephyrContracts

final class SQLiteSyncRepositoryTests: XCTestCase {
    private var directory: URL!
    private var keyStore: MemorySyncDatabaseKeyStore!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("zephyr-sync-store-" + UUID().uuidString, isDirectory: true)
        keyStore = MemorySyncDatabaseKeyStore()
    }

    override func tearDownWithError() throws {
        if let directory, FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
        }
    }

    func testLocalMirrorWriteAndOperationSurviveReopenAtomically() async throws {
        let identity = binding()
        let first = try repository(identity)
        let operation = localUpsert(opId: "op-1", entityId: "c-1", name: "Local", baseRevision: 0)

        let written = try await first.writeLocal(
            SyncLocalWrite(operation: operation, localChangedAtMilliseconds: 100),
            for: identity
        )
        XCTAssertEqual(written?.payload["name"], .string("Local"))
        XCTAssertEqual(written?.payload["ownerUserId"], .string("user-1"))
        XCTAssertEqual(written?.hasPendingWrite, true)

        let reopened = try repository(identity)
        let reopenedEntity = try await reopened.entity(type: "connection", id: "c-1", for: identity)
        XCTAssertEqual(reopenedEntity, written)
        let pending = try await reopened.pendingOperations(limit: 10, for: identity)
        XCTAssertEqual(pending, [operation])
        XCTAssertEqual(pending[0].opId, "op-1")
        XCTAssertEqual(pending[0].baseRevision, 0)
        XCTAssertEqual(pending[0].fieldMask, ["name"])

        // The operation collision occurs after the optimistic row is attempted. SQLite rolls the
        // whole transaction back, so c-2 cannot become visible without a queue entry.
        await assertRepositoryError(.invalidLocalWrite("opId already exists")) {
            _ = try await reopened.writeLocal(
                SyncLocalWrite(
                    operation: self.localUpsert(
                        opId: "op-1",
                        entityId: "c-2",
                        name: "Must roll back",
                        baseRevision: 0
                    ),
                    localChangedAtMilliseconds: 101
                ),
                for: identity
            )
        }
        let rolledBack = try await reopened.entity(type: "connection", id: "c-2", for: identity)
        XCTAssertNil(rolledBack)
    }

    func testIncompleteBootstrapIsInvisibleAndCompleteGenerationRecoversAfterCrash() async throws {
        let identity = binding()
        let store = try repository(identity)
        _ = try await store.applyChangePage(
            changesPage(from: 0, next: 1, changes: [
                try change(seq: 1, id: "old", revision: 1, name: "Old")
            ]),
            expectedCursor: 0,
            for: identity
        )

        let continuation = SyncBootstrapCheckpoint(
            stagingGeneration: "stage-1",
            bootstrapId: "bootstrap-1",
            snapshotCursor: 10,
            nextPageToken: "page-2",
            pagesFetched: 1,
            entitiesStaged: 1,
            expiresAtMilliseconds: 50_000
        )
        let firstPage = MobileBootstrapResponse(
            ok: true,
            bootstrapId: "bootstrap-1",
            snapshotCursor: 10,
            nextPageToken: "page-2",
            complete: false,
            entities: [try change(seq: 0, id: "new-1", revision: 3, name: "New one")]
        )
        let firstPageCount = try await store.stageBootstrapPage(
            firstPage,
            requestedPageToken: nil,
            stagingGeneration: "stage-1",
            continuation: continuation,
            for: identity
        )
        XCTAssertEqual(firstPageCount, 1)
        let oldBeforePromotion = try await store.entity(type: "connection", id: "old", for: identity)
        let stagedBeforePromotion = try await store.entity(type: "connection", id: "new-1", for: identity)
        XCTAssertNotNil(oldBeforePromotion)
        XCTAssertNil(stagedBeforePromotion)

        let resumed = try repository(identity)
        let resumedSnapshot = try await resumed.snapshot()
        XCTAssertEqual(resumedSnapshot?.bootstrapCheckpoint, continuation)
        await assertRepositoryError(
            .invalidBootstrap("only a complete staged generation can be promoted")
        ) {
            try await resumed.commitBootstrap(
                stagingGeneration: "stage-1",
                snapshotCursor: 10,
                for: identity
            )
        }

        let finalPage = MobileBootstrapResponse(
            ok: true,
            bootstrapId: "bootstrap-1",
            snapshotCursor: 10,
            nextPageToken: nil,
            complete: true,
            entities: [try change(seq: 0, id: "new-2", revision: 4, name: "New two")]
        )
        _ = try await resumed.stageBootstrapPage(
            finalPage,
            requestedPageToken: "page-2",
            stagingGeneration: "stage-1",
            continuation: nil,
            for: identity
        )

        // Simulate process death between the complete-page transaction and commitBootstrap.
        let recovered = try repository(identity)
        let snapshot = try await recovered.snapshot()
        XCTAssertEqual(snapshot?.appliedCursor, 10)
        XCTAssertEqual(snapshot?.snapshotCursor, 10)
        XCTAssertNil(snapshot?.bootstrapCheckpoint)
        let oldAfterPromotion = try await recovered.entity(type: "connection", id: "old", for: identity)
        let firstAfterPromotion = try await recovered.entity(
            type: "connection",
            id: "new-1",
            for: identity
        )
        let secondAfterPromotion = try await recovered.entity(
            type: "connection",
            id: "new-2",
            for: identity
        )
        XCTAssertNil(oldAfterPromotion)
        XCTAssertEqual(
            firstAfterPromotion?.payload["name"],
            .string("New one")
        )
        XCTAssertEqual(
            secondAfterPromotion?.payload["name"],
            .string("New two")
        )
    }

    func testChangePageAndCursorRollbackTogether() async throws {
        let identity = binding()
        let store = try repository(identity)
        let invalid = changesPage(from: 0, next: 1, changes: [
            try change(seq: 1, id: "c-1", revision: 1, name: "Would apply"),
            try change(seq: 2, id: "c-2", revision: 1, name: "Invalid sequence"),
        ])

        await assertRepositoryError(
            .invalidChangePage("change sequence lies outside the page cursor range")
        ) {
            _ = try await store.applyChangePage(invalid, expectedCursor: 0, for: identity)
        }
        let rolledBackSnapshot = try await store.snapshot()
        let rolledBackEntity = try await store.entity(type: "connection", id: "c-1", for: identity)
        XCTAssertEqual(rolledBackSnapshot?.appliedCursor, 0)
        XCTAssertNil(rolledBackEntity)

        let valid = changesPage(from: 0, next: 1, changes: [
            try change(seq: 1, id: "c-1", revision: 1, name: "Committed")
        ])
        let applied = try await store.applyChangePage(valid, expectedCursor: 0, for: identity)
        XCTAssertEqual(applied, SyncApplyResult(applied: 1, skipped: 0))
        let committedSnapshot = try await store.snapshot()
        let committedEntity = try await store.entity(type: "connection", id: "c-1", for: identity)
        XCTAssertEqual(committedSnapshot?.appliedCursor, 1)
        XCTAssertEqual(
            committedEntity?.payload["name"],
            .string("Committed")
        )
    }

    func testChangePageRejectsMissingAndMalformedOwnersWithoutWritingSecretsOrCursor() async throws {
        let identity = binding()
        let store = try repository(identity)
        let invalidOwnerPayloads = [
            "\"name\":\"Missing owner\"",
            "\"name\":\"Wrong owner type\",\"ownerUserId\":7",
            "\"name\":\"Wrong owner\",\"ownerUserId\":\"user-2\"",
        ]

        for (index, payload) in invalidOwnerPayloads.enumerated() {
            let invalid = try decodeChange(
                """
                {"changeSeq":2,"entityType":"connection","entityId":"invalid-\(index)",
                 "action":"upsert","revision":1,"changedAt":200,
                 "payload":{\(payload)},
                 "secretEnvelopes":{"password":{"v":1,
                 "alg":"ML-KEM-768+HKDF-SHA256+AES-256-GCM","kem":"ML-KEM-768",
                 "aead":"AES-256-GCM","ct":"Y3Q=","iv":"aXY=","tag":"dGFn",
                 "data":"c2VjcmV0","aad":"YWFk","keyVersion":1,"entityRevision":1}}}
                """
            )
            let page = changesPage(from: 0, next: 2, changes: [
                try change(seq: 1, id: "would-rollback-\(index)", revision: 1, name: "Valid"),
                invalid,
            ])
            await assertRepositoryError(
                .invalidChangePage("entity owner is missing or does not match the binding")
            ) {
                _ = try await store.applyChangePage(page, expectedCursor: 0, for: identity)
            }
            let snapshot = try await store.snapshot()
            let rolledBack = try await store.entity(
                type: "connection",
                id: "would-rollback-\(index)",
                for: identity
            )
            let rejected = try await store.entity(
                type: "connection",
                id: "invalid-\(index)",
                for: identity
            )
            XCTAssertEqual(snapshot?.appliedCursor, 0)
            XCTAssertNil(rolledBack)
            XCTAssertNil(rejected)
        }
    }

    func testBootstrapOwnerFailureRollsBackTheWholeStagingPage() async throws {
        let identity = binding()
        let store = try repository(identity)
        let invalid = try decodeChange(
            """
            {"changeSeq":0,"entityType":"connection","entityId":"bad-bootstrap",
             "action":"upsert","revision":1,"changedAt":200,
             "payload":{"name":"Wrong","ownerUserId":"user-2"}}
            """
        )
        let page = MobileBootstrapResponse(
            ok: true,
            bootstrapId: "bootstrap-owner",
            snapshotCursor: 5,
            nextPageToken: nil,
            complete: true,
            entities: [
                try change(seq: 0, id: "would-stage", revision: 1, name: "Valid"),
                invalid,
            ]
        )

        await assertRepositoryError(
            .invalidBootstrap("entity owner is missing or does not match the binding")
        ) {
            _ = try await store.stageBootstrapPage(
                page,
                requestedPageToken: nil,
                stagingGeneration: "stage-owner",
                continuation: nil,
                for: identity
            )
        }
        let snapshot = try await store.snapshot()
        let staged = try await store.entity(type: "connection", id: "would-stage", for: identity)
        XCTAssertNil(snapshot?.bootstrapCheckpoint)
        XCTAssertNil(staged)
    }

    func testServerTombstonePurgesMirrorPendingOperationAndConflict() async throws {
        let identity = binding()
        let store = try repository(identity)
        _ = try await store.applyChangePage(
            changesPage(from: 0, next: 1, changes: [
                try change(seq: 1, id: "c-1", revision: 1, name: "Server")
            ]),
            expectedCursor: 0,
            for: identity
        )

        let firstOperation = localUpsert(
            opId: "op-conflict",
            entityId: "c-1",
            name: "First local",
            baseRevision: 1
        )
        _ = try await store.writeLocal(
            SyncLocalWrite(operation: firstOperation, localChangedAtMilliseconds: 10),
            for: identity
        )
        try await store.applyPushOutcomes(
            [.conflicted(SyncConflictRecord(
                opId: firstOperation.opId,
                entityType: "connection",
                entityId: "c-1",
                localBaseRevision: 1,
                localFieldMask: ["name"],
                localPayload: ["name": .string("First local")],
                localSecretEnvelopes: [:],
                serverRevision: 2,
                serverPayload: ["name": .string("Other")],
                overlapFields: ["name"],
                serverDeleted: false,
                aclRevoked: false
            ))],
            for: identity
        )
        let conflictReopened = try repository(identity)
        let conflictsBeforeDelete = try await conflictReopened.conflicts(for: identity)
        XCTAssertEqual(conflictsBeforeDelete.count, 1)

        _ = try await store.writeLocal(
            SyncLocalWrite(
                operation: localUpsert(
                    opId: "op-pending",
                    entityId: "c-1",
                    name: "Second local",
                    baseRevision: 1
                ),
                localChangedAtMilliseconds: 11
            ),
            for: identity
        )
        _ = try await store.applyChangePage(
            changesPage(from: 1, next: 2, changes: [
                try deleteChange(seq: 2, id: "c-1", revision: 3)
            ]),
            expectedCursor: 1,
            for: identity
        )

        let entityAfterDelete = try await store.entity(type: "connection", id: "c-1", for: identity)
        let pendingAfterDelete = try await store.pendingOperations(limit: 10, for: identity)
        let conflictsAfterDelete = try await store.conflicts(for: identity)
        XCTAssertNil(entityAfterDelete)
        XCTAssertTrue(pendingAfterDelete.isEmpty)
        XCTAssertTrue(conflictsAfterDelete.isEmpty)
    }

    func testDeleteRequiresAnExplicitMatchingTombstoneOwnerAndKeepsCursorOnFailure() async throws {
        let identity = binding()
        let store = try repository(identity)
        _ = try await store.applyChangePage(
            changesPage(from: 0, next: 1, changes: [
                try change(seq: 1, id: "c-owner", revision: 1, name: "Keep")
            ]),
            expectedCursor: 0,
            for: identity
        )

        let invalidTombstones = [
            "\"id\":\"c-owner\"",
            "\"id\":\"c-owner\",\"ownerUserId\":7",
            "\"id\":\"c-owner\",\"ownerUserId\":\"user-2\"",
        ]
        for tombstone in invalidTombstones {
            let invalidDelete = try decodeChange(
                """
                {"changeSeq":2,"entityType":"connection","entityId":"c-owner",
                 "action":"delete","revision":2,"changedAt":200,
                 "tombstone":{\(tombstone)}}
                """
            )
            await assertRepositoryError(
                .invalidChangePage("entity owner is missing or does not match the binding")
            ) {
                _ = try await store.applyChangePage(
                    changesPage(from: 1, next: 2, changes: [invalidDelete]),
                    expectedCursor: 1,
                    for: identity
                )
            }
            let snapshot = try await store.snapshot()
            let retained = try await store.entity(type: "connection", id: "c-owner", for: identity)
            XCTAssertEqual(snapshot?.appliedCursor, 1)
            XCTAssertNotNil(retained)
        }
    }

    func testACLRevocationPurgesTheReferencedResource() async throws {
        let identity = binding()
        let store = try repository(identity)
        _ = try await store.writeLocal(
            SyncLocalWrite(
                operation: localUpsert(
                    opId: "op-local",
                    entityId: "shared-connection",
                    name: "Must disappear",
                    baseRevision: 0
                ),
                localChangedAtMilliseconds: 10
            ),
            for: identity
        )

        let aclDelete = try decodeChange(
            """
            {"changeSeq":1,"entityType":"resourceAcl","entityId":"grant-1",
             "action":"delete","revision":9,"changedAt":100,
             "tombstone":{"resourceType":"connection","resourceId":"shared-connection",
             "resourceOwnerUserId":"user-1"}}
            """
        )
        _ = try await store.applyChangePage(
            changesPage(from: 0, next: 1, changes: [aclDelete]),
            expectedCursor: 0,
            for: identity
        )

        let resourceAfterRevocation = try await store.entity(
            type: "connection",
            id: "shared-connection",
            for: identity
        )
        let pendingAfterRevocation = try await store.pendingOperations(limit: 10, for: identity)
        XCTAssertNil(resourceAfterRevocation)
        XCTAssertTrue(pendingAfterRevocation.isEmpty)
    }

    func testServerAndAccountScopesDoNotShareRowsOrCursors() async throws {
        let firstIdentity = binding()
        let first = try repository(firstIdentity)
        _ = try await first.writeLocal(
            SyncLocalWrite(
                operation: localUpsert(
                    opId: "user-1-op",
                    entityId: "c-1",
                    name: "User one",
                    baseRevision: 0
                ),
                localChangedAtMilliseconds: 10
            ),
            for: firstIdentity
        )

        let otherAccount = SyncBindingIdentity(
            serverID: firstIdentity.serverID,
            accountID: "user-2",
            deviceID: firstIdentity.deviceID,
            generation: firstIdentity.generation,
            bindingRecordVersion: leaseVersion(0x21)
        )
        let second = try repository(otherAccount)
        let otherAccountEntity = try await second.entity(type: "connection", id: "c-1", for: otherAccount)
        let otherAccountPending = try await second.pendingOperations(limit: 10, for: otherAccount)
        XCTAssertNil(otherAccountEntity)
        XCTAssertTrue(otherAccountPending.isEmpty)

        let otherServer = SyncBindingIdentity(
            serverID: "server-2",
            accountID: firstIdentity.accountID,
            deviceID: firstIdentity.deviceID,
            generation: firstIdentity.generation,
            bindingRecordVersion: leaseVersion(0x22)
        )
        let third = try repository(otherServer)
        let otherServerEntity = try await third.entity(type: "connection", id: "c-1", for: otherServer)
        XCTAssertNil(otherServerEntity)

        let firstEntity = try await first.entity(type: "connection", id: "c-1", for: firstIdentity)
        let firstPending = try await first.pendingOperations(limit: 10, for: firstIdentity)
        XCTAssertEqual(firstEntity?.payload["name"], .string("User one"))
        XCTAssertEqual(firstPending.map(\.opId), ["user-1-op"])
    }

    func testCrashRecoveryKeepsOpIdsAndRebindUsesIndependentEncryptedState() async throws {
        let firstIdentity = binding(generation: "generation-1")
        let operation = localUpsert(opId: "stable-op", entityId: "c-1", name: "Local", baseRevision: 0)
        do {
            let first = try repository(firstIdentity)
            _ = try await first.writeLocal(
                SyncLocalWrite(operation: operation, localChangedAtMilliseconds: 10),
                for: firstIdentity
            )
            try await first.markDispatched(
                opIds: [operation.opId],
                batchId: "batch-before-crash",
                at: 20,
                for: firstIdentity
            )
            try await first.saveBindingState(.running, for: firstIdentity)
        }

        let recovered = try repository(firstIdentity)
        let recoveredSnapshot = try await recovered.snapshot()
        let recoveredOperations = try await recovered.pendingOperations(limit: 10, for: firstIdentity)
        XCTAssertEqual(recoveredSnapshot?.bindingState, .idle)
        XCTAssertEqual(
            recoveredOperations.map(\.opId),
            ["stable-op"]
        )

        let secondIdentity = binding(generation: "generation-2")
        let rebound = try repository(secondIdentity)
        let reboundOperations = try await rebound.pendingOperations(limit: 10, for: secondIdentity)
        let reboundEntity = try await rebound.entity(type: "connection", id: "c-1", for: secondIdentity)
        XCTAssertTrue(reboundOperations.isEmpty)
        XCTAssertNil(reboundEntity)

        XCTAssertNotEqual(databaseURL(for: firstIdentity), databaseURL(for: secondIdentity))
        XCTAssertNotEqual(
            try XCTUnwrap(keyStore.key(for: try SyncDatabaseKeyScope(identity: firstIdentity))),
            try XCTUnwrap(keyStore.key(for: try SyncDatabaseKeyScope(identity: secondIdentity)))
        )

        // The binding coordinator joins the old runtime and purges this file
        // before promoting the replacement binding. Once purged, a retained
        // repository reference cannot accept a late response.
        try await recovered.purgeAll(for: firstIdentity)
        await assertRepositoryError(.inactiveBinding) {
            _ = try await recovered.writeLocal(
                SyncLocalWrite(
                    operation: self.localUpsert(
                        opId: "late-op",
                        entityId: "c-2",
                        name: "Late response",
                        baseRevision: 0
                    ),
                    localChangedAtMilliseconds: 30
                ),
                for: firstIdentity
            )
        }
    }

    func testDatabaseHeaderIsEncryptedAndWrongKeyFailsClosed() async throws {
        let identity = binding()
        let store = try repository(identity)
        _ = try await store.snapshot()

        let url = databaseURL(for: identity)
        let header = try Data(contentsOf: url, options: .mappedIfSafe).prefix(16)
        XCTAssertNotEqual(Data(header), Data("SQLite format 3\u{0}".utf8))
        XCTAssertEqual(
            SQLiteSyncDatabaseFilePolicy.iOSProtectionClassName,
            "NSFileProtectionComplete"
        )
        #if os(iOS)
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        XCTAssertEqual(attributes[.protectionKey] as? FileProtectionType, .complete)
        #endif

        let wrongKeys = MemorySyncDatabaseKeyStore()
        try wrongKeys.set(
            Data(repeating: 0xEF, count: KeychainSyncDatabaseKeyStore.keyByteCount),
            for: SyncDatabaseKeyScope(identity: identity)
        )
        XCTAssertThrowsError(
            try SQLiteSyncRepository(
                databaseURL: url,
                identity: identity,
                keyStore: wrongKeys
            )
        ) { error in
            XCTAssertEqual(error as? SQLiteSyncRepositoryError, .databaseAuthenticationFailed)
        }
    }

    func testPurgeClosesAndRemovesEncryptedDatabaseSidecarsBeforeDeletingKey() async throws {
        let identity = binding()
        let store = try repository(identity)
        _ = try await store.writeLocal(
            SyncLocalWrite(
                operation: localUpsert(
                    opId: "purge-op",
                    entityId: "purge-entity",
                    name: "Erase me",
                    baseRevision: 0
                ),
                localChangedAtMilliseconds: 100
            ),
            for: identity
        )

        let url = databaseURL(for: identity)
        let scope = try SyncDatabaseKeyScope(identity: identity)
        XCTAssertNotNil(keyStore.key(for: scope))
        keyStore.failNextDeletion()
        do {
            try await store.purgeAll(for: identity)
            XCTFail("Expected the first key deletion to fail")
        } catch let error as MemoryDatabaseKeyStoreError {
            XCTAssertEqual(error, .injectedDeleteFailure)
        }

        // Database files are already gone, but cleanupPending retains the key
        // so the exact same erasure can be retried without recreating data.
        XCTAssertNotNil(keyStore.key(for: scope))
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        try await store.purgeAll(for: identity)

        for suffix in ["", "-wal", "-shm", "-journal"] {
            XCTAssertFalse(FileManager.default.fileExists(atPath: url.path + suffix), suffix)
        }
        XCTAssertNil(keyStore.key(for: scope))

        // A cleanupPending retry after a crash between key erasure and binding
        // record clearing is idempotent and does not recreate a durable file.
        let retry = try SQLiteSyncRepository(
            databaseURL: url,
            identity: identity,
            cleanupOnly: true,
            keyStore: keyStore
        )
        try await retry.purgeAll(for: identity)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testOwnerProvenPlaintextMigrationIsAtomicAndCrashRetryable() async throws {
        let identity = binding()
        let legacyURL = SQLiteSyncRepository.legacyAccountDatabaseURL(
            in: directory,
            serverID: identity.serverID,
            accountID: identity.accountID
        )
        let targetURL = databaseURL(for: identity)
        try createLegacyDatabase(at: legacyURL, identity: identity)

        XCTAssertThrowsError(
            try SQLiteSyncRepository(
                databaseURL: targetURL,
                identity: identity,
                keyStore: keyStore,
                legacyDatabaseURL: legacyURL,
                migrationHooks: SQLiteSyncMigrationHooks { stage in
                    if stage == .beforePromotion { throw MigrationInterruption.simulatedCrash }
                }
            )
        ) { error in
            XCTAssertEqual(error as? MigrationInterruption, .simulatedCrash)
        }

        XCTAssertTrue(FileManager.default.fileExists(atPath: legacyURL.path))
        XCTAssertEqual(
            Data(try Data(contentsOf: legacyURL).prefix(16)),
            Data("SQLite format 3\u{0}".utf8)
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: targetURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: targetURL.path + ".migrating"))

        XCTAssertThrowsError(
            try SQLiteSyncRepository(
                databaseURL: targetURL,
                identity: identity,
                keyStore: keyStore,
                legacyDatabaseURL: legacyURL,
                migrationHooks: SQLiteSyncMigrationHooks { stage in
                    if stage == .promoted { throw MigrationInterruption.simulatedCrash }
                }
            )
        ) { error in
            XCTAssertEqual(error as? MigrationInterruption, .simulatedCrash)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacyURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: targetURL.path))
        XCTAssertNotEqual(
            Data(try Data(contentsOf: targetURL).prefix(16)),
            Data("SQLite format 3\u{0}".utf8)
        )

        let migrated = try SQLiteSyncRepository(
            databaseURL: targetURL,
            identity: identity,
            requireExistingBinding: true,
            keyStore: keyStore,
            legacyDatabaseURL: legacyURL
        )
        let migratedSnapshot = try await migrated.snapshot()
        XCTAssertEqual(migratedSnapshot?.identity, identity)
        XCTAssertEqual(migratedSnapshot?.runtimeLeaseState, .runnable)
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyURL.path))
        XCTAssertNotEqual(
            Data(try Data(contentsOf: targetURL).prefix(16)),
            Data("SQLite format 3\u{0}".utf8)
        )
    }

    func testOwnerProvenMigrationFailureCleanupErasesLegacyTargetAndKey() throws {
        let identity = binding()
        let legacyURL = SQLiteSyncRepository.legacyAccountDatabaseURL(
            in: directory,
            serverID: identity.serverID,
            accountID: identity.accountID
        )
        let targetURL = databaseURL(for: identity)
        let scope = try SyncDatabaseKeyScope(identity: identity)
        try createLegacyDatabase(at: legacyURL, identity: identity)

        XCTAssertThrowsError(
            try SQLiteSyncRepository(
                databaseURL: targetURL,
                identity: identity,
                keyStore: keyStore,
                legacyDatabaseURL: legacyURL,
                migrationHooks: SQLiteSyncMigrationHooks { stage in
                    if stage == .promoted { throw MigrationInterruption.simulatedCrash }
                }
            )
        ) { error in
            XCTAssertEqual(error as? MigrationInterruption, .simulatedCrash)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacyURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: targetURL.path))
        XCTAssertNotNil(keyStore.key(for: scope))

        try SQLiteSyncRepository.eraseEncryptedStorageForCleanup(
            at: targetURL,
            legacyDatabaseURL: legacyURL,
            identity: identity,
            keyStore: keyStore
        )

        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: targetURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: targetURL.path + ".migrating"))
        XCTAssertNil(keyStore.key(for: scope))
    }

    func testCleanupFallbackRejectsUnprovenLegacyAndPreservesGenerationKey() throws {
        let identity = binding()
        let legacyURL = SQLiteSyncRepository.legacyAccountDatabaseURL(
            in: directory,
            serverID: identity.serverID,
            accountID: identity.accountID
        )
        let other = SyncBindingIdentity(
            serverID: identity.serverID,
            accountID: identity.accountID,
            deviceID: identity.deviceID,
            generation: "different-generation",
            bindingRecordVersion: leaseVersion(0x23)
        )
        let scope = try SyncDatabaseKeyScope(identity: identity)
        try createLegacyDatabase(at: legacyURL, identity: other)
        _ = try keyStore.loadOrCreateKey(for: scope)

        XCTAssertThrowsError(
            try SQLiteSyncRepository.eraseEncryptedStorageForCleanup(
                at: databaseURL(for: identity),
                legacyDatabaseURL: legacyURL,
                identity: identity,
                keyStore: keyStore
            )
        ) { error in
            XCTAssertEqual(error as? SQLiteSyncRepositoryError, .legacyOwnerMismatch)
        }

        XCTAssertTrue(FileManager.default.fileExists(atPath: legacyURL.path))
        XCTAssertEqual(
            Data(try Data(contentsOf: legacyURL).prefix(16)),
            Data("SQLite format 3\u{0}".utf8)
        )
        XCTAssertNotNil(keyStore.key(for: scope))
    }

    func testCleanupFallbackTreatsOrphanLegacySidecarAsUnresolved() throws {
        let identity = binding()
        let legacyURL = SQLiteSyncRepository.legacyAccountDatabaseURL(
            in: directory,
            serverID: identity.serverID,
            accountID: identity.accountID
        )
        let orphanWAL = URL(fileURLWithPath: legacyURL.path + "-wal")
        let scope = try SyncDatabaseKeyScope(identity: identity)
        try FileManager.default.createDirectory(
            at: legacyURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data([0x01, 0x02, 0x03]).write(to: orphanWAL, options: .atomic)
        _ = try keyStore.loadOrCreateKey(for: scope)

        XCTAssertThrowsError(
            try SQLiteSyncRepository.eraseEncryptedStorageForCleanup(
                at: databaseURL(for: identity),
                legacyDatabaseURL: legacyURL,
                identity: identity,
                keyStore: keyStore
            )
        )

        XCTAssertTrue(FileManager.default.fileExists(atPath: orphanWAL.path))
        XCTAssertNotNil(keyStore.key(for: scope))
    }

    func testPlaintextMigrationRejectsUnprovenOwnerWithoutTouchingLegacy() throws {
        let identity = binding()
        let legacyURL = SQLiteSyncRepository.legacyAccountDatabaseURL(
            in: directory,
            serverID: identity.serverID,
            accountID: identity.accountID
        )
        let other = SyncBindingIdentity(
            serverID: identity.serverID,
            accountID: identity.accountID,
            deviceID: identity.deviceID,
            generation: "different-generation",
            bindingRecordVersion: leaseVersion(0x23)
        )
        try createLegacyDatabase(at: legacyURL, identity: other)

        XCTAssertThrowsError(
            try SQLiteSyncRepository(
                databaseURL: databaseURL(for: identity),
                identity: identity,
                keyStore: keyStore,
                legacyDatabaseURL: legacyURL
            )
        ) { error in
            XCTAssertEqual(error as? SQLiteSyncRepositoryError, .legacyOwnerMismatch)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacyURL.path))
        XCTAssertEqual(
            Data(try Data(contentsOf: legacyURL).prefix(16)),
            Data("SQLite format 3\u{0}".utf8)
        )
    }

    func testFailureRunStateIsRedactedAndFileIsExcludedFromBackup() async throws {
        let identity = binding()
        let store = try repository(identity)
        let error = MobileApiError(
            code: "internal_error",
            message: "secret server text https://private.invalid",
            retryable: true,
            requestId: "request-1",
            details: ["token": "must-not-persist"],
            httpStatus: 500
        )
        try await store.recordFailure(
            at: 100,
            error: error,
            nextEligibleAtMilliseconds: 200,
            for: identity
        )

        let state = try await store.runState(for: identity)
        XCTAssertEqual(state.lastErrorCode, "internal_error")
        XCTAssertEqual(state.lastErrorDiagnostic, "code=internal_error status=500 requestId=request-1")
        XCTAssertEqual(state.consecutiveFailures, 1)
        XCTAssertEqual(state.nextEligibleAtMilliseconds, 200)
        XCTAssertEqual(
            try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup,
            true
        )
    }

    func testSameGenerationRecordVersionFenceAndPublishRejectEveryOlderRuntime() async throws {
        let firstActive = binding()
        let restoring = firstActive.replacingBindingRecordVersion(leaseVersion(0x12))
        let nextActive = firstActive.replacingBindingRecordVersion(leaseVersion(0x13))
        let store = try repository(firstActive)

        try await store.fenceRuntime(from: firstActive, to: restoring)

        let fencedReport = try await store.snapshot()
        XCTAssertEqual(fencedReport?.identity, restoring)
        XCTAssertEqual(fencedReport?.runtimeLeaseState, .fenced)
        let oldRunnable = try await store.runnableSnapshot(for: firstActive)
        let restoringRunnable = try await store.runnableSnapshot(for: restoring)
        XCTAssertNil(oldRunnable)
        XCTAssertNil(restoringRunnable)
        await assertRepositoryError(.bindingChanged) {
            _ = try await store.writeLocal(
                SyncLocalWrite(
                    operation: self.localUpsert(
                        opId: "old-runtime",
                        entityId: "old-runtime",
                        name: "must not commit",
                        baseRevision: 0
                    ),
                    localChangedAtMilliseconds: 10
                ),
                for: firstActive
            )
        }
        XCTAssertThrowsError(
            try SQLiteSyncRepository(
                databaseURL: databaseURL(for: restoring),
                identity: restoring,
                requireExistingBinding: true,
                keyStore: keyStore
            )
        ) { error in
            XCTAssertEqual(error as? SQLiteSyncRepositoryError, .bindingChanged)
        }

        try await store.publishRuntime(from: restoring, to: nextActive)
        let activeRunnable = try await store.runnableSnapshot(for: nextActive)
        XCTAssertNotNil(activeRunnable)
        await assertRepositoryError(.bindingChanged) {
            try await store.saveRegistryHash("stale-restoring", for: restoring)
        }
        await assertRepositoryError(.bindingChanged) {
            try await store.saveRegistryHash("stale-active", for: firstActive)
        }
        await assertRepositoryError(.bindingChanged) {
            try await store.publishRuntime(from: restoring, to: firstActive)
        }
        await assertRepositoryError(.bindingChanged) {
            try await store.fenceRuntime(from: firstActive, to: restoring)
        }

        let reopened = try repository(nextActive)
        try await reopened.saveRegistryHash("published", for: nextActive)
        let reopenedSnapshot = try await reopened.snapshot()
        XCTAssertEqual(reopenedSnapshot?.registryHash, "published")
    }

    func testRepositoryRejectsMissingBindingRecordVersion() {
        let invalid = binding().replacingBindingRecordVersion(Data())

        XCTAssertThrowsError(try repository(invalid)) { error in
            XCTAssertEqual(error as? SQLiteSyncRepositoryError, .invalidBindingRecordVersion)
        }
    }

    func testFencedRestoringLeaseAdvancesExactlyToCleanupBeforePurge() async throws {
        let active = binding()
        let restoring = active.replacingBindingRecordVersion(leaseVersion(0x51))
        let cleanup = active.replacingBindingRecordVersion(leaseVersion(0x52))
        let store = try repository(active)

        try await store.fenceRuntime(from: active, to: restoring)
        try await store.fenceRuntime(from: restoring, to: cleanup)

        let report = try await store.snapshot()
        XCTAssertEqual(report?.identity, cleanup)
        XCTAssertEqual(report?.runtimeLeaseState, .fenced)
        await assertRepositoryError(.bindingChanged) {
            try await store.saveRegistryHash("stale restoring", for: restoring)
        }
        try await store.purgeAll(for: cleanup)
        XCTAssertFalse(FileManager.default.fileExists(atPath: databaseURL(for: cleanup).path))
    }

    func testFenceSerializesAgainstSameGenerationTransactionAndDeniesPostFenceWrites() async throws {
        let firstActive = binding()
        let restoring = firstActive.replacingBindingRecordVersion(leaseVersion(0x31))
        let firstHandle = try repository(firstActive)
        let racingHandle = try repository(firstActive)
        let racingWrite = SyncLocalWrite(
            operation: localUpsert(
                opId: "racing-op",
                entityId: "racing-entity",
                name: "atomic",
                baseRevision: 0
            ),
            localChangedAtMilliseconds: 20
        )
        let writeTask = Task { () -> SQLiteSyncRepositoryError? in
            do {
                _ = try await racingHandle.writeLocal(racingWrite, for: firstActive)
                return nil
            } catch let error as SQLiteSyncRepositoryError {
                return error
            } catch {
                return .corruptRecord("unexpected racing write error")
            }
        }

        try await firstHandle.fenceRuntime(from: firstActive, to: restoring)
        if let error = await writeTask.value {
            XCTAssertEqual(error, .bindingChanged)
        }
        let fencedSnapshot = try await firstHandle.snapshot()
        XCTAssertEqual(fencedSnapshot?.runtimeLeaseState, .fenced)

        await assertRepositoryError(.bindingChanged) {
            _ = try await racingHandle.writeLocal(
                SyncLocalWrite(
                    operation: self.localUpsert(
                        opId: "post-fence",
                        entityId: "post-fence",
                        name: "denied",
                        baseRevision: 0
                    ),
                    localChangedAtMilliseconds: 21
                ),
                for: firstActive
            )
        }
    }

    // MARK: - Fixtures

    private func repository(_ identity: SyncBindingIdentity) throws -> SQLiteSyncRepository {
        try SQLiteSyncRepository(
            databaseURL: databaseURL(for: identity),
            identity: identity,
            keyStore: keyStore
        )
    }

    private func databaseURL(for identity: SyncBindingIdentity) -> URL {
        SQLiteSyncRepository.bindingDatabaseURL(in: directory, identity: identity)
    }

    private func createLegacyDatabase(at url: URL, identity: SyncBindingIdentity) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        var handle: OpaquePointer?
        let openCode = sqlite3_open_v2(
            url.path,
            &handle,
            SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX,
            nil
        )
        guard openCode == SQLITE_OK, let handle else {
            throw SQLiteSyncRepositoryError.database(code: openCode, message: "legacy fixture open")
        }
        defer { sqlite3_close_v2(handle) }

        let sql = """
        CREATE TABLE sync_state (
            server_id TEXT NOT NULL,
            account_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            generation TEXT NOT NULL,
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
        INSERT INTO sync_state (
            server_id, account_id, device_id, generation, binding_state
        ) VALUES (
            '\(identity.serverID)', '\(identity.accountID)', '\(identity.deviceID)',
            '\(identity.generation)', 'idle'
        );
        """
        var message: UnsafeMutablePointer<CChar>?
        let code = sqlite3_exec(handle, sql, nil, nil, &message)
        if code != SQLITE_OK {
            let text = message.map { String(cString: $0) } ?? "legacy fixture schema"
            sqlite3_free(message)
            throw SQLiteSyncRepositoryError.database(code: code, message: text)
        }
    }

    private func binding(generation: String = "generation-1") -> SyncBindingIdentity {
        SyncBindingIdentity(
            serverID: "server-1",
            accountID: "user-1",
            deviceID: "device-1",
            generation: generation,
            bindingRecordVersion: leaseVersion(0x11)
        )
    }

    private func leaseVersion(_ byte: UInt8) -> Data {
        Data(repeating: byte, count: SyncBindingIdentity.bindingRecordVersionByteCount)
    }

    private func localUpsert(
        opId: String,
        entityId: String,
        name: String,
        baseRevision: Int64
    ) -> MobileSyncOperation {
        MobileSyncOperation(
            opId: opId,
            entityType: "connection",
            entityId: entityId,
            action: .upsert,
            baseRevision: baseRevision,
            clientModifiedAt: 100,
            fieldMask: ["name"],
            payload: ["name": .string(name)]
        )
    }

    private func change(
        seq: Int64,
        id: String,
        revision: Int64,
        name: String
    ) throws -> MobileSyncChange {
        try decodeChange(
            """
            {"changeSeq":\(seq),"entityType":"connection","entityId":"\(id)",
             "action":"upsert","revision":\(revision),"changedAt":\(seq * 100),
             "payload":{"name":"\(name)","ownerUserId":"user-1"}}
            """
        )
    }

    private func deleteChange(seq: Int64, id: String, revision: Int64) throws -> MobileSyncChange {
        try decodeChange(
            """
            {"changeSeq":\(seq),"entityType":"connection","entityId":"\(id)",
             "action":"delete","revision":\(revision),"changedAt":\(seq * 100),
             "tombstone":{"id":"\(id)","ownerUserId":"user-1"}}
            """
        )
    }

    private func decodeChange(_ json: String) throws -> MobileSyncChange {
        try JSONDecoder().decode(MobileSyncChange.self, from: Data(json.utf8))
    }

    private func changesPage(
        from: Int64,
        next: Int64,
        changes: [MobileSyncChange]
    ) -> MobileChangesResponse {
        MobileChangesResponse(ok: true, fromCursor: from, nextCursor: next, hasMore: false, changes: changes)
    }

    private func assertRepositoryError(
        _ expected: SQLiteSyncRepositoryError,
        operation: () async throws -> Void,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            try await operation()
            XCTFail("Expected \(expected)", file: file, line: line)
        } catch let error as SQLiteSyncRepositoryError {
            XCTAssertEqual(error, expected, file: file, line: line)
        } catch {
            XCTFail("Unexpected error \(error)", file: file, line: line)
        }
    }
}

private enum MigrationInterruption: Error, Equatable {
    case simulatedCrash
}

private enum MemoryDatabaseKeyStoreError: Error, Equatable {
    case injectedDeleteFailure
}

private final class MemorySyncDatabaseKeyStore: SyncDatabaseKeyStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var keys: [String: Data] = [:]
    private var generation: UInt8 = 1
    private var deletionFailuresRemaining = 0

    func loadKey(for scope: SyncDatabaseKeyScope) throws -> Data? {
        synchronized { keys[identifier(scope)] }
    }

    func loadOrCreateKey(for scope: SyncDatabaseKeyScope) throws -> Data {
        synchronized {
            let id = identifier(scope)
            if let key = keys[id] { return key }
            let key = Data(repeating: generation, count: KeychainSyncDatabaseKeyStore.keyByteCount)
            generation &+= 1
            keys[id] = key
            return key
        }
    }

    func deleteKey(for scope: SyncDatabaseKeyScope) throws {
        try synchronized {
            if deletionFailuresRemaining > 0 {
                deletionFailuresRemaining -= 1
                throw MemoryDatabaseKeyStoreError.injectedDeleteFailure
            }
            keys.removeValue(forKey: identifier(scope))
        }
    }

    func key(for scope: SyncDatabaseKeyScope) -> Data? {
        synchronized { keys[identifier(scope)] }
    }

    func set(_ key: Data, for scope: SyncDatabaseKeyScope) throws {
        synchronized { keys[identifier(scope)] = key }
    }

    func failNextDeletion() {
        synchronized { deletionFailuresRemaining += 1 }
    }

    private func identifier(_ scope: SyncDatabaseKeyScope) -> String {
        [scope.serverID, scope.accountID, scope.deviceID, scope.generation]
            .joined(separator: "\u{0}")
    }

    private func synchronized<T>(_ operation: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try operation()
    }
}
