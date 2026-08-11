import Foundation
import XCTest
@testable import ZephyrCore
import ZephyrContracts

final class MobileBindingCoordinatorTests: XCTestCase {
    func testTotpFlowLoadsOnlyOwnerTokenMetadataAndCancellationClearsSession() async throws {
        let harness = try BindingHarness(
            loginResponses: [.totpRequired(tempToken: "temporary-secret")],
            totpResponse: .authenticated(session: BindingFixtures.session)
        )

        let loginStep = try await harness.coordinator.beginLogin(
            username: "andy",
            password: "password-secret"
        )
        XCTAssertEqual(loginStep, .totpRequired)
        let totpStep = try await harness.coordinator.continueTotp(code: "123456")
        XCTAssertEqual(totpStep, .ready(accountID: "user-1", username: "andy"))
        let tokens = try await harness.coordinator.listTokens()
        XCTAssertEqual(tokens, [BindingFixtures.token])
        let tokenRequest = await harness.tokenLoader.lastRequest()
        XCTAssertEqual(tokenRequest?.accountID, "user-1")
        XCTAssertEqual(tokenRequest?.sid, "sid-secret")

        await harness.coordinator.cancelTransientWork()
        do {
            _ = try await harness.coordinator.listTokens()
            XCTFail("Expected the in-memory SID to be cleared")
        } catch let error as MobileBindingCoordinatorError {
            XCTAssertEqual(error, .invalidState)
        }
        let calls = await harness.api.recordedCalls()
        XCTAssertEqual(calls, ["capabilities", "login", "totp"])
    }

    func testInvalidTotpCanRetryWithTheSameEphemeralToken() async throws {
        let harness = try BindingHarness(
            loginResponses: [.totpRequired(tempToken: "temporary-secret")],
            totpResponse: .authenticated(session: BindingFixtures.session),
            totpFailuresBeforeSuccess: 1
        )

        _ = try await harness.coordinator.beginLogin(username: "andy", password: "password-secret")
        do {
            _ = try await harness.coordinator.continueTotp(code: "000000")
            XCTFail("Expected the first TOTP attempt to fail")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "totp_invalid")
        }

