import CryptoKit
import Darwin
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

    func testNewEncryptedDatabasePassesIntegrityAfterInitialization() async throws {
        let identity = binding()
        var store: SQLiteSyncRepository? = try repository(identity)
        let initialized = try await store?.snapshot()
        XCTAssertEqual(initialized?.identity, identity)
        store = nil

        let reopened = try SQLiteSyncRepository(
            databaseURL: databaseURL(for: identity),
            identity: identity,
            requireExistingBinding: true,
            keyStore: keyStore
        )
        let reopenedSnapshot = try await reopened.snapshot()
        XCTAssertEqual(reopenedSnapshot?.identity, identity)
    }

    #if os(macOS)
    func testMacOSTemporaryDirectoryDatabaseCanBeCreatedAndReopenedExistingOnly() async throws {
        let temporaryRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("zephyr-sqlite-cantopen-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: temporaryRoot) }

        let identity = binding(generation: "macos-temporary-directory")
        let url = SQLiteSyncRepository.bindingDatabaseURL(in: temporaryRoot, identity: identity)
        var created: SQLiteSyncRepository? = try SQLiteSyncRepository(
            databaseURL: url,
            identity: identity,
            keyStore: keyStore
        )
        let createdSnapshot = try await created?.snapshot()
        XCTAssertEqual(createdSnapshot?.identity, identity)
        created = nil

        let reopened = try SQLiteSyncRepository(
            databaseURL: url,
            identity: identity,
            requireExistingBinding: true,
            keyStore: keyStore
        )
        let reopenedSnapshot = try await reopened.snapshot()
        XCTAssertEqual(reopenedSnapshot?.identity, identity)
    }
    #endif

    func testUnsafePreexistingDatabaseArtifactsFailClosedWithoutChangingKeyOrFiles() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let unsafeArtifact = SQLiteSyncRepositoryError.databaseIntegrityFailed(
            "unsafe_database_artifact"
        )

        let zeroIdentity = binding(generation: "zero-main")
        let zeroURL = databaseURL(for: zeroIdentity)
        let zeroKey = Data(repeating: 0x31, count: KeychainSyncDatabaseKeyStore.keyByteCount)
        try keyStore.set(zeroKey, for: SyncDatabaseKeyScope(identity: zeroIdentity))
        try Data().write(to: zeroURL)
        XCTAssertThrowsError(try repository(zeroIdentity)) { error in
            XCTAssertEqual(error as? SQLiteSyncRepositoryError, unsafeArtifact)
        }
        XCTAssertEqual(keyStore.key(for: try SyncDatabaseKeyScope(identity: zeroIdentity)), zeroKey)
        XCTAssertEqual(try Data(contentsOf: zeroURL), Data())

        let sidecarIdentity = binding(generation: "sidecar-only")
        let sidecarURL = databaseURL(for: sidecarIdentity)
        let sidecarKey = Data(repeating: 0x32, count: KeychainSyncDatabaseKeyStore.keyByteCount)
        let orphanWAL = URL(fileURLWithPath: sidecarURL.path + "-wal")
        try keyStore.set(sidecarKey, for: SyncDatabaseKeyScope(identity: sidecarIdentity))
        try Data([0xA5]).write(to: orphanWAL)
        XCTAssertThrowsError(try repository(sidecarIdentity)) { error in
            XCTAssertEqual(error as? SQLiteSyncRepositoryError, unsafeArtifact)
        }
        XCTAssertEqual(
            keyStore.key(for: try SyncDatabaseKeyScope(identity: sidecarIdentity)),
            sidecarKey
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: sidecarURL.path))
        XCTAssertEqual(try Data(contentsOf: orphanWAL), Data([0xA5]))

        let symlinkIdentity = binding(generation: "symlink-main")
        let symlinkURL = databaseURL(for: symlinkIdentity)
        let symlinkKey = Data(repeating: 0x33, count: KeychainSyncDatabaseKeyStore.keyByteCount)
        let symlinkTarget = directory.appendingPathComponent("symlink-target")
        try Data([0x5A]).write(to: symlinkTarget)
        try FileManager.default.createSymbolicLink(
            atPath: symlinkURL.path,
            withDestinationPath: symlinkTarget.path
        )
        try keyStore.set(symlinkKey, for: SyncDatabaseKeyScope(identity: symlinkIdentity))
        XCTAssertThrowsError(try repository(symlinkIdentity)) { error in
            XCTAssertEqual(error as? SQLiteSyncRepositoryError, unsafeArtifact)
        }
        XCTAssertEqual(
            keyStore.key(for: try SyncDatabaseKeyScope(identity: symlinkIdentity)),
            symlinkKey
        )
        XCTAssertEqual(try Data(contentsOf: symlinkTarget), Data([0x5A]))
        XCTAssertEqual(
            try FileManager.default.destinationOfSymbolicLink(atPath: symlinkURL.path),
            symlinkTarget.path
        )

        let danglingIdentity = binding(generation: "dangling-main")
        let danglingURL = databaseURL(for: danglingIdentity)
        let danglingKey = Data(repeating: 0x34, count: KeychainSyncDatabaseKeyStore.keyByteCount)
        let missingTarget = directory.appendingPathComponent("missing-target")
        try FileManager.default.createSymbolicLink(
            atPath: danglingURL.path,
            withDestinationPath: missingTarget.path
        )
        try keyStore.set(danglingKey, for: SyncDatabaseKeyScope(identity: danglingIdentity))
        XCTAssertThrowsError(try repository(danglingIdentity)) { error in
            XCTAssertEqual(error as? SQLiteSyncRepositoryError, unsafeArtifact)
        }
        XCTAssertEqual(
            keyStore.key(for: try SyncDatabaseKeyScope(identity: danglingIdentity)),
            danglingKey
        )
        XCTAssertEqual(
            try FileManager.default.destinationOfSymbolicLink(atPath: danglingURL.path),
            missingTarget.path
        )

        let sidecarSymlinkIdentity = binding(generation: "symlink-sidecar")
        let sidecarSymlinkURL = databaseURL(for: sidecarSymlinkIdentity)
        var initialized: SQLiteSyncRepository? = try repository(sidecarSymlinkIdentity)
        initialized = nil
        let initializedMain = try Data(contentsOf: sidecarSymlinkURL)
        let initializedKey = keyStore.key(
            for: try SyncDatabaseKeyScope(identity: sidecarSymlinkIdentity)
        )
        let sidecarTarget = directory.appendingPathComponent("sidecar-symlink-target")
        try Data([0xA6]).write(to: sidecarTarget)
        let linkedWAL = sidecarSymlinkURL.path + "-wal"
        if FileManager.default.fileExists(atPath: linkedWAL) {
            try FileManager.default.removeItem(atPath: linkedWAL)
        }
        try FileManager.default.createSymbolicLink(
            atPath: linkedWAL,
            withDestinationPath: sidecarTarget.path
        )

        XCTAssertThrowsError(try repository(sidecarSymlinkIdentity)) { error in
            XCTAssertEqual(error as? SQLiteSyncRepositoryError, unsafeArtifact)
        }
        XCTAssertEqual(try Data(contentsOf: sidecarSymlinkURL), initializedMain)
        XCTAssertEqual(
            keyStore.key(for: try SyncDatabaseKeyScope(identity: sidecarSymlinkIdentity)),
            initializedKey
        )
        XCTAssertEqual(try Data(contentsOf: sidecarTarget), Data([0xA6]))
        XCTAssertEqual(
            try FileManager.default.destinationOfSymbolicLink(atPath: linkedWAL),
            sidecarTarget.path
        )
    }

    func testDatabaseDirectorySymlinkFailsClosedBeforeCreatingAKey() throws {
        let realDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("zephyr-sync-real-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: realDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: realDirectory) }
        try FileManager.default.createSymbolicLink(
            atPath: directory.path,
            withDestinationPath: realDirectory.path
        )
        defer { try? FileManager.default.removeItem(at: directory) }

        let identity = binding(generation: "symlink-directory")
        let scope = try SyncDatabaseKeyScope(identity: identity)
        XCTAssertThrowsError(try repository(identity)) { error in
            XCTAssertEqual(
                error as? SQLiteSyncRepositoryError,
                .databaseIntegrityFailed("unsafe_database_directory")
            )
        }
        XCTAssertNil(keyStore.key(for: scope))
        XCTAssertFalse(FileManager.default.fileExists(atPath: databaseURL(for: identity).path))
    }

    func testIntermediateDatabaseDirectorySymlinkCannotEscapeBeforeCreatingAKey() throws {
        let trustedRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("zephyr-sync-trusted-\(UUID().uuidString)", isDirectory: true)
        let outsideRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("zephyr-sync-outside-\(UUID().uuidString)", isDirectory: true)
        let outsideNested = outsideRoot.appendingPathComponent("nested", isDirectory: true)
        try FileManager.default.createDirectory(at: trustedRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outsideRoot, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: trustedRoot)
            try? FileManager.default.removeItem(at: outsideRoot)
        }
        let escape = trustedRoot.appendingPathComponent("escape", isDirectory: true)
        try FileManager.default.createSymbolicLink(
            atPath: escape.path,
            withDestinationPath: outsideRoot.path
        )

        let identity = binding(generation: "intermediate-symlink-directory")
        let scope = try SyncDatabaseKeyScope(identity: identity)
        let hostileDirectory = escape.appendingPathComponent("nested", isDirectory: true)
        let url = SQLiteSyncRepository.bindingDatabaseURL(in: hostileDirectory, identity: identity)
        XCTAssertThrowsError(
            try SQLiteSyncRepository(databaseURL: url, identity: identity, keyStore: keyStore)
        ) { error in
            XCTAssertEqual(
                error as? SQLiteSyncRepositoryError,
                .databaseIntegrityFailed("unsafe_database_directory")
            )
        }
        XCTAssertNil(keyStore.key(for: scope))
        XCTAssertFalse(FileManager.default.fileExists(atPath: outsideNested.path))
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: SQLiteSyncRepository.bindingDatabaseURL(
                    in: outsideNested,
                    identity: identity
                ).path
            )
        )
    }

    func testParentTraversalFailsBeforeCreatingOutsideDirectoryOrKey() throws {
        let trustedRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("zephyr-sync-traversal-\(UUID().uuidString)", isDirectory: true)
        let outsideName = "zephyr-sync-traversal-outside-\(UUID().uuidString)"
        let outsideRoot = trustedRoot.deletingLastPathComponent()
            .appendingPathComponent(outsideName, isDirectory: true)
        let outsideNested = outsideRoot.appendingPathComponent("nested", isDirectory: true)
        try FileManager.default.createDirectory(at: trustedRoot, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: trustedRoot)
            try? FileManager.default.removeItem(at: outsideRoot)
        }

        let identity = binding(generation: "parent-traversal")
        let scope = try SyncDatabaseKeyScope(identity: identity)
        let rawDirectoryPath = trustedRoot.path + "/../" + outsideName + "/nested"
        let rawDatabasePath = rawDirectoryPath + "/sync-parent-traversal.sqlite3"
        let url = URL(fileURLWithPath: rawDatabasePath, isDirectory: false)
        XCTAssertNotEqual(url.path, url.standardizedFileURL.path)
        XCTAssertThrowsError(
            try SQLiteSyncRepository(databaseURL: url, identity: identity, keyStore: keyStore)
        ) { error in
            XCTAssertEqual(
                error as? SQLiteSyncRepositoryError,
                .databaseIntegrityFailed("unsafe_database_directory")
            )
        }
        XCTAssertNil(keyStore.key(for: scope))
        XCTAssertFalse(FileManager.default.fileExists(atPath: outsideNested.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: rawDatabasePath))
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
        XCTAssertNil(keyStore.key(for: scope))
    }

    func testPurgeRejectsDirectoryReplacementSidecarWithoutRecursingOrDeletingKey() async throws {
        let identity = binding(generation: "purge-directory-sidecar")
        let store = try repository(identity)
        let url = databaseURL(for: identity)
        let scope = try SyncDatabaseKeyScope(identity: identity)
        let sidecarDirectory = URL(fileURLWithPath: url.path + "-wal", isDirectory: true)
        let sentinel = sidecarDirectory.appendingPathComponent("must-survive")
        try FileManager.default.createDirectory(at: sidecarDirectory, withIntermediateDirectories: false)
        try Data("purge sentinel".utf8).write(to: sentinel)

        await assertRepositoryError(.databaseIntegrityFailed("database_artifact_removal")) {
            try await store.purgeAll(for: identity)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        XCTAssertEqual(try Data(contentsOf: sentinel), Data("purge sentinel".utf8))
        XCTAssertNotNil(keyStore.key(for: scope))
    }

    func testCleanupFallbackRejectsDirectoryReplacementSidecarWithoutRecursingOrDeletingKey() throws {
        let identity = binding(generation: "fallback-directory-sidecar")
        let url = databaseURL(for: identity)
        let scope = try SyncDatabaseKeyScope(identity: identity)
        var initialized: SQLiteSyncRepository? = try repository(identity)
        initialized = nil
        let sidecarDirectory = URL(fileURLWithPath: url.path + "-wal", isDirectory: true)
        let sentinel = sidecarDirectory.appendingPathComponent("must-survive")
        try FileManager.default.createDirectory(at: sidecarDirectory, withIntermediateDirectories: false)
        try Data("fallback sentinel".utf8).write(to: sentinel)

        XCTAssertThrowsError(
            try SQLiteSyncRepository.eraseEncryptedStorageForCleanup(
                at: url,
                legacyDatabaseURL: nil,
                identity: identity,
                keyStore: keyStore
            )
        ) { error in
            XCTAssertEqual(
                error as? SQLiteSyncRepositoryError,
                .databaseIntegrityFailed("database_artifact_removal")
            )
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        XCTAssertEqual(try Data(contentsOf: sentinel), Data("fallback sentinel".utf8))
        XCTAssertNotNil(keyStore.key(for: scope))
    }

    func testEncryptedDatabaseSecondPageTamperingFailsCipherIntegrityCheck() async throws {
        let identity = binding()
        do {
            let store = try repository(identity)
            _ = try await store.snapshot()
        }

        let url = databaseURL(for: identity)
        var encrypted = try Data(contentsOf: url)
        // SQLCipher 4's pinned default is a 4096-byte page with its HMAC at
        // the end. Page 1 holds sqlite_master and is read before the explicit
        // integrity PRAGMA; corrupt page 2 so this regression specifically
        // proves the complete file scan remains mandatory for disk databases.
        let secondPageLastByte = (4096 * 2) - 1
        XCTAssertGreaterThan(encrypted.count, secondPageLastByte)
        encrypted[secondPageLastByte] ^= 0x01
        try encrypted.write(to: url, options: .atomic)

        XCTAssertThrowsError(
            try SQLiteSyncRepository(
                databaseURL: url,
                identity: identity,
                keyStore: keyStore
            )
        ) { error in
            XCTAssertEqual(
                error as? SQLiteSyncRepositoryError,
                .databaseIntegrityFailed("cipher_integrity_check")
            )
        }
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
        XCTAssertEqual(migratedSnapshot?.bindingState, .idle)
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyURL.path))
        XCTAssertNotEqual(
            Data(try Data(contentsOf: targetURL).prefix(16)),
            Data("SQLite format 3\u{0}".utf8)
        )
    }

    func testLegacyMigrationRefusesToOverwritePreexistingStaging() throws {
        let identity = binding(generation: "preexisting-migration-staging")
        let legacyURL = SQLiteSyncRepository.legacyAccountDatabaseURL(
            in: directory,
            serverID: identity.serverID,
            accountID: identity.accountID
        )
        let targetURL = databaseURL(for: identity)
        let stagingURL = URL(fileURLWithPath: targetURL.path + ".migrating")
        let sentinel = Data("unowned staging must survive".utf8)
        try createLegacyDatabase(at: legacyURL, identity: identity)
        try sentinel.write(to: stagingURL)

        XCTAssertThrowsError(
            try SQLiteSyncRepository(
                databaseURL: targetURL,
                identity: identity,
                keyStore: keyStore,
                legacyDatabaseURL: legacyURL
            )
        ) { error in
            XCTAssertEqual(
                error as? SQLiteSyncRepositoryError,
                .databaseIntegrityFailed("migration_staging_create")
            )
        }

        XCTAssertEqual(try Data(contentsOf: stagingURL), sentinel)
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacyURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: targetURL.path))
    }

    func testLegacyMigrationFailsClosedForCrashReservedZeroByteStagingWithoutCreatingKey() throws {
        let identity = binding(generation: "crash-reserved-zero-byte-staging")
        let legacyURL = SQLiteSyncRepository.legacyAccountDatabaseURL(
            in: directory,
            serverID: identity.serverID,
            accountID: identity.accountID
        )
        let targetURL = databaseURL(for: identity)
        let stagingURL = URL(fileURLWithPath: targetURL.path + ".migrating")
        let scope = try SyncDatabaseKeyScope(identity: identity)
        try createLegacyDatabase(at: legacyURL, identity: identity)
        FileManager.default.createFile(atPath: stagingURL.path, contents: Data())

        XCTAssertThrowsError(
            try SQLiteSyncRepository(
                databaseURL: targetURL,
                identity: identity,
                keyStore: keyStore,
                legacyDatabaseURL: legacyURL
            )
        ) { error in
            XCTAssertEqual(
                error as? SQLiteSyncRepositoryError,
                .databaseIntegrityFailed("migration_staging_create")
            )
        }

        XCTAssertEqual(try Data(contentsOf: stagingURL), Data())
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacyURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: targetURL.path))
        XCTAssertNil(keyStore.key(for: scope))
    }

    func testLegacyMigrationCrashExportedOwnedStagingRecoversAndRebuilds() async throws {
        let identity = binding(generation: "crash-exported-owned-staging")
        let legacyURL = SQLiteSyncRepository.legacyAccountDatabaseURL(
            in: directory,
            serverID: identity.serverID,
            accountID: identity.accountID
        )
        let targetURL = databaseURL(for: identity)
        let stagingURL = URL(fileURLWithPath: targetURL.path + ".migrating")
        let scope = try SyncDatabaseKeyScope(identity: identity)
        try createLegacyDatabase(at: legacyURL, identity: identity)
        let crashKey = try keyStore.loadOrCreateKey(for: scope)
        try await createOwnedEncryptedMigrationStaging(
            at: stagingURL,
            identity: identity,
            key: crashKey
        )
        XCTAssertTrue(FileManager.default.fileExists(atPath: stagingURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacyURL.path))

        let recovered = try SQLiteSyncRepository(
            databaseURL: targetURL,
            identity: identity,
            keyStore: keyStore,
            legacyDatabaseURL: legacyURL
        )
        let recoveredSnapshot = try await recovered.snapshot()
        XCTAssertEqual(recoveredSnapshot?.identity, identity)
        XCTAssertTrue(FileManager.default.fileExists(atPath: targetURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: stagingURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyURL.path))
        XCTAssertEqual(keyStore.key(for: scope), crashKey)
    }

    func testLegacyMigrationRejectsExportedStagingForDifferentOwnerAndPreservesExistingKey() async throws {
        let identity = binding(generation: "crash-exported-wrong-owner")
        let other = SyncBindingIdentity(
            serverID: identity.serverID,
            accountID: "other-account",
            deviceID: "other-device",
            generation: "crash-exported-other-owner",
            bindingRecordVersion: identity.bindingRecordVersion
        )
        let legacyURL = SQLiteSyncRepository.legacyAccountDatabaseURL(
            in: directory,
            serverID: identity.serverID,
            accountID: identity.accountID
        )
        let targetURL = databaseURL(for: identity)
        let stagingURL = URL(fileURLWithPath: targetURL.path + ".migrating")
        let scope = try SyncDatabaseKeyScope(identity: identity)
        try createLegacyDatabase(at: legacyURL, identity: identity)
        let existingKey = Data(repeating: 0x5a, count: KeychainSyncDatabaseKeyStore.keyByteCount)
        try keyStore.set(existingKey, for: scope)
        try keyStore.set(existingKey, for: try SyncDatabaseKeyScope(identity: other))
        try await createOwnedEncryptedMigrationStaging(
            at: stagingURL,
            identity: other,
            key: existingKey
        )

        XCTAssertThrowsError(
            try SQLiteSyncRepository(
                databaseURL: targetURL,
                identity: identity,
                keyStore: keyStore,
                legacyDatabaseURL: legacyURL
            )
        )
        XCTAssertTrue(FileManager.default.fileExists(atPath: stagingURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacyURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: targetURL.path))
        XCTAssertEqual(keyStore.key(for: scope), existingKey)
    }

    func testStagingRecoveryRevalidatesLegacyBeforeDiscardingOwnedExport() async throws {
        let identity = binding(generation: "crash-revalidate-legacy")
        let legacyURL = SQLiteSyncRepository.legacyAccountDatabaseURL(
            in: directory,
            serverID: identity.serverID,
            accountID: identity.accountID
        )
        let targetURL = databaseURL(for: identity)
        let stagingURL = URL(fileURLWithPath: targetURL.path + ".migrating")
        let scope = try SyncDatabaseKeyScope(identity: identity)
        try createLegacyDatabase(at: legacyURL, identity: identity)
        let crashKey = try keyStore.loadOrCreateKey(for: scope)
        try await createOwnedEncryptedMigrationStaging(
            at: stagingURL,
            identity: identity,
            key: crashKey
        )
        try replaceLegacyOwner(at: legacyURL, with: binding(generation: "replaced-legacy-owner"))

        XCTAssertThrowsError(
            try SQLiteSyncRepository(
                databaseURL: targetURL,
                identity: identity,
                keyStore: keyStore,
                legacyDatabaseURL: legacyURL
            )
        ) { error in
            XCTAssertEqual(error as? SQLiteSyncRepositoryError, .legacyOwnerMismatch)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: stagingURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacyURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: targetURL.path))
        XCTAssertEqual(keyStore.key(for: scope), crashKey)
    }

    func testMigrationFailurePreservesNestedStagingArtifactsAndSentinelDirectory() throws {
        let identity = binding(generation: "nested-staging-artifacts")
        let legacyURL = SQLiteSyncRepository.legacyAccountDatabaseURL(
            in: directory,
            serverID: identity.serverID,
            accountID: identity.accountID
        )
        let targetURL = databaseURL(for: identity)
        let stagingURL = URL(fileURLWithPath: targetURL.path + ".migrating")
        let nested = [".migrating", ".migrating-wal", ".migrating-shm", ".migrating-journal"]
            .map { URL(fileURLWithPath: stagingURL.path + $0) }
        let sentinelDirectory = nested[0]
        try createLegacyDatabase(at: legacyURL, identity: identity)
        let sentinel = sentinelDirectory.appendingPathComponent("must-survive")

        XCTAssertThrowsError(
            try SQLiteSyncRepository(
                databaseURL: targetURL,
                identity: identity,
                keyStore: keyStore,
                legacyDatabaseURL: legacyURL,
                migrationHooks: SQLiteSyncMigrationHooks { stage in
                    guard stage == .encryptedCopyReady else { return }
                    try FileManager.default.createDirectory(
                        at: sentinelDirectory,
                        withIntermediateDirectories: false
                    )
                    try Data("sentinel".utf8).write(to: sentinel)
                    for artifact in nested.dropFirst() {
                        try Data(artifact.lastPathComponent.utf8).write(to: artifact)
                    }
                    throw MigrationInterruption.leaveNestedArtifacts
                }
            )
        ) { error in
            XCTAssertEqual(error as? MigrationInterruption, .leaveNestedArtifacts)
        }
        XCTAssertEqual(try Data(contentsOf: sentinel), Data("sentinel".utf8))
        for artifact in nested.dropFirst() {
            XCTAssertTrue(FileManager.default.fileExists(atPath: artifact.path))
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacyURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: targetURL.path))
    }

    func testExistingTargetRecoversOwnedCrashStagingBeforeOpening() async throws {
        let identity = binding(generation: "target-with-owned-crash-staging")
        let targetURL = databaseURL(for: identity)
        let stagingURL = URL(fileURLWithPath: targetURL.path + ".migrating")
        let scope = try SyncDatabaseKeyScope(identity: identity)
        let target = try repository(identity)
        let durableKey = try XCTUnwrap(keyStore.key(for: scope))
        try await createOwnedEncryptedMigrationStaging(
            at: stagingURL,
            identity: identity,
            key: durableKey
        )
        for suffix in ["-wal", "-shm", "-journal"] {
            try Data(suffix.utf8).write(to: URL(fileURLWithPath: stagingURL.path + suffix))
        }

        let reopened = try repository(identity)
        let targetSnapshot = try await target.snapshot()
        let reopenedSnapshot = try await reopened.snapshot()
        XCTAssertEqual(targetSnapshot?.identity, identity)
        XCTAssertEqual(reopenedSnapshot?.identity, identity)
        for suffix in ["", "-wal", "-shm", "-journal"] {
            XCTAssertFalse(FileManager.default.fileExists(atPath: stagingURL.path + suffix))
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: targetURL.path))
        XCTAssertEqual(keyStore.key(for: scope), durableKey)
    }

    func testExistingTargetRejectsUnownedCrashStagingWithoutTouchingTargetOrKey() throws {
        let identity = binding(generation: "target-with-unowned-crash-staging")
        let targetURL = databaseURL(for: identity)
        let stagingURL = URL(fileURLWithPath: targetURL.path + ".migrating")
        let scope = try SyncDatabaseKeyScope(identity: identity)
        var initialized: SQLiteSyncRepository? = try repository(identity)
        initialized = nil
        let targetBytes = try Data(contentsOf: targetURL)
        let durableKey = try XCTUnwrap(keyStore.key(for: scope))
        let sentinel = Data("unowned existing-target staging".utf8)
        try sentinel.write(to: stagingURL)

        XCTAssertThrowsError(try repository(identity)) { error in
            XCTAssertEqual(
                error as? SQLiteSyncRepositoryError,
                .databaseIntegrityFailed("migration_staging_create")
            )
        }
        XCTAssertEqual(try Data(contentsOf: targetURL), targetBytes)
        XCTAssertEqual(try Data(contentsOf: stagingURL), sentinel)
        XCTAssertEqual(keyStore.key(for: scope), durableKey)
    }

    func testCleanupFallbackErasesOwnedCrashStagingBeforeDeletingKey() async throws {
        let identity = binding(generation: "cleanup-owned-crash-staging")
        let targetURL = databaseURL(for: identity)
        let stagingURL = URL(fileURLWithPath: targetURL.path + ".migrating")
        let scope = try SyncDatabaseKeyScope(identity: identity)
        var target: SQLiteSyncRepository? = try repository(identity)
        _ = try await target?.snapshot()
        target = nil
        let durableKey = try XCTUnwrap(keyStore.key(for: scope))
        try await createOwnedEncryptedMigrationStaging(
            at: stagingURL,
            identity: identity,
            key: durableKey
        )
        for suffix in ["-wal", "-shm", "-journal"] {
            try Data(suffix.utf8).write(to: URL(fileURLWithPath: stagingURL.path + suffix))
        }

        try SQLiteSyncRepository.eraseEncryptedStorageForCleanup(
            at: targetURL,
            legacyDatabaseURL: nil,
            identity: identity,
            keyStore: keyStore
        )

        for suffix in ["", "-wal", "-shm", "-journal"] {
            XCTAssertFalse(FileManager.default.fileExists(atPath: targetURL.path + suffix))
            XCTAssertFalse(FileManager.default.fileExists(atPath: stagingURL.path + suffix))
        }
        XCTAssertNil(keyStore.key(for: scope))
    }

    func testCleanupFallbackRejectsUnownedCrashStagingAndRetainsTargetAndKey() throws {
        let identity = binding(generation: "cleanup-unowned-crash-staging")
        let targetURL = databaseURL(for: identity)
        let stagingURL = URL(fileURLWithPath: targetURL.path + ".migrating")
        let scope = try SyncDatabaseKeyScope(identity: identity)
        var initialized: SQLiteSyncRepository? = try repository(identity)
        initialized = nil
        let targetBytes = try Data(contentsOf: targetURL)
        let durableKey = try XCTUnwrap(keyStore.key(for: scope))
        let sentinel = Data("unowned cleanup staging".utf8)
        try sentinel.write(to: stagingURL)

        XCTAssertThrowsError(
            try SQLiteSyncRepository.eraseEncryptedStorageForCleanup(
                at: targetURL,
                legacyDatabaseURL: nil,
                identity: identity,
                keyStore: keyStore
            )
        ) { error in
            XCTAssertEqual(
                error as? SQLiteSyncRepositoryError,
                .databaseIntegrityFailed("migration_staging_create")
            )
        }
        XCTAssertEqual(try Data(contentsOf: targetURL), targetBytes)
        XCTAssertEqual(try Data(contentsOf: stagingURL), sentinel)
        XCTAssertEqual(keyStore.key(for: scope), durableKey)
    }

    func testLegacyMigrationRefusesOrphanStagingSidecar() throws {
        let identity = binding(generation: "orphan-migration-sidecar")
        let legacyURL = SQLiteSyncRepository.legacyAccountDatabaseURL(
            in: directory,
            serverID: identity.serverID,
            accountID: identity.accountID
        )
        let targetURL = databaseURL(for: identity)
        let stagingURL = URL(fileURLWithPath: targetURL.path + ".migrating")
        let orphanWAL = URL(fileURLWithPath: stagingURL.path + "-wal")
        let sentinel = Data("unowned sidecar must survive".utf8)
        try createLegacyDatabase(at: legacyURL, identity: identity)
        try sentinel.write(to: orphanWAL)

        XCTAssertThrowsError(
            try SQLiteSyncRepository(
                databaseURL: targetURL,
                identity: identity,
                keyStore: keyStore,
                legacyDatabaseURL: legacyURL
            )
        ) { error in
            XCTAssertEqual(
                error as? SQLiteSyncRepositoryError,
                .databaseIntegrityFailed("unsafe_database_artifact")
            )
        }

        XCTAssertEqual(try Data(contentsOf: orphanWAL), sentinel)
        XCTAssertFalse(FileManager.default.fileExists(atPath: stagingURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacyURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: targetURL.path))
    }

    func testLegacyMigrationWritesEncryptedStagingBeforePromotion() throws {
        let identity = binding(generation: "encrypted-migration-staging")
        let legacyURL = SQLiteSyncRepository.legacyAccountDatabaseURL(
            in: directory,
            serverID: identity.serverID,
            accountID: identity.accountID
        )
        let targetURL = databaseURL(for: identity)
        let stagingURL = URL(fileURLWithPath: targetURL.path + ".migrating")
        let plaintextHeader = Data("SQLite format 3\u{0}".utf8)
        try createLegacyDatabase(at: legacyURL, identity: identity)

        XCTAssertThrowsError(
            try SQLiteSyncRepository(
                databaseURL: targetURL,
                identity: identity,
                keyStore: keyStore,
                legacyDatabaseURL: legacyURL,
                migrationHooks: SQLiteSyncMigrationHooks { stage in
                    guard stage == .encryptedCopyReady else { return }
                    let header = Data(try Data(contentsOf: stagingURL).prefix(16))
                    guard header != plaintextHeader else {
                        throw MigrationInterruption.plaintextStaging
                    }
                    throw MigrationInterruption.simulatedCrash
                }
            )
        ) { error in
            XCTAssertEqual(error as? MigrationInterruption, .simulatedCrash)
        }

        XCTAssertTrue(FileManager.default.fileExists(atPath: legacyURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: targetURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: stagingURL.path))
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

    func testCleanupFallbackRejectsSymlinkedTargetParentWithoutDeletingExternalFileOrKey() throws {
        let identity = binding(generation: "cleanup-symlink-parent")
        let scope = try SyncDatabaseKeyScope(identity: identity)
        let trustedRoot = directory.appendingPathComponent("trusted", isDirectory: true)
        let outsideRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("zephyr-cleanup-outside-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: trustedRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outsideRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: outsideRoot) }

        let externalDatabaseURL = outsideRoot.appendingPathComponent("external.sqlite3")
        let externalBytes = Data([0x45, 0x58, 0x54])
        try externalBytes.write(to: externalDatabaseURL)
        let escape = trustedRoot.appendingPathComponent("escape", isDirectory: true)
        try FileManager.default.createSymbolicLink(
            atPath: escape.path,
            withDestinationPath: outsideRoot.path
        )
        let hostileDatabaseURL = escape.appendingPathComponent(
            externalDatabaseURL.lastPathComponent,
            isDirectory: false
        )
        _ = try keyStore.loadOrCreateKey(for: scope)

        XCTAssertThrowsError(
            try SQLiteSyncRepository.eraseEncryptedStorageForCleanup(
                at: hostileDatabaseURL,
                legacyDatabaseURL: nil,
                identity: identity,
                keyStore: keyStore
            )
        ) { error in
            XCTAssertEqual(
                error as? SQLiteSyncRepositoryError,
                .databaseIntegrityFailed("unsafe_database_directory")
            )
        }

        XCTAssertEqual(try Data(contentsOf: externalDatabaseURL), externalBytes)
        XCTAssertNotNil(keyStore.key(for: scope))
    }

    func testCleanupFallbackRejectsLegacyParentTraversalBeforeDeletingTargetOrKey() throws {
        let identity = binding(generation: "cleanup-parent-traversal")
        let scope = try SyncDatabaseKeyScope(identity: identity)
        let targetURL = databaseURL(for: identity)
        var initialized: SQLiteSyncRepository? = try repository(identity)
        initialized = nil
        let targetBytes = try Data(contentsOf: targetURL)

        let outsideRoot = directory.deletingLastPathComponent()
            .appendingPathComponent("zephyr-cleanup-outside-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: outsideRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: outsideRoot) }
        let externalLegacyURL = outsideRoot.appendingPathComponent("legacy.sqlite3")
        try createLegacyDatabase(at: externalLegacyURL, identity: identity)
        let externalLegacyBytes = try Data(contentsOf: externalLegacyURL)
        let rawLegacyPath = directory.path + "/../" + outsideRoot.lastPathComponent
            + "/" + externalLegacyURL.lastPathComponent
        let hostileLegacyURL = URL(fileURLWithPath: rawLegacyPath, isDirectory: false)
        XCTAssertNotEqual(hostileLegacyURL.path, hostileLegacyURL.standardizedFileURL.path)

        XCTAssertThrowsError(
            try SQLiteSyncRepository.eraseEncryptedStorageForCleanup(
                at: targetURL,
                legacyDatabaseURL: hostileLegacyURL,
                identity: identity,
                keyStore: keyStore
            )
        ) { error in
            XCTAssertEqual(
                error as? SQLiteSyncRepositoryError,
                .databaseIntegrityFailed("unsafe_database_directory")
            )
        }

        XCTAssertEqual(try Data(contentsOf: targetURL), targetBytes)
        XCTAssertEqual(try Data(contentsOf: externalLegacyURL), externalLegacyBytes)
        XCTAssertNotNil(keyStore.key(for: scope))
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
            '\(identity.generation)', '\(BindingState.idle.rawValue)'
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

    private func replaceLegacyOwner(at url: URL, with identity: SyncBindingIdentity) throws {
        var handle: OpaquePointer?
        let openCode = sqlite3_open_v2(
            url.path,
            &handle,
            SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX,
            nil
        )
        guard openCode == SQLITE_OK, let handle else {
            throw SQLiteSyncRepositoryError.database(code: openCode, message: "legacy fixture reopen")
        }
        defer { sqlite3_close_v2(handle) }
        let sql = """
        UPDATE sync_state SET server_id = '\(identity.serverID)', account_id = '\(identity.accountID)',
            device_id = '\(identity.deviceID)', generation = '\(identity.generation)';
        """
        var message: UnsafeMutablePointer<CChar>?
        let code = sqlite3_exec(handle, sql, nil, nil, &message)
        if code != SQLITE_OK {
            let text = message.map { String(cString: $0) } ?? "legacy fixture owner replacement"
            sqlite3_free(message)
            throw SQLiteSyncRepositoryError.database(code: code, message: text)
        }
    }

    private func createOwnedEncryptedMigrationStaging(
        at stagingURL: URL,
        identity: SyncBindingIdentity,
        key: Data
    ) async throws {
        // A real interrupted export is an encrypted, owner-bound SQLite file.
        // Build it through the repository, then attach the same durable proof
        // format used by migration before the fixed name becomes observable.
        let stagingRepository = try SQLiteSyncRepository(
            databaseURL: stagingURL,
            identity: identity,
            keyStore: keyStore
        )
        _ = try await stagingRepository.snapshot()
        let descriptor = Darwin.open(stagingURL.path, O_RDWR | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("migration staging fixture open")
        }
        defer { _ = Darwin.close(descriptor) }

        var payload = Data("zephyr-one/sqlcipher-migration-owner/v1\u{0}".utf8)
        for value in [
            try canonicalStagingLocation(stagingURL),
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
        let proof = Data(HMAC<SHA256>.authenticationCode(
            for: payload,
            using: SymmetricKey(data: key)
        ))
        let result = proof.withUnsafeBytes { bytes in
            "com.zephyr.one.sync-migration-owner.v1".withCString { name in
                fsetxattr(descriptor, name, bytes.baseAddress, bytes.count, 0, XATTR_CREATE)
            }
        }
        guard result == 0, Darwin.fsync(descriptor) == 0 else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("migration staging fixture proof")
        }
    }

    private func canonicalStagingLocation(_ stagingURL: URL) throws -> String {
        let parent = stagingURL.deletingLastPathComponent()
        let components = parent.pathComponents
        guard components.count > 1 else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("migration staging fixture path")
        }
        let topLevel = URL(fileURLWithPath: "/", isDirectory: true)
            .appendingPathComponent(components[1], isDirectory: true)
        var status = stat()
        guard lstat(topLevel.path, &status) == 0 else {
            throw SQLiteSyncRepositoryError.databaseIntegrityFailed("migration staging fixture path")
        }
        var canonicalParent = topLevel
        if (status.st_mode & S_IFMT) == S_IFLNK {
            guard status.st_uid == 0 else {
                throw SQLiteSyncRepositoryError.databaseIntegrityFailed("migration staging fixture path")
            }
            canonicalParent = topLevel.resolvingSymlinksInPath()
        }
        for component in components.dropFirst(2) {
            canonicalParent.appendPathComponent(component, isDirectory: true)
        }
        return canonicalParent
            .appendingPathComponent(stagingURL.lastPathComponent, isDirectory: false)
            .path
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
    case plaintextStaging
    case leaveExportedStaging
    case leaveNestedArtifacts
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