        let retry = try await harness.coordinator.continueTotp(code: "123456")
        XCTAssertEqual(retry, .ready(accountID: "user-1", username: "andy"))
        let calls = await harness.api.recordedCalls()
        XCTAssertEqual(calls, ["capabilities", "login", "totp", "totp"])
    }

    func testMustChangePasswordNeverCreatesAuthenticatedBindingState() async throws {
        let harness = try BindingHarness(
            loginResponses: [.mustChangePassword(session: BindingFixtures.session)]
        )

        let step = try await harness.coordinator.beginLogin(
            username: "andy",
            password: "password-secret"
        )

        XCTAssertEqual(step, .passwordChangeRequired)
        do {
            _ = try await harness.coordinator.listTokens()
            XCTFail("Password-change sessions must not expose their SID")
        } catch let error as MobileBindingCoordinatorError {
            XCTAssertEqual(error, .invalidState)
        }
        let calls = await harness.api.recordedCalls()
        XCTAssertEqual(calls, ["capabilities", "login"])
    }

    func testBindVerifiesTargetBeforeBindAndPersistsOnlyKeychainScopedState() async throws {
        let harness = try BindingHarness()
        let runtime = try await harness.bind()

        XCTAssertEqual(runtime.summary.serverID, "server-1")
        XCTAssertEqual(runtime.summary.accountID, "user-1")
        XCTAssertEqual(runtime.summary.deviceID, BindingFixtures.deviceID)
        XCTAssertEqual(runtime.summary.tokenID, "token-1")
        XCTAssertEqual(runtime.summary.boundAtMilliseconds, 1_725_000_000_000)
        let calls = await harness.api.recordedCalls()
        XCTAssertEqual(calls, ["capabilities", "login", "verify.device.bind", "bind"])
        XCTAssertEqual(try harness.credentials.credentials()?.accessCredential, "access-new")
        XCTAssertEqual(try harness.credentials.credentials()?.refreshCredential, "refresh-new")
        XCTAssertEqual(try harness.credentials.credentials()?.sid, "sid-secret")
        XCTAssertEqual(harness.environment.startCount, 1)

        let record = try XCTUnwrap(try harness.recordStore.load())
        let persisted = String(decoding: try JSONEncoder().encode(record.record), as: UTF8.self)
        XCTAssertFalse(persisted.contains("password-secret"))
        XCTAssertFalse(persisted.contains("grant-secret"))
        XCTAssertFalse(persisted.contains("access-new"))
        XCTAssertFalse(persisted.contains("refresh-new"))
        XCTAssertFalse(persisted.contains("sid-secret"))
    }

    func testRestoreRejectsRepositoryGenerationMismatchBeforeRefresh() async throws {
        let harness = try BindingHarness()
        let record = BindingFixtures.record(generation: "generation-1")
        try harness.recordStore.save(record)
        try harness.credentials.storeInitial(BindingFixtures.credentials)
        harness.environment.forcedRepositoryIdentity = SyncBindingIdentity(
            serverID: record.serverID,
            accountID: record.accountID,
            deviceID: record.deviceID,
            generation: "generation-other"
        )

        do {
            _ = try await harness.coordinator.restore()
            XCTFail("Expected the SQLite generation fence to reject restore")
        } catch let error as MobileBindingCoordinatorError {
            XCTAssertEqual(error, .incompleteBinding)
        }
        let calls = await harness.api.recordedCalls()
        XCTAssertTrue(calls.isEmpty)
    }

    func testRestoreRejectsMissingMLKEMIdentityBeforeRefresh() async throws {
        let harness = try BindingHarness()
        let record = BindingFixtures.record()
        try harness.recordStore.save(record)
        try harness.credentials.storeInitial(BindingFixtures.credentials)
        harness.encryption.markMissing()

        do {
            _ = try await harness.coordinator.restore()
            XCTFail("Expected a missing ML-KEM private identity to reject restore")
        } catch let error as MobileBindingCoordinatorError {
            XCTAssertEqual(error, .incompleteBinding)
        }
        let calls = await harness.api.recordedCalls()
        XCTAssertTrue(calls.isEmpty)
    }

    func testRestoreForcesRefreshAndRotatesBothCredentialsBeforeStarting() async throws {
        let harness = try BindingHarness()
        let record = BindingFixtures.record(generation: "generation-1")
        try harness.recordStore.save(record)
        try harness.credentials.storeInitial(BindingFixtures.credentials)

        let restored = try await harness.coordinator.restore()

        let published = try XCTUnwrap(try harness.recordStore.load())
        XCTAssertEqual(restored?.identity, BindingFixtures.runtimeIdentity(published))
        let calls = await harness.api.recordedCalls()
        XCTAssertEqual(calls, ["capabilities", "refresh"])
        XCTAssertEqual(try harness.credentials.credentials()?.accessCredential, "access-refreshed")
        XCTAssertEqual(try harness.credentials.credentials()?.refreshCredential, "refresh-refreshed")
        XCTAssertEqual(harness.environment.startCount, 1)
    }

    func testFenceRuntimeFailureFailsClosedIntoExactCleanup() async throws {
        let harness = try BindingHarness()
        try harness.recordStore.save(BindingFixtures.record())
        try harness.credentials.storeInitial(BindingFixtures.credentials)
        harness.environment.failNextFence()

        let restored = try await harness.coordinator.restore()

        XCTAssertNil(restored)
        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())
        let currentRuntime = await harness.coordinator.currentRuntime()
        let calls = await harness.api.recordedCalls()
        XCTAssertNil(currentRuntime)
        XCTAssertTrue(calls.isEmpty)
    }

    func testPublishRuntimeFailureNeverConstructsOrStartsRuntime() async throws {
        let harness = try BindingHarness()
        try harness.recordStore.save(BindingFixtures.record())
        try harness.credentials.storeInitial(BindingFixtures.credentials)
        harness.environment.failNextPublish()

        let restored = try await harness.coordinator.restore()

        XCTAssertNil(restored)
        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())
        XCTAssertEqual(harness.environment.startCount, 0)
        let calls = await harness.api.recordedCalls()
        XCTAssertEqual(calls, ["capabilities", "refresh"])
    }

    func testSameGenerationStaleRuntimeCannotCommitInFlightResponseAfterRestorePublishes() async throws {
        let harness = try BindingHarness()
        let staleRuntime = try await harness.bind()
        let changesGate = StartGate()
        await harness.api.setChangesGate(changesGate)

        let staleRequest = Task { await staleRuntime.trigger(.backgroundTask) }
        await changesGate.waitUntilSuspended()
        let winningRuntime = try await harness.makeCoordinator().restore()
        XCTAssertNotNil(winningRuntime)
        XCTAssertNotEqual(winningRuntime?.identity, staleRuntime.identity)
        XCTAssertTrue(winningRuntime?.identity.hasSameBindingGeneration(as: staleRuntime.identity) == true)

        await changesGate.release()
        let staleResult = await staleRequest.value
        let laterResult = await staleRuntime.trigger(.foreground)
        XCTAssertEqual(staleResult, .failed)
        XCTAssertEqual(laterResult, .staleBinding)
    }

    func testRestoreAcquiresRestoringCASBeforePreparingAnySideEffect() async throws {
        let harness = try BindingHarness()
        let record = BindingFixtures.record()
        try harness.recordStore.save(record)
        try harness.credentials.storeInitial(BindingFixtures.credentials)
        harness.recordStore.failNextSave()

        do {
            _ = try await harness.coordinator.restore()
            XCTFail("The restore lease CAS must fail closed")
        } catch MobileBindingRecordStoreError.corruptRecord {}

        XCTAssertEqual(harness.environment.prepareCount, 0)
        XCTAssertEqual(try harness.recordStore.load()?.record, record)
        XCTAssertEqual(try harness.credentials.credentials(), BindingFixtures.credentials)
        let calls = await harness.api.recordedCalls()
        XCTAssertTrue(calls.isEmpty)
    }

    func testRestoreProcessKillAfterRestoringMarkerResumesCleanupOnly() async throws {
        let recorder = CleanupRecorder()
        let harness = try BindingHarness(cleanupRecorder: recorder)
        let record = BindingFixtures.record()
        try harness.recordStore.save(record)
        let active = try XCTUnwrap(try harness.recordStore.load())
        let activeLease = try GenerationSideEffectLease(snapshot: active)
        try harness.credentials.activateLease(activeLease)
        try harness.credentials.storeInitial(BindingFixtures.credentials, for: activeLease)
        XCTAssertNotNil(try harness.recordStore.replace(
            record.replacingPhase(.restoring),
            expected: active
        ))

        let restarted = harness.makeCoordinator()
        let restored = try await restarted.restore()

        XCTAssertNil(restored)
        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())
        XCTAssertFalse(harness.signing.hasKey)
        XCTAssertTrue(harness.encryption.deleted)
        let calls = await harness.api.recordedCalls()
        XCTAssertTrue(calls.isEmpty)
    }

    func testRestoreProcessKillAfterActiveCASCannotPublishStaleLease() async throws {
        let harness = try BindingHarness()
        let record = BindingFixtures.record()
        try harness.recordStore.save(record)
        let firstActive = try XCTUnwrap(try harness.recordStore.load())
        let restoring = try XCTUnwrap(try harness.recordStore.replace(
            record.replacingPhase(.restoring),
            expected: firstActive
        ))
        let restoringLease = try GenerationSideEffectLease(snapshot: restoring)
        try harness.credentials.activateLease(restoringLease)
        try harness.credentials.storeInitial(BindingFixtures.credentials, for: restoringLease)
        XCTAssertNotNil(try harness.recordStore.replace(record, expected: restoring))

        let restarted = harness.makeCoordinator()
        do {
            _ = try await restarted.restore()
            XCTFail("The stale pre-crash lease must never publish a runtime")
        } catch KeychainCredentialStoreError.staleLease {}

        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())
        let currentRuntime = await restarted.currentRuntime()
        XCTAssertNil(currentRuntime)
        let calls = await harness.api.recordedCalls()
        XCTAssertTrue(calls.isEmpty)
    }

    func testRestoreLeaseOwnerLossCannotPublishOrPurgeWinner() async throws {
        let harness = try BindingHarness()
        let record = BindingFixtures.record(generation: "generation-a")
        try harness.recordStore.save(record)
        let activeSnapshot = try XCTUnwrap(try harness.recordStore.load())
        let activeLease = try GenerationSideEffectLease(snapshot: activeSnapshot)
        try harness.credentials.activateLease(activeLease)
        try harness.credentials.storeInitial(BindingFixtures.credentials, for: activeLease)
        let winner = BindingFixtures.record(generation: "generation-b")
        harness.recordStore.loseNextReplace(to: .active, installing: winner)

        do {
            _ = try await harness.coordinator.restore()
            XCTFail("A stale restore owner must not publish")
        } catch let error as MobileBindingCoordinatorError {
            XCTAssertEqual(error, .identityMismatch)
        }

        XCTAssertEqual(try harness.recordStore.load()?.record, winner)
        XCTAssertEqual(harness.environment.repositoryPurgeAttemptCount, 0)
        XCTAssertTrue(harness.signing.hasKey)
        XCTAssertFalse(harness.encryption.deleted)
        let currentRuntime = await harness.coordinator.currentRuntime()
        XCTAssertNil(currentRuntime)
    }

    func testRestoreErasesInterruptedBindingGenerationBeforeAllowingRetry() async throws {
        let recorder = CleanupRecorder()
        let harness = try BindingHarness(cleanupRecorder: recorder)
        let record = BindingFixtures.record(phase: .binding)
        try harness.recordStore.save(record)
        try harness.credentials.storeInitial(BindingFixtures.credentials)

        let restored = try await harness.coordinator.restore()

        XCTAssertNil(restored)
        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())
        XCTAssertTrue(recorder.values().contains("repository"))
        XCTAssertTrue(recorder.values().contains("signing"))
        XCTAssertTrue(recorder.values().contains("encryption"))
    }

    func testRuntimeConstructionFailureErasesPartialRepositoryBeforeIdentityMaterial() async throws {
        let recorder = CleanupRecorder()
        let harness = try BindingHarness(cleanupRecorder: recorder)
        harness.environment.failNextRuntimeCreation()

        do {
            _ = try await harness.bind()
            XCTFail("Expected runtime construction to fail")
        } catch let error as FakeRuntimeCreationError {
            XCTAssertEqual(error, .failed)
        }

        XCTAssertEqual(
            recorder.values(),
            ["credentials", "repository", "signing", "encryption", "record"]
        )
        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())
        XCTAssertFalse(harness.signing.hasKey)
        XCTAssertTrue(harness.encryption.deleted)
    }

    func testLogoutTombstonesCredentialsBeforeJoinAndLocalErasure() async throws {
        let recorder = CleanupRecorder()
        let harness = try BindingHarness(cleanupRecorder: recorder)
        let runtime = try await harness.bind()
        recorder.reset()

        try await harness.coordinator.logout()

        XCTAssertEqual(
            recorder.values(),
            ["credentials", "scheduler", "repository", "signing", "encryption", "record"]
        )
        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())
        XCTAssertFalse(harness.signing.hasKey)
        XCTAssertTrue(harness.encryption.deleted)
        let purgedIdentity = try XCTUnwrap(harness.environment.repositoryPurgeIdentity)
        XCTAssertTrue(purgedIdentity.hasSameBindingGeneration(as: runtime.identity))
        XCTAssertNotEqual(purgedIdentity, runtime.identity)
        XCTAssertEqual(
            purgedIdentity.bindingRecordVersion.count,
            SyncBindingIdentity.bindingRecordVersionByteCount
        )
        let calls = await harness.api.recordedCalls()
        XCTAssertEqual(calls.last, "logout")
    }

    func testCleanupFailureRetainsScopedRecordAndCanBeRetried() async throws {
        let recorder = CleanupRecorder()
        let harness = try BindingHarness(cleanupRecorder: recorder)
        _ = try await harness.bind()
        harness.credentials.failNextRemoval()

        do {
            try await harness.coordinator.logout()
            XCTFail("Expected credential cleanup to fail")
        } catch let error as MobileBindingCoordinatorError {
            XCTAssertEqual(error, .cleanupFailed([.credentials]))
        }

        let currentAfterFailure = await harness.coordinator.currentRuntime()
        XCTAssertNil(currentAfterFailure)
        XCTAssertEqual(try harness.recordStore.load()?.phase, .cleanupPending)
        XCTAssertEqual(harness.environment.repositoryPurgeAttemptCount, 0)
        XCTAssertTrue(harness.signing.hasKey)
        XCTAssertFalse(harness.encryption.deleted)
        try await harness.coordinator.logout()
        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())
    }

    func testCleanupMarkerCASLossNeverPurgesReplacementGeneration() async throws {
        let recorder = CleanupRecorder()
        let harness = try BindingHarness(cleanupRecorder: recorder)
        let retainedRuntime = try await harness.bind()
        recorder.reset()
        let winner = BindingFixtures.record(generation: "generation-winner")
        harness.recordStore.loseNextReplace(to: .cleanupPending, installing: winner)

        do {
            try await harness.coordinator.logout()
            XCTFail("The stale cleanup owner must lose its exact CAS")
        } catch let error as MobileBindingCoordinatorError {
            XCTAssertEqual(error, .identityMismatch)
        }

        XCTAssertEqual(try harness.recordStore.load()?.record, winner)
        XCTAssertEqual(harness.environment.repositoryPurgeAttemptCount, 0)
        XCTAssertTrue(recorder.values().isEmpty)
        XCTAssertNotNil(try harness.credentials.credentials())
        XCTAssertTrue(harness.signing.hasKey)
        XCTAssertFalse(harness.encryption.deleted)
        let disabledTrigger = await retainedRuntime.trigger(.foreground)
        XCTAssertEqual(disabledTrigger, .unavailable)
    }

    func testRepositoryPurgeFailureFallsBackToCryptographicErasure() async throws {
        let recorder = CleanupRecorder()
        let harness = try BindingHarness(cleanupRecorder: recorder)
        let retainedRuntime = try await harness.bind()
        recorder.reset()
        harness.environment.failNextRepositoryPurge()

        try await harness.coordinator.logout()

        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())
        XCTAssertFalse(harness.signing.hasKey)
        XCTAssertTrue(harness.encryption.deleted)
        XCTAssertTrue(recorder.values().contains("storageFallback"))
        let disabledStart = await retainedRuntime.start()
        let disabledTrigger = await retainedRuntime.trigger(.foreground)
        XCTAssertTrue(disabledStart.isEmpty)
        XCTAssertEqual(disabledTrigger, .unavailable)
        XCTAssertEqual(harness.environment.startCount, 1)
    }

    func testConcurrentTerminalReportsDeduplicateAndEraseEveryBindingComponent() async throws {
        let recorder = CleanupRecorder()
        let harness = try BindingHarness(cleanupRecorder: recorder)
        let runtime = try await harness.bind()
        recorder.reset()
        await harness.api.enqueueChangesError(
            .local(code: "client_revoked", message: "device was revoked")
        )

        async let finiteResults = runtime.trigger(.backgroundTask)
        async let deviceReport: Void = harness.environment.reportServerRevocation(.deviceRevoked)
        async let accountReport: Void = harness.environment.reportServerRevocation(.accountUnavailable)
        _ = await (deviceReport, accountReport)
        _ = await finiteResults

        let cleanupFinished = await bindingEventually {
            (try? harness.recordStore.load()) == nil
        }
        let currentRuntime = await harness.coordinator.currentRuntime()
        XCTAssertTrue(cleanupFinished)
        XCTAssertEqual(
            ["scheduler", "credentials", "repository", "signing", "encryption", "record"],
            recorder.values()
        )
        XCTAssertNil(currentRuntime)
        XCTAssertNil(try harness.credentials.credentials())
        XCTAssertFalse(harness.signing.hasKey)
        XCTAssertTrue(harness.encryption.deleted)
    }

    func testFirstStartRevocationIsFencedAndCannotPublishTheRuntime() async throws {
        let startGate = StartGate()
        let harness = try BindingHarness(startGate: startGate)
        let binding = Task { try await harness.bind() }
        await startGate.waitUntilSuspended()

        await harness.environment.reportServerRevocation(.deviceRevoked)
        await startGate.waitUntilCancelled()
        await startGate.release()

        do {
            _ = try await binding.value
            XCTFail("A runtime revoked by its first sync must not be published")
        } catch {}
        let cleanupFinished = await bindingEventually {
            (try? harness.recordStore.load()) == nil
        }
        let currentRuntime = await harness.coordinator.currentRuntime()
        XCTAssertTrue(cleanupFinished)
        XCTAssertNil(currentRuntime)
        XCTAssertNil(try harness.credentials.credentials())
        XCTAssertFalse(harness.signing.hasKey)
        XCTAssertTrue(harness.encryption.deleted)
    }

    func testDelayedRevocationCleanupCannotEraseReplacementBinding() async throws {
        let cleanupGate = StartGate()
        let generations = SequentialGenerationSource(["generation-a", "generation-b"])
        let harness = try BindingHarness(
            loginResponses: [
                .authenticated(session: BindingFixtures.session),
                .authenticated(session: BindingFixtures.session),
            ],
            revocationCleanupStartGate: cleanupGate,
            generationSource: { generations.next() }
        )
        let bindingA = try await harness.bind()

        await harness.environment.reportServerRevocation(.deviceRevoked)
        await cleanupGate.waitUntilSuspended()
        try await harness.coordinator.logout()

        do {
            _ = try await harness.coordinator.beginLogin(
                username: "andy",
                password: "password-secret"
            )
            XCTFail("Pending revocation cleanup must block replacement login")
        } catch let error as MobileBindingCoordinatorError {
            XCTAssertEqual(error, .invalidState)
        }

        await cleanupGate.release()
        var replacementLogin: MobileBindingLoginStep?
        for _ in 0..<2_000 where replacementLogin == nil {
            do {
                replacementLogin = try await harness.coordinator.beginLogin(
                    username: "andy",
                    password: "password-secret"
                )
            } catch let error as MobileBindingCoordinatorError where error == .invalidState {
                await Task.yield()
            }
        }
        XCTAssertEqual(replacementLogin, .ready(accountID: "user-1", username: "andy"))
        _ = try await harness.coordinator.listTokens()
        let bindingB = try await harness.coordinator.bind(
            secret: "password-secret",
            registration: try MobileBindingRegistration(
                tokenID: "token-1",
                deviceName: "Phone B",
                syncIntervalSeconds: 60
            )
        )

        XCTAssertNotEqual(bindingA.identity, bindingB.identity)
        XCTAssertEqual(bindingB.identity.generation, "generation-b")
        let bindingBSnapshot = try XCTUnwrap(try harness.recordStore.load())
        XCTAssertEqual(BindingFixtures.runtimeIdentity(bindingBSnapshot), bindingB.identity)
        let currentRuntime = await harness.coordinator.currentRuntime()
        XCTAssertEqual(currentRuntime?.identity, bindingB.identity)
        XCTAssertNotNil(try harness.credentials.credentials())
        XCTAssertTrue(harness.signing.hasKey)
        XCTAssertFalse(harness.encryption.deleted)
    }

    func testRevocationRebuildsMissingRecordFromRuntimeSummary() async throws {
        let cleanupGate = StartGate()
        let harness = try BindingHarness(revocationCleanupStartGate: cleanupGate)
        let runtime = try await harness.bind()
        try harness.recordStore.clear()

        await harness.environment.reportServerRevocation(.deviceRevoked)
        await cleanupGate.waitUntilSuspended()

        XCTAssertEqual(try harness.recordStore.load()?.phase, .cleanupPending)
        let rebuilt = try XCTUnwrap(try harness.recordStore.load())
        XCTAssertTrue(BindingFixtures.runtimeIdentity(rebuilt).hasSameBindingGeneration(as: runtime.identity))
        let currentRuntime = await harness.coordinator.currentRuntime()
        let disabledTrigger = await runtime.trigger(.foreground)
        XCTAssertNil(currentRuntime)
        XCTAssertEqual(disabledTrigger, .unavailable)

        await cleanupGate.release()
        let cleanupFinished = await bindingEventually { (try? harness.recordStore.load()) == nil }
        XCTAssertTrue(cleanupFinished)
    }

    func testRevocationDoesNotOverwriteUnreadableRecordAndRetriesCleanupInProcess() async throws {
        let cleanupGate = StartGate()
        let harness = try BindingHarness(revocationCleanupStartGate: cleanupGate)
        let runtime = try await harness.bind()
        harness.recordStore.failNextLoad()

        await harness.environment.reportServerRevocation(.deviceRevoked)
        await cleanupGate.waitUntilSuspended()

        XCTAssertEqual(try harness.recordStore.load()?.phase, .cleanupPending)
        let cleanup = try XCTUnwrap(try harness.recordStore.load())
        XCTAssertTrue(BindingFixtures.runtimeIdentity(cleanup).hasSameBindingGeneration(as: runtime.identity))
        XCTAssertEqual(
            harness.environment.repositorySnapshot(for: runtime.identity)?.runtimeLeaseState,
            .fenced
        )
        let currentRuntime = await harness.coordinator.currentRuntime()
        XCTAssertNil(currentRuntime)

        await cleanupGate.release()
        let cleanupFinished = await bindingEventually { (try? harness.recordStore.load()) == nil }
        XCTAssertTrue(cleanupFinished)
    }

    func testRevocationRecordSaveFailureRecoversAfterCrashFromRepositoryFence() async throws {
        let cleanupGate = StartGate()
        let harness = try BindingHarness(revocationCleanupStartGate: cleanupGate)
        let runtime = try await harness.bind()
        harness.recordStore.failNextSave()

        await harness.environment.reportServerRevocation(.deviceRevoked)
        await cleanupGate.waitUntilSuspended()

        XCTAssertEqual(try harness.recordStore.load()?.phase, .cleanupPending)
        let currentRuntime = await harness.coordinator.currentRuntime()
        let disabledTrigger = await runtime.trigger(.foreground)
        XCTAssertNil(currentRuntime)
        XCTAssertEqual(disabledTrigger, .unavailable)

        XCTAssertEqual(
            harness.environment.repositorySnapshot(for: runtime.identity)?.runtimeLeaseState,
            .fenced
        )
        let restarted = harness.makeCoordinator()
        let restored = try await restarted.restore()
        XCTAssertNil(restored)
        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())
        XCTAssertFalse(harness.signing.hasKey)
        XCTAssertTrue(harness.encryption.deleted)

        await cleanupGate.release()
    }

    func testExplicitRevocationRecordLoadFailureFencesAndRetriesToCompletion() async throws {
        let harness = try BindingHarness()
        let runtime = try await harness.bind()
        harness.recordStore.failNextLoad()

        try await harness.coordinator.handleServerRevocation()

        let currentRuntime = await harness.coordinator.currentRuntime()
        XCTAssertNil(currentRuntime)
        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())
        let disabledTrigger = await runtime.trigger(.foreground)
        XCTAssertEqual(disabledTrigger, .unavailable)
    }

    func testExplicitRevocationRecordSaveFailureRetainsSentinelAndRetries() async throws {
        let harness = try BindingHarness()
        _ = try await harness.bind()
        harness.recordStore.failNextSave()

        try await harness.coordinator.handleServerRevocation()

        XCTAssertNil(try harness.recordStore.load())
        let currentRuntime = await harness.coordinator.currentRuntime()
        XCTAssertNil(currentRuntime)
        XCTAssertNil(try harness.credentials.credentials())
    }

    func testUnopenableEncryptedRepositoryUsesScopedErasureFallback() async throws {
        let recorder = CleanupRecorder()
        let harness = try BindingHarness(cleanupRecorder: recorder)
        let record = BindingFixtures.record(phase: .cleanupPending)
        try harness.recordStore.save(record)
        try harness.credentials.storeInitial(BindingFixtures.credentials)
        harness.environment.repositoryOpenFails = true

        let restored = try await harness.coordinator.restore()

        XCTAssertNil(restored)
        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())
        XCTAssertFalse(harness.signing.hasKey)
        XCTAssertTrue(harness.encryption.deleted)
        XCTAssertEqual(harness.environment.encryptedStorageEraseAttemptCount, 1)
        XCTAssertTrue(recorder.values().contains("storageFallback"))
    }

    func testActiveBindingWithUnopenableRepositoryIsCryptoErasedBeforeNetwork() async throws {
        let recorder = CleanupRecorder()
        let harness = try BindingHarness(cleanupRecorder: recorder)
        let record = BindingFixtures.record()
        try harness.recordStore.save(record)
        try harness.credentials.storeInitial(BindingFixtures.credentials)
        harness.environment.repositoryOpenFails = true

        let restored = try await harness.coordinator.restore()

        XCTAssertNil(restored)
        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())
        XCTAssertFalse(harness.signing.hasKey)
        XCTAssertTrue(harness.encryption.deleted)
        XCTAssertEqual(harness.environment.encryptedStorageEraseAttemptCount, 1)
        XCTAssertTrue(recorder.values().contains("storageFallback"))
        let calls = await harness.api.recordedCalls()
        XCTAssertTrue(calls.isEmpty)
    }

    func testTerminalSyncCleanupFailureRetainsMarkerAndRetriesInProcess() async throws {
        let recorder = CleanupRecorder()
        let retryGate = StartGate()
        let harness = try BindingHarness(
            cleanupRecorder: recorder,
            revocationCleanupRetryGate: retryGate
        )
        let runtime = try await harness.bind()
        recorder.reset()
        harness.environment.failNextRepositoryPurge()
        harness.environment.failNextEncryptedStorageErase()
        await harness.api.enqueueChangesError(
            .local(code: "account_unavailable", message: "account was removed")
        )

        _ = await runtime.trigger(.backgroundTask)
        await retryGate.waitUntilSuspended()

        XCTAssertEqual(try harness.recordStore.load()?.phase, .cleanupPending)
        let currentRuntime = await harness.coordinator.currentRuntime()
        XCTAssertNil(currentRuntime)
        XCTAssertNil(try harness.credentials.credentials())
        XCTAssertFalse(harness.signing.hasKey)
        XCTAssertTrue(harness.encryption.deleted)

        await retryGate.release()
        let cleanupFinished = await bindingEventually {
            (try? harness.recordStore.load()) == nil
        }
        XCTAssertTrue(cleanupFinished)
    }

    func testRestorePurgesPersistedRevokedSnapshotBeforeAnyNetworkRequest() async throws {
        let recorder = CleanupRecorder()
        let harness = try BindingHarness(cleanupRecorder: recorder)
        let record = BindingFixtures.record()
        try harness.recordStore.save(record)
        try harness.credentials.storeInitial(BindingFixtures.credentials)
        harness.environment.forcedRepositoryState = .revoked

        let restored = try await harness.coordinator.restore()

        XCTAssertNil(restored)
        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())
        XCTAssertFalse(harness.signing.hasKey)
        XCTAssertTrue(harness.encryption.deleted)
        let calls = await harness.api.recordedCalls()
        XCTAssertTrue(calls.isEmpty)
        XCTAssertEqual(
            ["credentials", "repository", "signing", "encryption", "record"],
            recorder.values()
        )
    }

    func testTerminalRefreshDuringRestoreReturnsCleanupOnly() async throws {
        let recorder = CleanupRecorder()
        let harness = try BindingHarness(cleanupRecorder: recorder)
        try harness.recordStore.save(BindingFixtures.record())
        try harness.credentials.storeInitial(BindingFixtures.credentials)
        await harness.api.setRefreshError(
            .local(code: "client_revoked", message: "device was revoked")
        )

        let restored = try await harness.coordinator.restore()

        XCTAssertNil(restored)
        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())
        XCTAssertFalse(harness.signing.hasKey)
        XCTAssertTrue(harness.encryption.deleted)
    }

    func testRebindOnlyRefreshFailureTransitionsThroughCleanup() async throws {
        let harness = try BindingHarness()
        let record = BindingFixtures.record()
        try harness.recordStore.save(record)
        try harness.credentials.storeInitial(BindingFixtures.credentials)
        await harness.api.setRefreshError(
            .local(code: "refresh_replayed", message: "refresh credential was replayed")
        )

        do {
            _ = try await harness.coordinator.restore()
            XCTFail("Expected refresh replay to require a rebind")
        } catch let error as MobileApiError {
            XCTAssertEqual("refresh_replayed", error.code)
        }

        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())
        XCTAssertFalse(harness.signing.hasKey)
        XCTAssertTrue(harness.encryption.deleted)
    }

    func testProductionRuntimeWiresTerminalRevocationToDurableCleanup() throws {
        let source = try zephyrCoreSource(named: "MobileBindingCoordinator.swift")
        let engineSource = try zephyrCoreSource(named: "SyncEngine.swift")
        let schedulerSource = try zephyrCoreSource(named: "SyncScheduler.swift")
        let compactSource = source.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")

        XCTAssertTrue(source.contains(
            "await self?.handleReportedServerRevocation(reason, for: identity)"
        ))
        XCTAssertTrue(engineSource.contains(
            "(MobileServerRevocationReason) async -> Void"
        ))
        XCTAssertTrue(engineSource.contains("await serverRevocationHandler(reason)"))
        XCTAssertTrue(compactSource.contains(
            "destroyBinding( reason: .revocation, expectedIdentity: identity )"
        ))

        let restoreCAS = try XCTUnwrap(source.range(of: "record.record.replacingPhase(.restoring)"))
        let restorePrepare = try XCTUnwrap(source.range(
            of: "record: restoringSnapshot.record",
            range: restoreCAS.upperBound..<source.endIndex
        ))
        let restoreFence = try XCTUnwrap(source.range(
            of: "try await repository.fenceRuntime(",
            range: restorePrepare.upperBound..<source.endIndex
        ))
        let restorePublish = try XCTUnwrap(source.range(
            of: "try await repository.publishRuntime(",
            range: restoreFence.upperBound..<source.endIndex
        ))
        let runtimeConstruction = try XCTUnwrap(source.range(
            of: "let restored = try prepared.makeRuntime(",
            range: restorePublish.upperBound..<source.endIndex
        ))
        XCTAssertLessThan(restoreCAS.lowerBound, restorePrepare.lowerBound)
        XCTAssertLessThan(restorePrepare.lowerBound, restoreFence.lowerBound)
        XCTAssertLessThan(restoreFence.lowerBound, restorePublish.lowerBound)
        XCTAssertLessThan(restorePublish.lowerBound, runtimeConstruction.lowerBound)

        let teardownStart = try XCTUnwrap(source.range(of: "private func destroyBinding("))
        let teardown = String(source[teardownStart.lowerBound...])
        let marker = try XCTUnwrap(teardown.range(
            of: "storedSnapshot.record.replacingPhase(.cleanupPending)"
        ))
        let repositoryFence = try XCTUnwrap(teardown.range(of: "fenceRepositoryForCleanup("))
        let reconcile = try XCTUnwrap(teardown.range(of: "cleanupCredentials.reconcileLease("))
        let terminate = try XCTUnwrap(teardown.range(of: "cleanupCredentials.terminateLease("))
        let cancel = try XCTUnwrap(teardown.range(of: "await currentRuntime?.cancelAndJoin"))
        let purge = try XCTUnwrap(teardown.range(of: "cleanupRepository.purgeAll"))
        XCTAssertLessThan(marker.lowerBound, reconcile.lowerBound)
        XCTAssertLessThan(marker.lowerBound, repositoryFence.lowerBound)
        XCTAssertLessThan(repositoryFence.lowerBound, reconcile.lowerBound)
        XCTAssertLessThan(reconcile.lowerBound, terminate.lowerBound)
        XCTAssertLessThan(terminate.lowerBound, cancel.lowerBound)
        XCTAssertLessThan(cancel.lowerBound, purge.lowerBound)

        XCTAssertFalse(source.contains("public let repository"))
        XCTAssertTrue(source.contains("private let engine: SyncEngine"))
        XCTAssertTrue(source.contains("private let scheduler: SyncScheduler"))
        XCTAssertFalse(engineSource.contains("public init(\n        transport:"))
        XCTAssertFalse(schedulerSource.contains("public init(\n        identity:"))
        XCTAssertTrue(source.contains("while serverRevocationCleanupIdentity == identity"))
        XCTAssertTrue(source.contains("cleanupRecord(from: $0.summary)"))
        XCTAssertTrue(compactSource.contains("saveBindingState( .revoked,"))
        XCTAssertTrue(source.contains("record.phase != .active"))
    }

    func testLogoutWinsWhenBindCompletesAfterTeardownStarts() async throws {
        let startGate = StartGate()
        let harness = try BindingHarness(startGate: startGate)
        let binding = Task { try await harness.bind() }
        await startGate.waitUntilSuspended()

        let logout = Task { try await harness.coordinator.logout() }
        await startGate.waitUntilCancelled()
        await startGate.release()
        try await logout.value

        do {
            _ = try await binding.value
            XCTFail("The bind caller must not receive a runtime after teardown")
        } catch is CancellationError {
        }
        let currentAfterLogout = await harness.coordinator.currentRuntime()
        XCTAssertNil(currentAfterLogout)
        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())
    }

    func testLogoutWinsWhenRestoreCompletesAfterTeardownStarts() async throws {
        let startGate = StartGate()
        let harness = try BindingHarness(startGate: startGate)
        let record = BindingFixtures.record()
        try harness.recordStore.save(record)
        try harness.credentials.storeInitial(BindingFixtures.credentials)
        let restoring = Task { try await harness.coordinator.restore() }
        await startGate.waitUntilSuspended()

        let logout = Task { try await harness.coordinator.logout() }
        await startGate.waitUntilCancelled()
        await startGate.release()
        try await logout.value

        let restoredAfterLogout = try await restoring.value
        XCTAssertNil(restoredAfterLogout)
        let currentAfterLogout = await harness.coordinator.currentRuntime()
        XCTAssertNil(currentAfterLogout)
        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())
    }

    func testRevokeObtainsDeviceRevokeGrantAfterStoppingSchedulerThenWipes() async throws {
        let recorder = CleanupRecorder()
        let harness = try BindingHarness(cleanupRecorder: recorder)
        _ = try await harness.bind()
        recorder.reset()

        try await harness.coordinator.revoke(secret: "password-secret")

        let calls = await harness.api.recordedCalls()
        XCTAssertEqual(Array(calls.suffix(2)), ["verify.device.revoke", "revoke"])
        XCTAssertEqual(recorder.values().first, "scheduler")
        XCTAssertNil(try harness.recordStore.load())
    }

    func testExplicitRevokeProcessKillWindowRestartsAsCleanupOnly() async throws {
        let verifyGate = StartGate()
        let harness = try BindingHarness()
        let runtime = try await harness.bind()
        await harness.api.setRevocationVerifyGate(verifyGate)

        let revoking = Task {
            try await harness.coordinator.revoke(secret: "password-secret")
        }
        await verifyGate.waitUntilSuspended()

        XCTAssertEqual(try harness.recordStore.load()?.phase, .cleanupPending)
        XCTAssertEqual(
            harness.environment.repositorySnapshot(for: runtime.identity)?.runtimeLeaseState,
            .fenced
        )
        let currentBeforeRestart = await harness.coordinator.currentRuntime()
        let disabledBeforeRestart = await runtime.trigger(.foreground)
        XCTAssertNil(currentBeforeRestart)
        XCTAssertEqual(disabledBeforeRestart, .unavailable)

        let restarted = harness.makeCoordinator()
        let restored = try await restarted.restore()
        XCTAssertNil(restored)
        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())

        revoking.cancel()
        await verifyGate.release()
        do {
            try await revoking.value
            XCTFail("The simulated killed process must not continue to device revoke")
        } catch is CancellationError {}
    }

    func testExplicitRevokeRemoteFailureStaysCleanupOnlyAndCanRetry() async throws {
        let harness = try BindingHarness()
        let runtime = try await harness.bind()
        await harness.api.enqueueRevokeError(.offline)

        do {
            try await harness.coordinator.revoke(secret: "password-secret")
            XCTFail("Expected the first remote revoke to fail")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, MobileApiError.offline.code)
        }

        XCTAssertEqual(try harness.recordStore.load()?.phase, .cleanupPending)
        XCTAssertEqual(
            harness.environment.repositorySnapshot(for: runtime.identity)?.runtimeLeaseState,
            .fenced
        )
        let currentAfterFailure = await harness.coordinator.currentRuntime()
        let disabledAfterFailure = await runtime.trigger(.foreground)
        XCTAssertNil(currentAfterFailure)
        XCTAssertEqual(disabledAfterFailure, .unavailable)
        XCTAssertNotNil(try harness.credentials.credentials())

        try await harness.coordinator.revoke(secret: "password-secret")

        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())
        let calls = await harness.api.recordedCalls()
        XCTAssertEqual(Array(calls.suffix(4)), [
            "verify.device.revoke", "revoke",
            "verify.device.revoke", "revoke",
        ])
    }

    func testTwoSceneBindBWinsWhenSceneAResponseArrivesLate() async throws {
        let bindGate = StartGate()
        let harness = try BindingHarness(generationSource: { "generation-a" })
        await harness.api.setBindGate(bindGate)

        let binding = Task { try await harness.bind() }
        await bindGate.waitUntilSuspended()
        let generationA = try XCTUnwrap(try harness.recordStore.load())
        XCTAssertEqual(generationA.phase, .binding)

        let generationB = BindingFixtures.record(generation: "generation-b")
        XCTAssertTrue(try harness.recordStore.clear(expected: generationA))
        XCTAssertNotNil(try harness.recordStore.insertIfAbsent(generationB))

        await bindGate.release()
        do {
            _ = try await binding.value
            XCTFail("The stale coordinator must lose the final binding CAS")
        } catch let error as MobileBindingCoordinatorError {
            XCTAssertEqual(error, .cleanupFailed([.bindingRecord]))
        }

        XCTAssertEqual(try harness.recordStore.load()?.record, generationB)
        XCTAssertEqual(harness.environment.repositoryPurgeAttemptCount, 0)
        XCTAssertTrue(harness.signing.hasKey)
        XCTAssertFalse(harness.encryption.deleted)
    }

    func testBindOwnershipLossAfterSensitiveVerifyStopsBeforeRemoteBind() async throws {
        let verifyGate = StartGate()
        let harness = try BindingHarness(generationSource: { "generation-a" })
        await harness.api.setBindingVerifyGate(verifyGate)

        let binding = Task { try await harness.bind() }
        await verifyGate.waitUntilSuspended()
        let generationA = try XCTUnwrap(try harness.recordStore.load())
        XCTAssertTrue(try harness.recordStore.clear(expected: generationA))
        let winner = BindingFixtures.record(generation: "generation-b")
        XCTAssertNotNil(try harness.recordStore.insertIfAbsent(winner))

        await verifyGate.release()
        do {
            _ = try await binding.value
            XCTFail("The stale scene must stop before bind")
        } catch let error as MobileBindingCoordinatorError {
            XCTAssertEqual(error, .cleanupFailed([.bindingRecord]))
        }
        let calls = await harness.api.recordedCalls()
        XCTAssertEqual(calls.last, "verify.device.bind")
        XCTAssertEqual(try harness.recordStore.load()?.record, winner)
    }

    func testServerRevisionConflictCompensatesOnlyRejectedGeneration() async throws {
        let harness = try BindingHarness()
        await harness.api.enqueueBindError(
            MobileApiError(
                code: "revision_conflict",
                message: "bind attempt was superseded",
                retryable: false,
                requestId: "request-bind-conflict",
                details: ["reason": "bind_attempt_stale"],
                httpStatus: 409
            )
        )

        do {
            _ = try await harness.bind()
            XCTFail("Expected the conditional bind to be rejected")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "revision_conflict")
            XCTAssertEqual(error.details["reason"], "bind_attempt_stale")
        }
        XCTAssertNil(try harness.recordStore.load())
        XCTAssertNil(try harness.credentials.credentials())
        let currentRuntime = await harness.coordinator.currentRuntime()
        XCTAssertNil(currentRuntime)
    }

    func testConcurrentExpiredAccessRefreshIsSingleFlightAndAtomic() async throws {
        let api = try FakeBindingAPI()
        await api.setRefreshDelayNanoseconds(25_000_000)
        let credentials = FakeBindingCredentials()
        try credentials.storeInitial(BindingFixtures.credentials)
        let controller = MobileAccessCredentialController(
            api: api,
            credentials: credentials,
            lease: try credentials.leaseForTests(identity: BindingFixtures.record().identity),
            identity: BindingFixtures.record().identity,
            tokenID: "token-1",
            appVersion: "2.3.4",
            expectedRegistryHash: "registry-hash",
            clock: FakeBindingClock(now: 1_725_000_000_000)
        )

        async let first = controller.ensureFresh(force: true)
        async let second = controller.ensureFresh(force: true)
        _ = try await (first, second)

        let calls = await api.recordedCalls()
        XCTAssertEqual(calls, ["refresh"])
        XCTAssertEqual(try credentials.credentials()?.accessCredential, "access-refreshed")
        XCTAssertEqual(try credentials.credentials()?.refreshCredential, "refresh-refreshed")
        await controller.cancelAndJoin()
    }

    func testExpiredRefreshResponseIsRejectedBeforeCredentialRotation() async throws {
        let response = try BindingFixtures.refreshResponse(accessExpiresAt: 1_724_999_999_999)
        let api = try FakeBindingAPI(refreshResult: response)
        let credentials = FakeBindingCredentials()
        try credentials.storeInitial(BindingFixtures.credentials)
        let controller = makeRefreshController(api: api, credentials: credentials)

        do {
            _ = try await controller.ensureFresh(force: true)
            XCTFail("Expected an already-expired access credential to be rejected")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "access_credential_expired")
        }
        XCTAssertEqual(try credentials.credentials(), BindingFixtures.credentials)
    }

    func testMissingCredentialMapsToRebindError() async throws {
        let api = try FakeBindingAPI()
        let credentials = FakeBindingCredentials()
        let controller = makeRefreshController(api: api, credentials: credentials)

        do {
            _ = try await controller.ensureFresh(force: true)
            XCTFail("Expected missing credentials to require a rebind")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "token_missing")
            XCTAssertTrue(error.requiresRebind)
        }
    }

    func testRefreshIdentityMismatchMapsToRevokedWithoutRotation() async throws {
        let response = try BindingFixtures.refreshResponse(owner: "other-user")
        let api = try FakeBindingAPI(refreshResult: response)
        let credentials = FakeBindingCredentials()
        try credentials.storeInitial(BindingFixtures.credentials)
        let controller = makeRefreshController(api: api, credentials: credentials)

        do {
            _ = try await controller.ensureFresh(force: true)
            XCTFail("Expected a cross-owner refresh response to be rejected")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "client_revoked")
            XCTAssertTrue(error.requiresRebind)
        }
        XCTAssertEqual(try credentials.credentials(), BindingFixtures.credentials)
    }

    func testStaleUnauthorizedVersionDoesNotRotateRefreshCredentialTwice() async throws {
        let api = try FakeBindingAPI()
        let credentials = FakeBindingCredentials()
        try credentials.storeInitial(BindingFixtures.credentials)
        let controller = makeRefreshController(api: api, credentials: credentials)
        let staleVersion = await controller.currentCredentialVersion()

        _ = try await controller.ensureFresh(force: true)
        try await controller.refreshAfterUnauthorized(ifVersion: staleVersion)

        let calls = await api.recordedCalls()
        XCTAssertEqual(calls, ["refresh"])
        XCTAssertEqual(try credentials.credentials()?.refreshCredential, "refresh-refreshed")
    }

    func testTokenRotatedAccessFailureRefreshesAndRetries() async throws {
        let api = try FakeBindingAPI()
        await api.enqueueChangesError(
            .local(code: "token_rotated", message: "access generation is stale")
        )
        let credentials = FakeBindingCredentials()
        try credentials.storeInitial(
            KeychainCredentials(
                accessCredential: "access-current",
                accessExpiresAtMilliseconds: 1_725_007_200_000,
                refreshCredential: "refresh-current"
            )
        )
        let controller = makeRefreshController(api: api, credentials: credentials)
        let transport = RefreshingSyncTransport(api: api, refresh: controller)

        let page = try await transport.changes(cursor: 0, limit: nil)
        let calls = await api.recordedCalls()

        XCTAssertEqual(0, page.nextCursor)
        XCTAssertEqual(
            ["changes", "refresh", "changes"],
            calls
        )
        XCTAssertEqual(try credentials.credentials()?.refreshCredential, "refresh-refreshed")
    }

    func testExpiringAccessRefreshesBeforeFiniteRequestWithoutRevocation() async throws {
        let api = try FakeBindingAPI()
        let credentials = FakeBindingCredentials()
        try credentials.storeInitial(
            KeychainCredentials(
                accessCredential: "access-expiring",
                accessExpiresAtMilliseconds: 1_725_000_030_000,
                refreshCredential: "refresh-current"
            )
        )
        let transport = RefreshingSyncTransport(
            api: api,
            refresh: makeRefreshController(api: api, credentials: credentials)
        )

        _ = try await transport.changes(cursor: 0, limit: nil)
        let calls = await api.recordedCalls()

        XCTAssertEqual(["refresh", "changes"], calls)
        XCTAssertEqual(try credentials.credentials()?.refreshCredential, "refresh-refreshed")
    }

    func testTerminalRefreshFailurePropagatesThroughFiniteSyncTransport() async throws {
        let api = try FakeBindingAPI()
        await api.enqueueChangesError(
            .local(code: "token_rotated", message: "access generation is stale")
        )
        await api.setRefreshError(
            .local(code: "client_revoked", message: "device was revoked")
        )
        let credentials = FakeBindingCredentials()
        try credentials.storeInitial(
            KeychainCredentials(
                accessCredential: "access-current",
                accessExpiresAtMilliseconds: 1_725_007_200_000,
                refreshCredential: "refresh-current"
            )
        )
        let identity = BindingFixtures.runtimeIdentity()
        let transport = RefreshingSyncTransport(
            api: api,
            refresh: makeRefreshController(api: api, credentials: credentials)
        )
        let repository = FakeBindingRepository(identity: identity, recorder: CleanupRecorder())
        let revocations = BindingRevocationRecorder()
        let engine = SyncEngine(
            identity: identity,
            transport: transport,
            repository: repository,
            clock: FakeBindingClock(now: 1_725_000_000_000),
            serverRevocationHandler: { revocations.append($0) }
        )

        let results = await engine.request(.manual)
        let calls = await api.recordedCalls()

        XCTAssertEqual("client_revoked", results.first?.error?.code)
        XCTAssertEqual([.clientRevoked], revocations.values())
        XCTAssertEqual(["capabilities", "changes", "refresh"], calls)
        XCTAssertEqual(try credentials.credentials()?.refreshCredential, "refresh-current")
    }

    func testTerminalRefreshFailurePropagatesThroughWakeTransport() async throws {
        let api = try FakeBindingAPI()
        await api.setRefreshError(
            .local(code: "account_unavailable", message: "account was removed")
        )
        let credentials = FakeBindingCredentials()
        try credentials.storeInitial(
            KeychainCredentials(
                accessCredential: "access-current",
                accessExpiresAtMilliseconds: 1_725_007_200_000,
                refreshCredential: "refresh-current"
            )
        )
        let transport = RefreshingWakeStreamTransport(
            refresh: makeRefreshController(api: api, credentials: credentials),
            wake: ImmediateWakeTransport(
                outcome: WakeStreamOutcome(failureCode: "token_rotated")
            )
        )

        let outcome = await transport.open(lastEventID: nil) { _ in }
        let calls = await api.recordedCalls()

        XCTAssertEqual("account_unavailable", outcome.failureCode)
        XCTAssertEqual(["refresh"], calls)
        XCTAssertEqual(try credentials.credentials()?.refreshCredential, "refresh-current")
    }

    private func makeRefreshController(
        api: FakeBindingAPI,
        credentials: FakeBindingCredentials
    ) -> MobileAccessCredentialController {
        let leaseIdentity = BindingFixtures.record().identity
        let lease = try! credentials.leaseForTests(identity: leaseIdentity)
        let identity = lease.identity.replacingBindingRecordVersion(lease.recordVersion)
        return MobileAccessCredentialController(
            api: api,
            credentials: credentials,
            lease: lease,
            identity: identity,
            tokenID: "token-1",
            appVersion: "2.3.4",
            expectedRegistryHash: "registry-hash",
            clock: FakeBindingClock(now: 1_725_000_000_000)
        )
    }

    private func zephyrCoreSource(named name: String) throws -> String {
        let packageDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sourceURL = packageDirectory
            .appendingPathComponent("Sources")
            .appendingPathComponent("ZephyrCore")
            .appendingPathComponent(name)
        return try String(contentsOf: sourceURL, encoding: .utf8)
    }
}

private final class BindingHarness: @unchecked Sendable {
    let api: FakeBindingAPI
    let recordStore: FakeBindingRecordStore
    let credentials: FakeBindingCredentials
    let signing: FakeBindingSigningIdentity
    let encryption: FakeEncryptionIdentity
    let tokenLoader: FakeTokenLoader
    let environment: FakeBindingEnvironment
    let configuration: MobileBindingConfiguration
    let clock: FakeBindingClock
    let coordinator: MobileBindingCoordinator
    private let generationSource: @Sendable () -> String
    private let serverRevocationCleanupStart: @Sendable () async -> Void
    private let serverRevocationCleanupRetrySleep: @Sendable (Int64) async -> Void

    init(
        loginResponses: [MobileLoginResponse] = [.authenticated(session: BindingFixtures.session)],
        totpResponse: MobileLoginResponse = .authenticated(session: BindingFixtures.session),
        totpFailuresBeforeSuccess: Int = 0,
        cleanupRecorder: CleanupRecorder = CleanupRecorder(),
        startGate: StartGate? = nil,
        revocationCleanupStartGate: StartGate? = nil,
        revocationCleanupRetryGate: StartGate? = nil,
        generationSource: @escaping @Sendable () -> String = { "generation-1" }
    ) throws {
        let api = try FakeBindingAPI(
            loginResponses: loginResponses,
            totpResponse: totpResponse,
            totpFailuresBeforeSuccess: totpFailuresBeforeSuccess
        )
        let recordStore = FakeBindingRecordStore(recorder: cleanupRecorder)
        let credentials = FakeBindingCredentials(recorder: cleanupRecorder)
        let signing = FakeBindingSigningIdentity(recorder: cleanupRecorder)
        let encryption = FakeEncryptionIdentity(recorder: cleanupRecorder)
        let tokenLoader = FakeTokenLoader(tokens: [BindingFixtures.token])
        let clock = FakeBindingClock(now: 1_725_000_000_000)
        let environment = FakeBindingEnvironment(
            api: api,
            credentials: credentials,
            signing: signing,
            clock: clock,
            recorder: cleanupRecorder,
            startGate: startGate
        )
        let configuration = try MobileBindingConfiguration(
            baseURL: "wss://example.test/root",
            appVersion: "2.3.4",
            databaseDirectory: FileManager.default.temporaryDirectory,
            deviceID: BindingFixtures.deviceID
        )
        let cleanupStart: @Sendable () async -> Void = {
            if let revocationCleanupStartGate {
                await revocationCleanupStartGate.suspend()
            }
        }
        let cleanupRetrySleep: @Sendable (Int64) async -> Void = { _ in
            if let revocationCleanupRetryGate {
                await revocationCleanupRetryGate.suspend()
            } else {
                await Task.yield()
            }
        }
        self.api = api
        self.recordStore = recordStore
        self.credentials = credentials
        self.signing = signing
        self.encryption = encryption
        self.tokenLoader = tokenLoader
        self.environment = environment
        self.configuration = configuration
        self.clock = clock
        self.generationSource = generationSource
        self.serverRevocationCleanupStart = cleanupStart
        self.serverRevocationCleanupRetrySleep = cleanupRetrySleep
        self.coordinator = MobileBindingCoordinator(
            configuration: configuration,
            api: api,
            recordStore: recordStore,
            environment: environment,
            encryptionIdentity: encryption,
            tokenLoader: tokenLoader,
            clock: clock,
            generationSource: generationSource,
            serverRevocationCleanupStart: cleanupStart,
            serverRevocationCleanupRetrySleep: cleanupRetrySleep
        )
    }

    func makeCoordinator() -> MobileBindingCoordinator {
        MobileBindingCoordinator(
            configuration: configuration,
            api: api,
            recordStore: recordStore,
            environment: environment,
            encryptionIdentity: encryption,
            tokenLoader: tokenLoader,
            clock: clock,
            generationSource: generationSource,
            serverRevocationCleanupStart: {},
            serverRevocationCleanupRetrySleep: { _ in await Task.yield() }
        )
    }

    func bind() async throws -> MobileBindingRuntime {
        _ = try await coordinator.beginLogin(username: "andy", password: "password-secret")
        _ = try await coordinator.listTokens()
        return try await coordinator.bind(
            secret: "password-secret",
            registration: try MobileBindingRegistration(
                tokenID: "token-1",
                deviceName: "Phone",
                syncIntervalSeconds: 60
            )
        )
    }
}

private enum BindingFixtures {
    static let deviceID = "device-1234567890"
    static let session = MobileAuthenticatedSession(
        sid: "sid-secret",
        user: MobileAuthUser(userId: "user-1", username: "andy")
    )
    static let token = MobileBindingToken(
        id: "token-1",
        name: "Primary",
        ownerAccountID: "user-1"
    )
    static let credentials = KeychainCredentials(
        accessCredential: "access-old",
        accessExpiresAtMilliseconds: 1,
        refreshCredential: "refresh-old",
        sid: "sid-secret"
    )

    static func runtimeIdentity(version: UInt8 = 0xA5) -> SyncBindingIdentity {
        record().identity.replacingBindingRecordVersion(
            Data(repeating: version, count: MobileBindingRecordVersion.byteCount)
        )
    }

    static func runtimeIdentity(_ snapshot: MobileBindingRecordSnapshot) -> SyncBindingIdentity {
        snapshot.record.identity.replacingBindingRecordVersion(snapshot.recordVersion.data)
    }

    static func record(
        generation: String = "generation-1",
        phase: MobileBindingRecordPhase = .active
    ) -> MobileBindingRecord {
        MobileBindingRecord(
            phase: phase,
            baseURL: "https://example.test/root/",
            serverID: "server-1",
            accountID: "user-1",
            username: "andy",
            deviceID: deviceID,
            deviceName: "Phone",
            tokenID: "token-1",
            tokenName: "Primary",
            registryHash: "registry-hash",
            generation: generation,
            syncIntervalSeconds: 60,
            boundAtMilliseconds: phase == .active ? 1_725_000_000_000 : 0
        )
    }

    static func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    static func capabilities() throws -> MobileCapabilitiesResponse {
        let publicKey = Data(repeating: 0x42, count: 1_184).base64EncodedString()
        return try decode(
            MobileCapabilitiesResponse.self,
            """
            {"ok":true,"protocolVersions":[1],"registryHash":"registry-hash",
            "minimumAppVersions":{"android":"2.0.0","ios":"2.0.0"},
            "limits":{"maxOpsPerBatch":200,"maxPageSize":500,"defaultPageSize":100,
            "minIntervalSec":30,"maxIntervalSec":86400,"blobChunkBytes":262144,
            "maxBlobBytes":1073741824,"tombstoneRetentionDays":30,"appliedOpRetentionDays":30},
            "serverId":"server-1","auth":{"sidHeader":"X-Zephyr-Sid","accessScheme":"Bearer",
            "proofHeader":"X-Zephyr-Device-Proof","nonceHeader":"X-Zephyr-Server-Nonce",
            "timestampHeader":"X-Zephyr-Proof-Timestamp",
            "challengePath":"/api/mobile/v1/devices/proof-challenge",
            "proofVersion":"zephyr-one-device-proof-v2","proofSkewSec":30,"challengeTtlSec":30,
            "challengeMaxActivePerDevice":4,"challengeMaxIssuesPerMinute":60,
            "signatureFormat":"P1363","encryptionAlg":"ML-KEM-768","signingAlg":"ES256"},
            "serverEncryption":{"alg":"ML-KEM-768","keyVersion":3,"publicKey":"\(publicKey)"},
            "features":{"bidirectionalSync":true,"sharedResources":true,"fileBridge":true,
            "blobTransfer":true,"nearRealtimeWake":true},
            "wake":{"enabled":true,"transport":"sse","path":"/api/mobile/v1/sync/wake",
            "event":"wake","payloadFields":["cursor","epoch","reason"],"heartbeatSec":15,
            "retryMs":1000,"supportsLastEventId":true,"requiresDeviceAccess":true,
            "requiresDeviceProof":true,"maxConnections":100,"maxConnectionsPerOwner":5,
            "maxBufferedBytes":65536}}
            """
        )
    }

    static func bindResponse() throws -> MobileDeviceBindResponse {
        return try decode(
            MobileDeviceBindResponse.self,
            """
            {"ok":true,"device":\(deviceJSON()),"accessCredential":"access-new",
            "accessExpiresAt":1725003600000,"refreshCredential":"refresh-new",
            "registryHash":"registry-hash","bindingProtocolVersion":2,"bindingRevision":1,
            "bindingToken":"\(String(repeating: "t", count: 43))","bootstrapRequired":true}
            """
        )
    }

    static func refreshResponse(
        owner: String = "user-1",
        accessExpiresAt: Int64 = 1_725_007_200_000
    ) throws -> MobileDeviceRefreshResponse {
        try decode(
            MobileDeviceRefreshResponse.self,
            """
            {"ok":true,"device":\(deviceJSON(owner: owner)),"accessCredential":"access-refreshed",
            "accessExpiresAt":\(accessExpiresAt),"refreshCredential":"refresh-refreshed",
            "registryHash":"registry-hash"}
            """
        )
    }

    static func grant(action: MobileSensitiveAction) throws -> MobileSensitiveGrantResponse {
        let bindFields = action == .deviceBind
            ? ",\"bindingProtocolVersion\":2,\"bindAttempt\":{" +
                "\"receipt\":\"\(String(repeating: "r", count: 43))\"," +
                "\"expectedBindingRevision\":0,\"expectedRefreshGeneration\":0," +
                "\"expiresAt\":1725000030000}"
            : ""
        try decode(
            MobileSensitiveGrantResponse.self,
            """
            {"ok":true,"grant":"grant-secret","expiresAt":1725000030000,
            "action":"\(action.rawValue)","targetHash":"target-hash"\(bindFields)}
            """
        )
    }

    static func revokeResponse() throws -> MobileDeviceRevokeResponse {
        try decode(MobileDeviceRevokeResponse.self, "{\"ok\":true}")
    }

    static func changesResponse(cursor: Int64) throws -> MobileChangesResponse {
        try decode(
            MobileChangesResponse.self,
            "{\"ok\":true,\"fromCursor\":\(cursor),\"nextCursor\":\(cursor)," +
                "\"hasMore\":false,\"changes\":[]}"
        )
    }

    private static func deviceJSON(owner: String = "user-1") -> String {
        """
        {"deviceId":"\(deviceID)","ownerUserId":"\(owner)","deviceName":"Phone",
        "platform":"ios","appVersion":"2.3.4","tokenId":"token-1","enabled":true,
        "automaticEnabled":true,"syncIntervalSec":60,"createdAt":1725000000000}
        """
    }
}

private actor FakeBindingAPI: MobileBindingAPI {
    private var loginResponses: [MobileLoginResponse]
    private let totpResponse: MobileLoginResponse
    private var totpFailuresRemaining: Int
    private let capabilityResponse: MobileCapabilitiesResponse
    private let bindResult: MobileDeviceBindResponse
    private let refreshResult: MobileDeviceRefreshResponse
    private var calls = [String]()
    private var refreshDelayNanoseconds: UInt64 = 0
    private var capabilitiesError: MobileApiError?
    private var refreshError: MobileApiError?
    private var changesErrors = [MobileApiError]()
    private var bindErrors = [MobileApiError]()
    private var revokeErrors = [MobileApiError]()
    private var revocationVerifyGate: StartGate?
    private var bindingVerifyGate: StartGate?
    private var bindGate: StartGate?
    private var changesGate: StartGate?

    init(
        loginResponses: [MobileLoginResponse] = [.authenticated(session: BindingFixtures.session)],
        totpResponse: MobileLoginResponse = .authenticated(session: BindingFixtures.session),
        totpFailuresBeforeSuccess: Int = 0,
        refreshResult: MobileDeviceRefreshResponse? = nil
    ) throws {
        self.loginResponses = loginResponses
        self.totpResponse = totpResponse
        self.totpFailuresRemaining = totpFailuresBeforeSuccess
        self.capabilityResponse = try BindingFixtures.capabilities()
        self.bindResult = try BindingFixtures.bindResponse()
        if let refreshResult { self.refreshResult = refreshResult }
        else { self.refreshResult = try BindingFixtures.refreshResponse() }
    }

    func login(
        username: String,
        password: String,
        captchaToken: String?,
        remember: Bool
    ) async throws -> MobileLoginResponse {
        calls.append("login")
        guard !loginResponses.isEmpty else { throw MobileApiError.offline }
        return loginResponses.removeFirst()
    }

    func verifyTotp(tempToken: String, code: String) async throws -> MobileLoginResponse {
        calls.append("totp")
        if totpFailuresRemaining > 0 {
            totpFailuresRemaining -= 1
            throw MobileApiError.local(code: "totp_invalid", message: "Invalid TOTP")
        }
        return totpResponse
    }

    func logout(sid: String) async throws {
        calls.append("logout")
    }

    func capabilities() async throws -> MobileCapabilitiesResponse {
        calls.append("capabilities")
        if let capabilitiesError { throw capabilitiesError }
        return capabilityResponse
    }

    func verifySensitive(
        action: MobileSensitiveAction,
        secret: String,
        targetIds: [String],
        sid: String
    ) async throws -> MobileSensitiveGrantResponse {
        calls.append("verify." + action.rawValue)
        if action == .deviceRevoke, let revocationVerifyGate {
            await revocationVerifyGate.suspend()
        }
        if action == .deviceBind, let bindingVerifyGate {
            await bindingVerifyGate.suspend()
        }
        return try BindingFixtures.grant(action: action)
    }

    func bind(
        _ request: MobileDeviceBindRequest,
        sid: String,
        sensitiveGrant: String
    ) async throws -> MobileDeviceBindResponse {
        calls.append("bind")
        if let bindGate { await bindGate.suspend() }
        if !bindErrors.isEmpty { throw bindErrors.removeFirst() }
        return bindResult
    }

    func refresh(
        deviceId: String,
        refreshCredential: String
    ) async throws -> MobileDeviceRefreshResponse {
        calls.append("refresh")
        if let refreshError { throw refreshError }
        if refreshDelayNanoseconds > 0 {
            try await Task.sleep(nanoseconds: refreshDelayNanoseconds)
        }
        return refreshResult
    }

    func revokeDevice(
        deviceId: String,
        sid: String,
        sensitiveGrant: String
    ) async throws -> MobileDeviceRevokeResponse {
        calls.append("revoke")
        if !revokeErrors.isEmpty { throw revokeErrors.removeFirst() }
        return try BindingFixtures.revokeResponse()
    }

    func bootstrap(pageToken: String?, limit: Int?) async throws -> MobileBootstrapResponse {
        throw MobileApiError.offline
    }
    func changes(cursor: Int64, limit: Int?) async throws -> MobileChangesResponse {
        calls.append("changes")
        if let changesGate { await changesGate.suspend() }
        if !changesErrors.isEmpty { throw changesErrors.removeFirst() }
        return try BindingFixtures.changesResponse(cursor: cursor)
    }
    func push(_ request: MobilePushRequest) async throws -> MobilePushResponse {
        throw MobileApiError.offline
    }
    func ack(_ request: MobileAckRequest) async throws -> MobileAckResponse {
        throw MobileApiError.offline
    }

    func setRefreshDelayNanoseconds(_ value: UInt64) { refreshDelayNanoseconds = value }
    func setCapabilitiesError(_ error: MobileApiError?) { capabilitiesError = error }
    func setRefreshError(_ error: MobileApiError?) { refreshError = error }
    func enqueueChangesError(_ error: MobileApiError) { changesErrors.append(error) }
    func enqueueBindError(_ error: MobileApiError) { bindErrors.append(error) }
    func enqueueRevokeError(_ error: MobileApiError) { revokeErrors.append(error) }
    func setRevocationVerifyGate(_ gate: StartGate?) { revocationVerifyGate = gate }
    func setBindingVerifyGate(_ gate: StartGate?) { bindingVerifyGate = gate }
    func setBindGate(_ gate: StartGate?) { bindGate = gate }
    func setChangesGate(_ gate: StartGate?) { changesGate = gate }
    func recordedCalls() -> [String] { calls }
}

private actor FakeTokenLoader: MobileBindingTokenLoading {
    private let available: [MobileBindingToken]
    private var request: (sid: String, accountID: String)?

    init(tokens: [MobileBindingToken]) { self.available = tokens }

    func tokens(sid: String, accountID: String) async throws -> [MobileBindingToken] {
        request = (sid, accountID)
        return available
    }

    func lastRequest() -> (sid: String, accountID: String)? { request }
}

private final class FakeBindingRecordStore: MobileBindingRecordStoring, @unchecked Sendable {
    private let lock = NSLock()
    private let recorder: CleanupRecorder
    private var snapshot: MobileBindingRecordSnapshot?
    private var nextRecordVersion: UInt8 = 0
    private var loadFailuresRemaining = 0
    private var saveFailuresRemaining = 0
    private var lostReplacePhase: MobileBindingRecordPhase?
    private var lostReplaceWinner: MobileBindingRecord?

    init(recorder: CleanupRecorder) { self.recorder = recorder }

    func load() throws -> MobileBindingRecordSnapshot? {
        try synchronized {
            guard loadFailuresRemaining == 0 else {
                loadFailuresRemaining -= 1
                throw MobileBindingRecordStoreError.corruptRecord
            }
            return snapshot
        }
    }
    @discardableResult
    func insertIfAbsent(_ record: MobileBindingRecord) throws -> MobileBindingRecordSnapshot? {
        try synchronized {
            guard saveFailuresRemaining == 0 else {
                saveFailuresRemaining -= 1
                throw MobileBindingRecordStoreError.corruptRecord
            }
            guard snapshot == nil else { return nil }
            let inserted = makeSnapshot(record)
            snapshot = inserted
            return inserted
        }
    }

    @discardableResult
    func replace(
        _ record: MobileBindingRecord,
        expected: MobileBindingRecordSnapshot
    ) throws -> MobileBindingRecordSnapshot? {
        try synchronized {
            guard saveFailuresRemaining == 0 else {
                saveFailuresRemaining -= 1
                throw MobileBindingRecordStoreError.corruptRecord
            }
            if lostReplacePhase == record.phase {
                if let winner = lostReplaceWinner { snapshot = makeSnapshot(winner) }
                lostReplacePhase = nil
                lostReplaceWinner = nil
                return nil
            }
            guard snapshot == expected else { return nil }
            let replaced = makeSnapshot(record)
            snapshot = replaced
            return replaced
        }
    }

    @discardableResult
    func clear(expected: MobileBindingRecordSnapshot) throws -> Bool {
        let cleared = synchronized {
            guard snapshot == expected else { return false }
            snapshot = nil
            return true
        }
        if cleared { recorder.append("record") }
        return cleared
    }

    // Test setup can seed or simulate a separate process without weakening the
    // production protocol used by the coordinator.
    func save(_ record: MobileBindingRecord) throws {
        synchronized { snapshot = makeSnapshot(record) }
    }

    func clear() throws {
        let cleared = synchronized { () -> Bool in
            guard snapshot != nil else { return false }
            snapshot = nil
            return true
        }
        if cleared { recorder.append("record") }
    }

    func failNextLoad() { synchronized { loadFailuresRemaining += 1 } }
    func failNextSave() { synchronized { saveFailuresRemaining += 1 } }
    func loseNextReplace(
        to phase: MobileBindingRecordPhase,
        installing winner: MobileBindingRecord
    ) {
        synchronized {
            lostReplacePhase = phase
            lostReplaceWinner = winner
        }
    }

    private func makeSnapshot(_ record: MobileBindingRecord) -> MobileBindingRecordSnapshot {
        nextRecordVersion &+= 1
        return MobileBindingRecordSnapshot(
            record: record,
            recordVersion: MobileBindingRecordVersion(
                data: Data(repeating: nextRecordVersion, count: MobileBindingRecordVersion.byteCount)
            )
        )
    }

    private func synchronized<T>(_ operation: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try operation()
    }
}

private final class FakeBindingCredentials: MobileBindingCredentialStoring, @unchecked Sendable {
    private let lock = NSLock()
    private let recorder: CleanupRecorder?
    private var value: KeychainCredentials?
    private var lease: GenerationSideEffectLease?
    private var terminatedLease: GenerationSideEffectLease?
    private var fixtureSeeded = false
    private var removalFailuresRemaining = 0

    init(recorder: CleanupRecorder? = nil) { self.recorder = recorder }

    func credentials() throws -> KeychainCredentials? { synchronized { value } }
    func storeInitial(_ credentials: KeychainCredentials) throws {
        try synchronized {
            let fixtureLease = try Self.fixtureLease(identity: BindingFixtures.record().identity)
            lease = fixtureLease
            terminatedLease = nil
            fixtureSeeded = true
            value = credentials
        }
    }

    func activateLease(_ lease: GenerationSideEffectLease) throws {
        try synchronized {
            if let terminatedLease, terminatedLease.identity == lease.identity {
                throw KeychainCredentialStoreError.leaseTerminated
            }
            if let current = self.lease, current.identity != lease.identity {
                self.lease = nil
                self.terminatedLease = nil
                value = nil
            }
            guard self.lease == nil || self.lease == lease else {
                throw KeychainCredentialStoreError.staleLease
            }
            self.lease = lease
            fixtureSeeded = false
        }
    }

    func replaceLease(
        _ replacement: GenerationSideEffectLease,
        expected: GenerationSideEffectLease
    ) throws {
        try synchronized {
            guard replacement.identity == expected.identity else {
                throw KeychainCredentialStoreError.invalidLease
            }
            if lease == replacement { return }
            guard lease == expected else { throw KeychainCredentialStoreError.staleLease }
            lease = replacement
        }
    }

    func reconcileLease(
        _ replacement: GenerationSideEffectLease,
        replacing expected: GenerationSideEffectLease?
    ) throws {
        try synchronized {
            if terminatedLease == replacement { return }
            if let terminatedLease, terminatedLease.identity == replacement.identity {
                throw KeychainCredentialStoreError.leaseTerminated
            }
            if lease == replacement { return }
            if let expected, lease != expected {
                guard fixtureSeeded, lease?.identity == expected.identity else {
                    throw KeychainCredentialStoreError.staleLease
                }
            }
            lease = replacement
            fixtureSeeded = false
        }
    }

    func activeLease() throws -> GenerationSideEffectLease? {
        synchronized { terminatedLease == nil ? lease : nil }
    }

    func credentials(for lease: GenerationSideEffectLease) throws -> KeychainCredentials? {
        try synchronized {
            guard terminatedLease == nil else {
                throw KeychainCredentialStoreError.leaseTerminated
            }
            guard self.lease == lease else { throw KeychainCredentialStoreError.staleLease }
            return value
        }
    }

    func storeInitial(
        _ credentials: KeychainCredentials,
        for lease: GenerationSideEffectLease
    ) throws {
        try synchronized {
            guard self.lease == lease, terminatedLease == nil else {
                throw KeychainCredentialStoreError.staleLease
            }
            value = credentials
        }
    }

    func rotate(
        accessCredential: String,
        accessExpiresAtMilliseconds: Int64?,
        refreshCredential: String,
        for lease: GenerationSideEffectLease
    ) throws {
        try synchronized {
            guard self.lease == lease, terminatedLease == nil else {
                throw KeychainCredentialStoreError.staleLease
            }
            guard let current = value else { throw MobileBindingCoordinatorError.incompleteBinding }
            value = KeychainCredentials(
                accessCredential: accessCredential,
                accessExpiresAtMilliseconds: accessExpiresAtMilliseconds,
                refreshCredential: refreshCredential,
                sid: current.sid
            )
        }
    }
    func accessNeedsRefresh(
        nowMilliseconds: Int64,
        for lease: GenerationSideEffectLease
    ) throws -> Bool {
        try synchronized {
            guard self.lease == lease, terminatedLease == nil else {
                throw KeychainCredentialStoreError.staleLease
            }
            guard let value else { return true }
            return (value.accessExpiresAtMilliseconds ?? Int64.max) <= nowMilliseconds + 60_000
        }
    }

    func terminateLease(_ lease: GenerationSideEffectLease) throws {
        try synchronized {
            if removalFailuresRemaining > 0 {
                removalFailuresRemaining -= 1
                throw MobileBindingCoordinatorError.incompleteBinding
            }
            if terminatedLease == lease { return }
            guard self.lease == lease else { throw KeychainCredentialStoreError.staleLease }
            value = nil
            terminatedLease = lease
        }
        recorder?.append("credentials")
    }

    func removeAllGenerations() throws {
        synchronized {
            value = nil
            lease = nil
            terminatedLease = nil
        }
    }

    func failNextRemoval() { synchronized { removalFailuresRemaining += 1 } }

    func leaseForTests(identity: SyncBindingIdentity) throws -> GenerationSideEffectLease {
        try synchronized {
            if let lease, lease.identity == identity { return lease }
            let created = try Self.fixtureLease(identity: identity)
            lease = created
            terminatedLease = nil
            fixtureSeeded = true
            return created
        }
    }

    private static func fixtureLease(
        identity: SyncBindingIdentity
    ) throws -> GenerationSideEffectLease {
        try GenerationSideEffectLease(
            identity: identity,
            recordVersion: Data(repeating: 0xA5, count: MobileBindingRecordVersion.byteCount)
        )
    }

    private func synchronized<T>(_ operation: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try operation()
    }
}

private final class FakeBindingSigningIdentity: MobileBindingSigningIdentityManaging, @unchecked Sendable {
    let deviceID = BindingFixtures.deviceID
    private let recorder: CleanupRecorder
    var hasKey = false

    init(recorder: CleanupRecorder) { self.recorder = recorder }

    func ensureIdentity() throws -> DeviceSigningIdentity {
        hasKey = true
        return DeviceSigningIdentity(
            algorithm: "ES256",
            jwk: ["kty": "EC", "crv": "P-256", "x": "x", "y": "y"],
            protection: .softwareKeychain
        )
    }
    func hasIdentity() throws -> Bool { hasKey = true; return true }
    func deleteIdentity() throws { hasKey = false; recorder.append("signing") }
    func makeProofSigner() -> any DeviceProofSigning { FakeProofSigner() }
}

private struct FakeProofSigner: DeviceProofSigning {
    func sign(_ challenge: DeviceProofChallenge) throws -> String {
        Data(repeating: 1, count: 64).base64EncodedString()
    }
}

private enum FakeRuntimeCreationError: Error, Equatable {
    case failed
}

private final class FakeEncryptionIdentity: MobileEncryptionIdentityManaging, @unchecked Sendable {
    private let recorder: CleanupRecorder
    var deleted = false

    init(recorder: CleanupRecorder) { self.recorder = recorder }

    func publicIdentity(for identity: SyncBindingIdentity) throws -> MobileDeviceEncryptionKey {
        deleted = false
        return MobileDeviceEncryptionKey(
            publicKey: Data(repeating: 2, count: 1_184).base64EncodedString()
        )
    }
    func hasIdentity(for identity: SyncBindingIdentity) throws -> Bool { !deleted }
    func markMissing() { deleted = true }
    func deleteIdentity(for identity: SyncBindingIdentity) throws {
        deleted = true
        recorder.append("encryption")
    }
}

private final class FakeBindingEnvironment: MobileBindingEnvironment, @unchecked Sendable {
    private let api: FakeBindingAPI
    private let credentials: FakeBindingCredentials
    private let signing: FakeBindingSigningIdentity
    private let clock: FakeBindingClock
    private let recorder: CleanupRecorder
    private let startGate: StartGate?
    private let lock = NSLock()
    private var prepares = 0
    private var starts = 0
    private var repositoryPurgeAttempts = 0
    private var lastRepositoryPurgeIdentity: SyncBindingIdentity?
    private var repositoryPurgeFailuresRemaining = 0
    private var encryptedStorageEraseFailuresRemaining = 0
    private var encryptedStorageEraseAttempts = 0
    private var runtimeCreationFailuresRemaining = 0
    private var serverRevocationHandler: MobileServerRevocationHandler?
    private var repositorySnapshots = [String: SyncRepositorySnapshot]()
    private var repositoryHandles = [String: FakeBindingRepository]()
    private var fenceFailuresRemaining = 0
    private var publishFailuresRemaining = 0
    var forcedRepositoryIdentity: SyncBindingIdentity?
    var forcedRepositoryState: BindingState?

    var startCount: Int { synchronized { starts } }
    var prepareCount: Int { synchronized { prepares } }
    var repositoryPurgeAttemptCount: Int { synchronized { repositoryPurgeAttempts } }
    var repositoryPurgeIdentity: SyncBindingIdentity? { synchronized { lastRepositoryPurgeIdentity } }
    var encryptedStorageEraseAttemptCount: Int { synchronized { encryptedStorageEraseAttempts } }
    var repositoryOpenFails = false

    func repositoryState(for identity: SyncBindingIdentity) -> BindingState? {
        synchronized { repositorySnapshots[repositoryKey(identity)]?.bindingState }
    }

    func repositorySnapshot(for identity: SyncBindingIdentity) -> SyncRepositorySnapshot? {
        synchronized { repositorySnapshots[repositoryKey(identity)] }
    }

    func failNextRepositoryPurge() {
        synchronized { repositoryPurgeFailuresRemaining += 1 }
    }

    func failNextEncryptedStorageErase() {
        synchronized { encryptedStorageEraseFailuresRemaining += 1 }
    }

    func failNextRuntimeCreation() {
        synchronized { runtimeCreationFailuresRemaining += 1 }
    }

    func failNextFence() { synchronized { fenceFailuresRemaining += 1 } }
    func failNextPublish() { synchronized { publishFailuresRemaining += 1 } }

    func reportServerRevocation(_ reason: MobileServerRevocationReason) async {
        let handler = synchronized { serverRevocationHandler }
        await handler?(reason)
    }

    init(
        api: FakeBindingAPI,
        credentials: FakeBindingCredentials,
        signing: FakeBindingSigningIdentity,
        clock: FakeBindingClock,
        recorder: CleanupRecorder,
        startGate: StartGate?
    ) {
        self.api = api
        self.credentials = credentials
        self.signing = signing
        self.clock = clock
        self.recorder = recorder
        self.startGate = startGate
    }

    func prepare(
        record: MobileBindingRecord,
        repositoryIdentity: SyncBindingIdentity,
        restoring: Bool
    ) throws -> MobilePreparedBinding {
        synchronized { prepares += 1 }
        let openedIdentity: SyncBindingIdentity
        if let forcedRepositoryIdentity {
            openedIdentity = forcedRepositoryIdentity.bindingRecordVersion.isEmpty
                ? forcedRepositoryIdentity.replacingBindingRecordVersion(
                    repositoryIdentity.bindingRecordVersion
                )
                : forcedRepositoryIdentity
        } else {
            openedIdentity = repositoryIdentity
        }
        let existingRepository = restoring && !repositoryOpenFails
            ? makeRepositoryHandle(
                identity: openedIdentity,
                initialLeaseState: record.phase == .cleanupPending ? .fenced : .runnable,
                initialBindingState: forcedRepositoryState ?? .idle
            )
            : nil
        return MobilePreparedBinding(
            credentials: credentials,
            signingIdentity: signing,
            existingRepository: existingRepository,
            existingRepositoryStatus: restoring
                ? (repositoryOpenFails ? .invalid : .valid)
                : .notRequested,
            eraseEncryptedStorage: { [self] in
                let shouldFail = synchronized {
                    encryptedStorageEraseAttempts += 1
                    guard encryptedStorageEraseFailuresRemaining > 0 else { return false }
                    encryptedStorageEraseFailuresRemaining -= 1
                    return true
                }
                if shouldFail { throw FakeRuntimeCreationError.failed }
                synchronized {
                    repositorySnapshots.removeValue(forKey: repositoryKey(repositoryIdentity))
                    repositoryHandles.removeValue(forKey: repositoryKey(repositoryIdentity))
                }
                recorder.append("storageFallback")
            },
            makeRepository: { [self] identity in
                makeRepositoryHandle(
                    identity: identity,
                    initialLeaseState: .runnable,
                    initialBindingState: .idle
                )
            },
            cleanupFailedRuntimeCreation: { [self, recorder] cleanupIdentity in
                let repository = makeRepositoryHandle(
                    identity: cleanupIdentity,
                    initialLeaseState: .fenced,
                    initialBindingState: .idle
                )
                if let current = try await repository.snapshot(), current.identity != cleanupIdentity {
                    try await repository.fenceRuntime(
                        from: current.identity,
                        to: cleanupIdentity
                    )
                }
                try await repository.purgeAll(for: cleanupIdentity)
                recorder.append("partialRepository")
            },
            makeRuntime: {
                [self] finalRecord, sideEffectLease, runtimeIdentity, repository, handlers in
                let shouldFail = synchronized {
                    guard runtimeCreationFailuresRemaining > 0 else { return false }
                    runtimeCreationFailuresRemaining -= 1
                    return true
                }
                if shouldFail { throw FakeRuntimeCreationError.failed }
                let refresh = MobileAccessCredentialController(
                    api: api,
                    credentials: credentials,
                    lease: sideEffectLease,
                    identity: runtimeIdentity,
                    tokenID: finalRecord.tokenID,
                    appVersion: "2.3.4",
                    expectedRegistryHash: finalRecord.registryHash,
                    clock: clock
                )
                let engine = SyncEngine(
                    identity: runtimeIdentity,
                    transport: api,
                    repository: repository,
                    clock: clock,
                    serverRevocationHandler: handlers.serverRevocation
                )
                let scheduler = SyncScheduler(
                    identity: runtimeIdentity,
                    wakeTransport: FakeWakeTransport(),
                    clock: clock,
                    intervalSeconds: finalRecord.syncIntervalSeconds,
                    snapshotProvider: { try await repository.snapshot() },
                    syncRequest: { trigger in
                        let results = await engine.request(trigger)
                        return results.allSatisfy {
                            $0.termination != .failed &&
                                $0.termination != .bindingChanged &&
                                $0.termination != .cancelled &&
                                $0.termination != .notRunnable
                        }
                    },
                    syncCancellation: { _ in recorder.append("scheduler") },
                    serverRevocationHandler: handlers.serverRevocation
                )
                synchronized { self.serverRevocationHandler = handlers.serverRevocation }
                return MobileBindingRuntime(
                    summary: finalRecord.summary,
                    identity: runtimeIdentity,
                    syncRepository: repository,
                    credentials: credentials,
                    signingIdentity: signing,
                    managementAPI: api,
                    refreshController: refresh,
                    sideEffectLease: sideEffectLease,
                    engine: engine,
                    scheduler: scheduler,
                    connectivityMonitorFactory: nil,
                    startAction: {
                        if let startGate = self.startGate { await startGate.suspend() }
                        self.synchronized { self.starts += 1 }
                        return []
                    }
                )
            }
        )
    }

    private func makeRepositoryHandle(
        identity: SyncBindingIdentity,
        initialLeaseState: SyncRuntimeLeaseState,
        initialBindingState: BindingState
    ) -> FakeBindingRepository {
        let key = repositoryKey(identity)
        return synchronized {
            if let existing = repositoryHandles[key] { return existing }
            let initial = repositorySnapshots[key] ?? SyncRepositorySnapshot(
                identity: identity,
                runtimeLeaseState: initialLeaseState,
                bindingState: initialBindingState
            )
            repositorySnapshots[key] = initial
            let created = FakeBindingRepository(
                snapshot: initial,
                recorder: recorder,
                shouldFailFence: { [self] in
                    synchronized {
                        guard fenceFailuresRemaining > 0 else { return false }
                        fenceFailuresRemaining -= 1
                        return true
                    }
                },
                shouldFailPublish: { [self] in
                    synchronized {
                        guard publishFailuresRemaining > 0 else { return false }
                        publishFailuresRemaining -= 1
                        return true
                    }
                },
                shouldFailPurge: { [self] in
                    synchronized {
                        repositoryPurgeAttempts += 1
                        guard repositoryPurgeFailuresRemaining > 0 else { return false }
                        repositoryPurgeFailuresRemaining -= 1
                        return true
                    }
                },
                purgeDidRun: { [self] identity in
                    synchronized { lastRepositoryPurgeIdentity = identity }
                },
                snapshotDidChange: { [self] snapshot in
                    synchronized {
                        if let snapshot {
                            repositorySnapshots[key] = snapshot
                        } else {
                            repositorySnapshots.removeValue(forKey: key)
                            repositoryHandles.removeValue(forKey: key)
                        }
                    }
                }
            )
            repositoryHandles[key] = created
            return created
        }
    }

    private func repositoryKey(_ identity: SyncBindingIdentity) -> String {
        [identity.serverID, identity.accountID, identity.deviceID, identity.generation]
            .joined(separator: "\u{0}")
    }

    private func synchronized<T>(_ operation: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return operation()
    }
}

private actor FakeBindingRepository: MobileBindingSyncRepository {
    private var current: SyncRepositorySnapshot?
    private let recorder: CleanupRecorder
    private let shouldFailFence: @Sendable () -> Bool
    private let shouldFailPublish: @Sendable () -> Bool
    private let shouldFailPurge: @Sendable () -> Bool
    private let purgeDidRun: @Sendable (SyncBindingIdentity) -> Void
    private let snapshotDidChange: @Sendable (SyncRepositorySnapshot?) -> Void

    init(
        snapshot: SyncRepositorySnapshot,
        recorder: CleanupRecorder,
        shouldFailFence: @escaping @Sendable () -> Bool = { false },
        shouldFailPublish: @escaping @Sendable () -> Bool = { false },
        shouldFailPurge: @escaping @Sendable () -> Bool = { false },
        purgeDidRun: @escaping @Sendable (SyncBindingIdentity) -> Void = { _ in },
        snapshotDidChange: @escaping @Sendable (SyncRepositorySnapshot?) -> Void = { _ in }
    ) {
        self.current = snapshot
        self.recorder = recorder
        self.shouldFailFence = shouldFailFence
        self.shouldFailPublish = shouldFailPublish
        self.shouldFailPurge = shouldFailPurge
        self.purgeDidRun = purgeDidRun
        self.snapshotDidChange = snapshotDidChange
    }

    init(
        identity: SyncBindingIdentity,
        state: BindingState = .idle,
        recorder: CleanupRecorder
    ) {
        self.init(
            snapshot: SyncRepositorySnapshot(identity: identity, bindingState: state),
            recorder: recorder
        )
    }

    func snapshot() async throws -> SyncRepositorySnapshot? { current }
    func runnableSnapshot(for identity: SyncBindingIdentity) async throws -> SyncRepositorySnapshot? {
        guard let current, current.identity == identity,
              current.runtimeLeaseState == .runnable else { return nil }
        return current
    }
    func fenceRuntime(
        from currentIdentity: SyncBindingIdentity,
        to fencedIdentity: SyncBindingIdentity
    ) async throws {
        guard !shouldFailFence(), let value = current,
              value.identity == currentIdentity,
              fencedIdentity.hasSameBindingGeneration(as: currentIdentity),
              fencedIdentity.bindingRecordVersion != currentIdentity.bindingRecordVersion else {
            throw SQLiteSyncRepositoryError.bindingChanged
        }
        let replacement = replacing(value, identity: fencedIdentity, leaseState: .fenced)
        current = replacement
        snapshotDidChange(replacement)
    }
    func publishRuntime(
        from fencedIdentity: SyncBindingIdentity,
        to activeIdentity: SyncBindingIdentity
    ) async throws {
        guard !shouldFailPublish(), let value = current,
              value.identity == fencedIdentity, value.runtimeLeaseState == .fenced,
              activeIdentity.hasSameBindingGeneration(as: fencedIdentity),
              activeIdentity.bindingRecordVersion != fencedIdentity.bindingRecordVersion else {
            throw SQLiteSyncRepositoryError.bindingChanged
        }
        let replacement = replacing(value, identity: activeIdentity, leaseState: .runnable)
        current = replacement
        snapshotDidChange(replacement)
    }
    func recordAttempt(at milliseconds: Int64, for identity: SyncBindingIdentity) async throws {}
    func saveBindingState(_ state: BindingState, for identity: SyncBindingIdentity) async throws {
        guard let value = current, value.identity == identity,
              value.runtimeLeaseState == .runnable else {
            throw SQLiteSyncRepositoryError.bindingChanged
        }
        let replacement = replacing(value, bindingState: state)
        current = replacement
        snapshotDidChange(replacement)
    }
    func saveRegistryHash(_ hash: String, for identity: SyncBindingIdentity) async throws {}
    func resetBootstrap(for identity: SyncBindingIdentity) async throws {}
    func stageBootstrapPage(
        _ page: MobileBootstrapResponse,
        requestedPageToken: String?,
        stagingGeneration: String,
        continuation: SyncBootstrapCheckpoint?,
        for identity: SyncBindingIdentity
    ) async throws -> Int { page.entities.count }
    func commitBootstrap(
        stagingGeneration: String,
        snapshotCursor: Int64,
        for identity: SyncBindingIdentity
    ) async throws {}
    func pendingOperations(limit: Int, for identity: SyncBindingIdentity) async throws -> [MobileSyncOperation] { [] }
    func markDispatched(
        opIds: [String],
        batchId: String,
        at milliseconds: Int64,
        for identity: SyncBindingIdentity
    ) async throws {}
    func applyPushOutcomes(_ outcomes: [SyncPushOutcome], for identity: SyncBindingIdentity) async throws {}
    func applyChangePage(
        _ page: MobileChangesResponse,
        expectedCursor: Int64,
        for identity: SyncBindingIdentity
    ) async throws -> SyncApplyResult { SyncApplyResult(applied: 0, skipped: 0) }
    func saveAcknowledgedCursor(_ cursor: Int64, for identity: SyncBindingIdentity) async throws {}
    func recordSuccess(at milliseconds: Int64, for identity: SyncBindingIdentity) async throws {}
    func recordFailure(
        at milliseconds: Int64,
        error: MobileApiError,
        nextEligibleAtMilliseconds: Int64?,
        for identity: SyncBindingIdentity
    ) async throws {}
    func entity(type: String, id: String, for identity: SyncBindingIdentity) async throws -> SyncMirrorEntity? { nil }
    func entities(type: String, for identity: SyncBindingIdentity) async throws -> [SyncMirrorEntity] { [] }
    func conflicts(for identity: SyncBindingIdentity) async throws -> [SyncConflictRecord] { [] }
    func runState(for identity: SyncBindingIdentity) async throws -> SyncRunState {
        SyncRunState(
            lastAttemptAtMilliseconds: nil,
            lastSuccessAtMilliseconds: nil,
            lastErrorCode: nil,
            lastErrorDiagnostic: nil,
            consecutiveFailures: 0,
            nextEligibleAtMilliseconds: nil
        )
    }
    func writeLocal(
        _ write: SyncLocalWrite,
        for identity: SyncBindingIdentity
    ) async throws -> SyncMirrorEntity? { nil }
    func purgeEntity(type: String, id: String, for identity: SyncBindingIdentity) async throws {}
    func purgeAll(for identity: SyncBindingIdentity) async throws {
        guard let current, current.identity == identity else {
            throw SQLiteSyncRepositoryError.bindingChanged
        }
        if shouldFailPurge() {
            throw MobileBindingCoordinatorError.incompleteBinding
        }
        self.current = nil
        purgeDidRun(identity)
        snapshotDidChange(nil)
        recorder.append("repository")
    }

    private func replacing(
        _ snapshot: SyncRepositorySnapshot,
        identity: SyncBindingIdentity? = nil,
        leaseState: SyncRuntimeLeaseState? = nil,
        bindingState: BindingState? = nil
    ) -> SyncRepositorySnapshot {
        SyncRepositorySnapshot(
            identity: identity ?? snapshot.identity,
            runtimeLeaseState: leaseState ?? snapshot.runtimeLeaseState,
            bindingState: bindingState ?? snapshot.bindingState,
            appliedCursor: snapshot.appliedCursor,
            acknowledgedCursor: snapshot.acknowledgedCursor,
            snapshotCursor: snapshot.snapshotCursor,
            registryHash: snapshot.registryHash,
            consecutiveFailures: snapshot.consecutiveFailures,
            nextEligibleAtMilliseconds: snapshot.nextEligibleAtMilliseconds,
            bootstrapCheckpoint: snapshot.bootstrapCheckpoint
        )
    }
}

private actor FakeWakeTransport: WakeStreamTransport {
    func open(
        lastEventID: String?,
        onWake: @escaping @Sendable (WakeStreamEvent) async -> Void
    ) async -> WakeStreamOutcome {
        WakeStreamOutcome(failureCode: "cancelled")
    }
}

private actor ImmediateWakeTransport: WakeStreamTransport {
    private let outcome: WakeStreamOutcome

    init(outcome: WakeStreamOutcome) {
        self.outcome = outcome
    }

    func open(
        lastEventID: String?,
        onWake: @escaping @Sendable (WakeStreamEvent) async -> Void
    ) async -> WakeStreamOutcome {
        outcome
    }
}

private final class FakeBindingClock: MobileBindingClock, WakeSchedulingClock, @unchecked Sendable {
    private let now: Int64
    init(now: Int64) { self.now = now }
    func nowMilliseconds() -> Int64 { now }
    func sleep(forMilliseconds milliseconds: Int64) async throws { try Task.checkCancellation() }
}

private final class CleanupRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var entries = [String]()

    func append(_ value: String) {
        lock.lock()
        entries.append(value)
        lock.unlock()
    }
    func values() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return entries
    }
    func reset() {
        lock.lock()
        entries = []
        lock.unlock()
    }
}

private final class SequentialGenerationSource: @unchecked Sendable {
    private let lock = NSLock()
    private let values: [String]
    private var index = 0

    init(_ values: [String]) { self.values = values }

    func next() -> String {
        lock.lock()
        defer { lock.unlock() }
        guard !values.isEmpty else { return "" }
        let value = values[min(index, values.count - 1)]
        index += 1
        return value
    }
}

private final class BindingRevocationRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var reasons = [MobileServerRevocationReason]()

    func append(_ reason: MobileServerRevocationReason) {
        lock.lock()
        reasons.append(reason)
        lock.unlock()
    }

    func values() -> [MobileServerRevocationReason] {
        lock.lock()
        defer { lock.unlock() }
        return reasons
    }
}

private actor StartGate {
    private var suspended = false
    private var cancellationObserved = false
    private var released = false
    private var releaseContinuation: CheckedContinuation<Void, Never>?
    private var arrivalContinuations = [CheckedContinuation<Void, Never>]()
    private var cancellationContinuations = [CheckedContinuation<Void, Never>]()

    func suspend() async {
        suspended = true
        let arrivals = arrivalContinuations
        arrivalContinuations.removeAll(keepingCapacity: false)
        arrivals.forEach { $0.resume() }
        guard !released else { return }
        await withTaskCancellationHandler {
            await withCheckedContinuation { releaseContinuation = $0 }
        } onCancel: {
            Task { await self.observeCancellation() }
        }
    }

    func waitUntilSuspended() async {
        if suspended { return }
        await withCheckedContinuation { arrivalContinuations.append($0) }
    }

    func waitUntilCancelled() async {
        if cancellationObserved { return }
        await withCheckedContinuation { cancellationContinuations.append($0) }
    }

    func release() {
        released = true
        releaseContinuation?.resume()
        releaseContinuation = nil
    }

    private func observeCancellation() {
        cancellationObserved = true
        let continuations = cancellationContinuations
        cancellationContinuations.removeAll(keepingCapacity: false)
        continuations.forEach { $0.resume() }
    }
}

private func bindingEventually(
    attempts: Int = 2_000,
    _ condition: @escaping @Sendable () async -> Bool
) async -> Bool {
    for _ in 0..<attempts {
        if await condition() { return true }
        await Task.yield()
    }
    return false
}
