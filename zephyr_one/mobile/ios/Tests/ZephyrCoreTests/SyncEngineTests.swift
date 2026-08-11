import Foundation
import XCTest
@testable import ZephyrCore
import ZephyrContracts

final class SyncEngineTests: XCTestCase {
    func testNormalRoundPreservesOpIdsAndStoresStableConflictDetails() async throws {
        let identity = bindingIdentity(generation: "generation-7")
        let accepted = operation(opId: "op-accepted", entityId: "connection-1")
        let envelope = MobileSecretEnvelope(
            ct: "Y3Q=",
            iv: "aXY=",
            tag: "dGFn",
            data: "ZGF0YQ==",
            aad: "YWFk",
            keyVersion: 2,
            entityRevision: 4
        )
        let conflicted = MobileSyncOperation(
            opId: "op-conflict",
            entityType: "connection",
            entityId: "connection-2",
            action: .upsert,
            baseRevision: 4,
            fieldMask: ["name"],
            payload: ["name": .string("local")],
            secretEnvelopes: ["password": envelope]
        )
        let repository = FakeSyncRepository(identity: identity, state: .idle, operations: [accepted, conflicted])
        let transport = ScriptedSyncTransport()
        await transport.enqueuePush(
            decoded([
                "ok": true,
                "batchId": "batch-fixed",
                "serverCursor": 4,
                "results": [
                    [
                        "opId": "op-conflict",
                        "status": "conflict",
                        "entityId": "connection-2",
                        "revision": 9,
                        "conflict": [
                            "serverChangedFields": ["password"],
                            "serverPayload": ["name": "server"],
                        ],
                    ],
                    [
                        "opId": "op-accepted",
                        "status": "duplicate",
                        "entityId": "connection-1",
                        "revision": 5,
                    ],
                ],
                "changesAvailable": true,
            ])
        )
        await transport.enqueueChanges(changes(from: 0, next: 12))

        let engine = SyncEngine(
            identity: identity,
            transport: transport,
            repository: repository,
            clock: FakeSyncClock(1_000),
            jitter: { 1 },
            batchId: { "batch-fixed" },
            stagingGeneration: { "stage-fixed" }
        )

        let normalResults = await engine.request(.manual)
        let result = try XCTUnwrap(normalResults.first)

        XCTAssertEqual(.completed, result.termination)
        XCTAssertEqual(1, result.pushed)
        XCTAssertEqual(1, result.conflicts)
        XCTAssertEqual(12, result.appliedCursor)
        XCTAssertEqual(12, result.acknowledgedCursor)
        XCTAssertEqual(
            [.validateBinding, .pushPending, .pullChanges, .applyBlobs, .ackCursor, .commitSuccess],
            result.phasesRun
        )

        let requests = await transport.pushRequests()
        XCTAssertEqual(["op-accepted", "op-conflict"], requests.single?.operations.map(\.opId))
        XCTAssertEqual(envelope, requests.single?.operations.last?.secretEnvelopes?["password"])

        let outcomes = await repository.recordedPushOutcomes()
        XCTAssertEqual(["op-accepted", "op-conflict"], outcomes.single?.map(\.opId))
        guard case .conflicted(let conflict)? = outcomes.single?.last else {
            return XCTFail("Expected a durable conflict")
        }
        XCTAssertEqual("op-conflict", conflict.opId)
        XCTAssertEqual(["password"], conflict.overlapFields)
        XCTAssertEqual(envelope, conflict.localSecretEnvelopes["password"])
    }

    func testIncompleteBootstrapResumesItsDurablePageToken() async throws {
        let identity = bindingIdentity()
        let repository = FakeSyncRepository(identity: identity, state: .boundNeedsBootstrap)
        let transport = ScriptedSyncTransport()
        await transport.enqueueBootstrap(bootstrap(id: "boot-1", cursor: 20, token: "page-2", complete: false))
        await transport.enqueueBootstrap(bootstrap(id: "boot-1", cursor: 20, token: nil, complete: true))
        let clock = FakeSyncClock(5_000)
        let engine = SyncEngine(
            identity: identity,
            transport: transport,
            repository: repository,
            clock: clock,
            jitter: { 1 },
            batchId: { "batch-fixed" },
            stagingGeneration: { "stage-fixed" },
            maxPagesPerRound: 1
        )

        let firstResults = await engine.request(.manual)
        let first = try XCTUnwrap(firstResults.first)
        XCTAssertEqual(.bootstrapIncomplete, first.termination)
        XCTAssertEqual([.validateBinding, .bootstrapPage], first.phasesRun)
        let continuationPending = await engine.rerunPending()
        XCTAssertTrue(continuationPending)

        let secondResults = await engine.request(.recovery)
        let second = try XCTUnwrap(secondResults.first)
        XCTAssertEqual(.completed, second.termination)
        XCTAssertEqual(.complete, second.bootstrapOutcome)
        XCTAssertEqual(.recoverBootstrap, second.phasesRun[1])
        let requestedTokens = await transport.bootstrapTokens()
        XCTAssertEqual([nil, "page-2"], requestedTokens)
        XCTAssertEqual(20, second.acknowledgedCursor)
    }

    func testPlaintextSecretPayloadIsNeverSent() async throws {
        let identity = bindingIdentity()
        let unsafe = MobileSyncOperation(
            opId: "op-secret",
            entityType: "connection",
            entityId: "connection-1",
            action: .upsert,
            baseRevision: 1,
            fieldMask: ["name"],
            payload: ["password": .string("must-not-leave-device")]
        )
        let repository = FakeSyncRepository(identity: identity, state: .idle, operations: [unsafe])
        let transport = ScriptedSyncTransport()
        let engine = SyncEngine(
            identity: identity,
            transport: transport,
            repository: repository,
            clock: FakeSyncClock(1),
            jitter: { 1 }
        )

        _ = await engine.request(.manual)

        let requests = await transport.pushRequests()
        let outcomes = await repository.recordedPushOutcomes()
        XCTAssertTrue(requests.isEmpty)
        XCTAssertEqual("secret_plaintext_forbidden", outcomes.single?.single?.errorCode)
    }

    func testCursorExpiredImmediatelyRunsARebootstrapTail() async throws {
        let identity = bindingIdentity()
        let repository = FakeSyncRepository(identity: identity, state: .idle, appliedCursor: 40)
        let transport = ScriptedSyncTransport()
        await transport.enqueueChangesError(
            MobileApiError.local(code: "cursor_expired", message: "expired")
        )
        await transport.enqueueBootstrap(bootstrap(id: "boot-2", cursor: 50, token: nil, complete: true))

        let engine = SyncEngine(
            identity: identity,
            transport: transport,
            repository: repository,
            clock: FakeSyncClock(10_000),
            jitter: { 1 },
            batchId: { "batch-fixed" },
            stagingGeneration: { "stage-fixed" }
        )
        let results = await engine.request(.interval)

        XCTAssertEqual(2, results.count)
        XCTAssertEqual("cursor_expired", results[0].error?.code)
        XCTAssertEqual(.boundNeedsBootstrap, results[0].endState)
        XCTAssertEqual(.recovery, results[1].trigger)
        XCTAssertEqual(.completed, results[1].termination)
        XCTAssertEqual(.idle, results[1].endState)
        let resetCount = await repository.bootstrapResetCount()
        XCTAssertGreaterThanOrEqual(resetCount, 1)
    }

    func testOverlappingTriggerCoalescesIntoOneTrailingRound() async throws {
        let identity = bindingIdentity()
        let repository = FakeSyncRepository(identity: identity, state: .idle)
        let transport = ScriptedSyncTransport(blockFirstCapabilities: true)
        let engine = SyncEngine(
            identity: identity,
            transport: transport,
            repository: repository,
            clock: FakeSyncClock(1),
            jitter: { 1 }
        )

        let first = Task { await engine.request(.manual) }
        await waitUntil { await transport.capabilitiesAreBlocked() }
        let absorbed = await engine.request(.localWrite)
        XCTAssertTrue(absorbed.isEmpty)
        await transport.releaseCapabilities()
        let results = await first.value

        XCTAssertEqual([.manual, .localWrite], results.map(\.trigger))
        let capabilitiesCalls = await transport.capabilitiesCallCount()
        let rerunPending = await engine.rerunPending()
        XCTAssertEqual(2, capabilitiesCalls)
        XCTAssertFalse(rerunPending)
    }

    func testChangedGenerationCannotApplyNetworkResponse() async throws {
        let identity = bindingIdentity()
        let repository = FakeSyncRepository(identity: identity, state: .idle)
        let transport = ScriptedSyncTransport(blockFirstChanges: true)
        let engine = SyncEngine(
            identity: identity,
            transport: transport,
            repository: repository,
            clock: FakeSyncClock(1),
            jitter: { 1 }
        )

        let task = Task { await engine.request(.manual) }
        await waitUntil { await transport.changesAreBlocked() }
        await repository.replaceIdentity(
            SyncBindingIdentity(
                serverID: "server-1",
                accountID: "account-2",
                deviceID: "device-2",
                generation: "generation-2"
            )
        )
        await transport.releaseChanges()
        let taskResults = await task.value
        let result = try XCTUnwrap(taskResults.first)

        XCTAssertEqual(.bindingChanged, result.termination)
        let appliedPages = await repository.appliedPageCount()
        XCTAssertEqual(0, appliedPages)
    }

    func testSameGenerationNewRecordVersionRejectsInflightResponse() async throws {
        let identity = bindingIdentity()
        let replacement = identity.replacingBindingRecordVersion(
            Data(repeating: 0x22, count: SyncBindingIdentity.bindingRecordVersionByteCount)
        )
        let repository = FakeSyncRepository(identity: identity, state: .idle)
        let transport = ScriptedSyncTransport(blockFirstChanges: true)
        let engine = SyncEngine(
            identity: identity,
            transport: transport,
            repository: repository,
            clock: FakeSyncClock(1),
            jitter: { 1 }
        )

        let task = Task { await engine.request(.manual) }
        await waitUntil { await transport.changesAreBlocked() }
        await repository.replaceIdentity(replacement)
        await transport.releaseChanges()
        let results = await task.value
        let result = try XCTUnwrap(results.first)

        XCTAssertEqual(.bindingChanged, result.termination)
        XCTAssertEqual(identity.generation, replacement.generation)
        let appliedPages = await repository.appliedPageCount()
        XCTAssertEqual(0, appliedPages)
    }

    func testRevocationCancelsBlockedTransportAndDoesNotRecordFailure() async throws {
        let identity = bindingIdentity()
        let repository = FakeSyncRepository(identity: identity, state: .idle)
        let transport = ScriptedSyncTransport(blockFirstChanges: true)
        let engine = SyncEngine(
            identity: identity,
            transport: transport,
            repository: repository,
            clock: FakeSyncClock(1),
            jitter: { 1 }
        )

        let task = Task { await engine.request(.manual) }
        await waitUntil { await transport.changesAreBlocked() }
        await engine.cancelForRevocation(identity)
        let taskResults = await task.value
        let result = try XCTUnwrap(taskResults.first)

        XCTAssertEqual(.cancelled, result.termination)
        let failures = await repository.failureCount()
        let appliedPages = await repository.appliedPageCount()
        XCTAssertEqual(0, failures)
        XCTAssertEqual(0, appliedPages)
    }

    func testTerminalServerErrorsReportTypedRevocationAndAccessExpiryDoesNot() async throws {
        let terminalCases: [(String, MobileServerRevocationReason)] = [
            ("client_revoked", .clientRevoked),
            ("device_revoked", .deviceRevoked),
            ("account_unavailable", .accountUnavailable),
        ]

        for (code, expectedReason) in terminalCases {
            let identity = bindingIdentity()
            let repository = FakeSyncRepository(identity: identity, state: .idle)
            let transport = ScriptedSyncTransport()
            await transport.enqueueCapabilitiesError(.local(code: code, message: "terminal"))
            let recorder = SyncRevocationRecorder()
            let engine = SyncEngine(
                identity: identity,
                transport: transport,
                repository: repository,
                clock: FakeSyncClock(1),
                jitter: { 1 },
                serverRevocationHandler: { recorder.append($0) }
            )

            let results = await engine.request(.manual)

            XCTAssertEqual(code, results.single?.error?.code)
            XCTAssertEqual([expectedReason], recorder.values())
        }

        for code in [
            "access_expired", "access_credential_expired", "access_credential_invalid",
            "wake_unauthorized", "token_refresh_failed", "token_missing", "token_rotated",
            "refresh_replayed",
        ] {
            XCTAssertNil(MobileServerRevocationReason(errorCode: code))
        }
    }

    func testTerminalServerCallbackIsAwaitedBeforeRequestReturns() async throws {
        let identity = bindingIdentity()
        let repository = FakeSyncRepository(identity: identity, state: .idle)
        let transport = ScriptedSyncTransport()
        await transport.enqueueCapabilitiesError(
            .local(code: "device_revoked", message: "terminal")
        )
        let gate = SyncRevocationGate()
        let completion = SyncCompletionFlag()
        let engine = SyncEngine(
            identity: identity,
            transport: transport,
            repository: repository,
            clock: FakeSyncClock(1),
            jitter: { 1 },
            serverRevocationHandler: { reason in await gate.handle(reason) }
        )

        let request = Task {
            let results = await engine.request(.manual)
            completion.markCompleted()
            return results
        }
        await gate.waitUntilEntered()

        let reportedReason = await gate.reportedReason()
        XCTAssertEqual(reportedReason, .deviceRevoked)
        XCTAssertFalse(completion.isCompleted())
        await gate.release()
        let results = await request.value
        XCTAssertEqual(results.single?.error?.code, "device_revoked")
        XCTAssertTrue(completion.isCompleted())
    }

    func testRetryAfterWinsAndBackoffJitterIsDeterministic() async throws {
        let retryAfter = MobileApiError(
            code: "rate_limited",
            message: "wait",
            retryable: true,
            requestId: nil,
            retryAfterSeconds: 17
        )
        XCTAssertEqual(
            17_000,
            SyncRetryPolicy.delayMilliseconds(for: retryAfter, consecutiveFailures: 6, jitter: 0.5)
        )

        let retryable = MobileApiError.local(code: "server_unavailable", message: "down", retryable: true)
        XCTAssertEqual(
            500,
            SyncRetryPolicy.delayMilliseconds(for: retryable, consecutiveFailures: 0, jitter: 0.1)
        )
        XCTAssertEqual(
            90_000,
            SyncRetryPolicy.delayMilliseconds(for: retryable, consecutiveFailures: 6, jitter: 1.5)
        )

        let identity = bindingIdentity()
        let repository = FakeSyncRepository(identity: identity, state: .idle)
        let transport = ScriptedSyncTransport()
        await transport.enqueueCapabilitiesError(retryAfter)
        let engine = SyncEngine(
            identity: identity,
            transport: transport,
            repository: repository,
            clock: FakeSyncClock(1_000),
            jitter: { 0.5 }
        )

        _ = await engine.request(.interval)
        let nextEligible = await repository.nextEligibleAt()
        XCTAssertEqual(18_000, nextEligible)
    }
}

private final class FakeSyncClock: SyncClock, @unchecked Sendable {
    private let lock = NSLock()
    private var now: Int64

    init(_ now: Int64) { self.now = now }

    func nowMilliseconds() -> Int64 {
        lock.lock()
        defer { lock.unlock() }
        return now
    }

    func advance(by milliseconds: Int64) {
        lock.lock()
        now += milliseconds
        lock.unlock()
    }
}

private actor ScriptedSyncTransport: SyncTransport {
    private let capabilitiesValue: MobileCapabilitiesResponse = decoded([
        "ok": true,
        "protocolVersions": [1],
        "registryHash": "registry-1",
        "limits": [:],
        "auth": [:],
    ])
    private var capabilityErrors: [MobileApiError] = []
    private var bootstrapPages: [MobileBootstrapResponse] = []
    private var changeScripts: [Result<MobileChangesResponse, MobileApiError>] = []
    private var pushResponsesQueue: [MobilePushResponse] = []
    private var recordedBootstrapTokens: [String?] = []
    private var recordedPushRequests: [MobilePushRequest] = []
    private var capabilitiesCalls = 0
    private var blockCapabilities: Bool
    private var blockChanges: Bool
    private var capabilitiesContinuation: CheckedContinuation<Void, Never>?
    private var changesContinuation: CheckedContinuation<Void, Never>?

    init(blockFirstCapabilities: Bool = false, blockFirstChanges: Bool = false) {
        blockCapabilities = blockFirstCapabilities
        blockChanges = blockFirstChanges
    }

    func enqueueCapabilitiesError(_ error: MobileApiError) { capabilityErrors.append(error) }
    func enqueueBootstrap(_ page: MobileBootstrapResponse) { bootstrapPages.append(page) }
    func enqueueChanges(_ page: MobileChangesResponse) { changeScripts.append(.success(page)) }
    func enqueueChangesError(_ error: MobileApiError) { changeScripts.append(.failure(error)) }
    func enqueuePush(_ response: MobilePushResponse) { pushResponsesQueue.append(response) }

    func capabilities() async throws -> MobileCapabilitiesResponse {
        capabilitiesCalls += 1
        if blockCapabilities {
            blockCapabilities = false
            await withTaskCancellationHandler {
                await withCheckedContinuation { capabilitiesContinuation = $0 }
            } onCancel: {
                Task { await self.releaseCapabilities() }
            }
            try Task.checkCancellation()
        }
        if !capabilityErrors.isEmpty { throw capabilityErrors.removeFirst() }
        return capabilitiesValue
    }

    func bootstrap(pageToken: String?, limit: Int?) async throws -> MobileBootstrapResponse {
        recordedBootstrapTokens.append(pageToken)
        guard !bootstrapPages.isEmpty else {
            throw MobileApiError.local(code: "internal_error", message: "No bootstrap page scripted")
        }
        return bootstrapPages.removeFirst()
    }

    func changes(cursor: Int64, limit: Int?) async throws -> MobileChangesResponse {
        if blockChanges {
            blockChanges = false
            await withTaskCancellationHandler {
                await withCheckedContinuation { changesContinuation = $0 }
            } onCancel: {
                Task { await self.releaseChanges() }
            }
            try Task.checkCancellation()
        }
        if changeScripts.isEmpty { return changes(from: cursor, next: cursor) }
        return try changeScripts.removeFirst().get()
    }

    func push(_ request: MobilePushRequest) async throws -> MobilePushResponse {
        recordedPushRequests.append(request)
        if !pushResponsesQueue.isEmpty { return pushResponsesQueue.removeFirst() }
        return decoded([
            "ok": true,
            "batchId": request.batchId,
            "serverCursor": request.baseCursor,
            "results": [],
            "changesAvailable": false,
        ])
    }

    func ack(_ request: MobileAckRequest) async throws -> MobileAckResponse {
        decoded(["ok": true])
    }

    func capabilitiesAreBlocked() -> Bool { capabilitiesContinuation != nil }
    func changesAreBlocked() -> Bool { changesContinuation != nil }
    func capabilitiesCallCount() -> Int { capabilitiesCalls }
    func bootstrapTokens() -> [String?] { recordedBootstrapTokens }
    func pushRequests() -> [MobilePushRequest] { recordedPushRequests }

    func releaseCapabilities() {
        let continuation = capabilitiesContinuation
        capabilitiesContinuation = nil
        continuation?.resume()
    }

    func releaseChanges() {
        let continuation = changesContinuation
        changesContinuation = nil
        continuation?.resume()
    }
}

private actor FakeSyncRepository: SyncRepository {
    private var value: SyncRepositorySnapshot
    private var operations: [MobileSyncOperation]
    private var pushOutcomes: [[SyncPushOutcome]] = []
    private var appliedPages = 0
    private var resetCount = 0
    private var failures: [MobileApiError] = []

    init(
        identity: SyncBindingIdentity,
        state: BindingState,
        appliedCursor: Int64 = 0,
        operations: [MobileSyncOperation] = []
    ) {
        value = SyncRepositorySnapshot(
            identity: identity,
            bindingState: state,
            appliedCursor: appliedCursor,
            acknowledgedCursor: 0,
            snapshotCursor: 0,
            registryHash: "registry-1"
        )
        self.operations = operations
    }

    func snapshot() async throws -> SyncRepositorySnapshot? { value }

    func recordAttempt(at milliseconds: Int64, for identity: SyncBindingIdentity) async throws {
        try check(identity)
    }

    func saveBindingState(_ state: BindingState, for identity: SyncBindingIdentity) async throws {
        try check(identity)
        update(bindingState: state)
    }

    func saveRegistryHash(_ hash: String, for identity: SyncBindingIdentity) async throws {
        try check(identity)
        update(registryHash: hash)
    }

    func resetBootstrap(for identity: SyncBindingIdentity) async throws {
        try check(identity)
        resetCount += 1
        update(bootstrapCheckpoint: .some(nil))
    }

    func stageBootstrapPage(
        _ page: MobileBootstrapResponse,
        requestedPageToken: String?,
        stagingGeneration: String,
        continuation: SyncBootstrapCheckpoint?,
        for identity: SyncBindingIdentity
    ) async throws -> Int {
        try check(identity)
        update(snapshotCursor: page.snapshotCursor, bootstrapCheckpoint: .some(continuation))
        return page.entities.count
    }

    func commitBootstrap(
        stagingGeneration: String,
        snapshotCursor: Int64,
        for identity: SyncBindingIdentity
    ) async throws {
        try check(identity)
        update(
            bindingState: .catchingUp,
            appliedCursor: snapshotCursor,
            snapshotCursor: snapshotCursor,
            bootstrapCheckpoint: .some(nil)
        )
    }

    func pendingOperations(limit: Int, for identity: SyncBindingIdentity) async throws -> [MobileSyncOperation] {
        try check(identity)
        return Array(operations.prefix(limit))
    }

    func markDispatched(
        opIds: [String],
        batchId: String,
        at milliseconds: Int64,
        for identity: SyncBindingIdentity
    ) async throws {
        try check(identity)
    }

    func applyPushOutcomes(_ outcomes: [SyncPushOutcome], for identity: SyncBindingIdentity) async throws {
        try check(identity)
        pushOutcomes.append(outcomes)
        let removed = Set(outcomes.compactMap { outcome -> String? in
            switch outcome {
            case .completed(let opId, _, _, _):
                return opId
            case .conflicted(let conflict):
                return conflict.opId
            case .failed(let opId, _, let drop):
                return drop ? opId : nil
            }
        })
        operations.removeAll { removed.contains($0.opId) }
    }

    func applyChangePage(
        _ page: MobileChangesResponse,
        expectedCursor: Int64,
        for identity: SyncBindingIdentity
    ) async throws -> SyncApplyResult {
        try check(identity)
        guard value.appliedCursor == expectedCursor, page.fromCursor == expectedCursor else {
            throw FakeError.stale
        }
        appliedPages += 1
        update(appliedCursor: page.nextCursor)
        return SyncApplyResult(applied: page.changes.count, skipped: 0)
    }

    func saveAcknowledgedCursor(_ cursor: Int64, for identity: SyncBindingIdentity) async throws {
        try check(identity)
        update(acknowledgedCursor: cursor)
    }

    func recordSuccess(at milliseconds: Int64, for identity: SyncBindingIdentity) async throws {
        try check(identity)
        update(consecutiveFailures: 0, nextEligibleAt: .some(nil))
    }

    func recordFailure(
        at milliseconds: Int64,
        error: MobileApiError,
        nextEligibleAtMilliseconds: Int64?,
        for identity: SyncBindingIdentity
    ) async throws {
        try check(identity)
        failures.append(error)
        update(
            consecutiveFailures: value.consecutiveFailures + 1,
            nextEligibleAt: .some(nextEligibleAtMilliseconds)
        )
    }

    func replaceIdentity(_ identity: SyncBindingIdentity) {
        update(identity: identity)
    }

    func recordedPushOutcomes() -> [[SyncPushOutcome]] { pushOutcomes }
    func appliedPageCount() -> Int { appliedPages }
    func bootstrapResetCount() -> Int { resetCount }
    func failureCount() -> Int { failures.count }
    func nextEligibleAt() -> Int64? { value.nextEligibleAtMilliseconds }

    private func check(_ identity: SyncBindingIdentity) throws {
        guard value.identity == identity else { throw FakeError.stale }
    }

    private func update(
        identity: SyncBindingIdentity? = nil,
        bindingState: BindingState? = nil,
        appliedCursor: Int64? = nil,
        acknowledgedCursor: Int64? = nil,
        snapshotCursor: Int64? = nil,
        registryHash: String? = nil,
        consecutiveFailures: Int? = nil,
        nextEligibleAt: Int64?? = nil,
        bootstrapCheckpoint: SyncBootstrapCheckpoint?? = nil
    ) {
        value = SyncRepositorySnapshot(
            identity: identity ?? value.identity,
            runtimeLeaseState: value.runtimeLeaseState,
            bindingState: bindingState ?? value.bindingState,
            appliedCursor: appliedCursor ?? value.appliedCursor,
            acknowledgedCursor: acknowledgedCursor ?? value.acknowledgedCursor,
            snapshotCursor: snapshotCursor ?? value.snapshotCursor,
            registryHash: registryHash ?? value.registryHash,
            consecutiveFailures: consecutiveFailures ?? value.consecutiveFailures,
            nextEligibleAtMilliseconds: nextEligibleAt ?? value.nextEligibleAtMilliseconds,
            bootstrapCheckpoint: bootstrapCheckpoint ?? value.bootstrapCheckpoint
        )
    }

    private enum FakeError: Error { case stale }
}

private extension Array {
    var single: Element? { count == 1 ? first : nil }
}

private final class SyncRevocationRecorder: @unchecked Sendable {
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

private actor SyncRevocationGate {
    private var reason: MobileServerRevocationReason?
    private var released = false
    private var releaseContinuation: CheckedContinuation<Void, Never>?
    private var entryContinuations = [CheckedContinuation<Void, Never>]()

    func handle(_ reason: MobileServerRevocationReason) async {
        self.reason = reason
        let entries = entryContinuations
        entryContinuations.removeAll(keepingCapacity: false)
        entries.forEach { $0.resume() }
        guard !released else { return }
        await withCheckedContinuation { releaseContinuation = $0 }
    }

    func waitUntilEntered() async {
        if reason != nil { return }
        await withCheckedContinuation { entryContinuations.append($0) }
    }

    func reportedReason() -> MobileServerRevocationReason? { reason }

    func release() {
        released = true
        releaseContinuation?.resume()
        releaseContinuation = nil
    }
}

private final class SyncCompletionFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var completed = false

    func markCompleted() {
        lock.lock()
        completed = true
        lock.unlock()
    }

    func isCompleted() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return completed
    }
}

private func waitUntil(_ predicate: @escaping () async -> Bool) async {
    for _ in 0..<1_000 {
        if await predicate() { return }
        await Task.yield()
    }
}

private func operation(opId: String, entityId: String) -> MobileSyncOperation {
    MobileSyncOperation(
        opId: opId,
        entityType: "connection",
        entityId: entityId,
        action: .upsert,
        baseRevision: 1,
        fieldMask: ["name"],
        payload: ["name": .string("value")]
    )
}

private func bindingIdentity(generation: String = "generation-1") -> SyncBindingIdentity {
    SyncBindingIdentity(
        serverID: "server-1",
        accountID: "account-1",
        deviceID: "device-1",
        generation: generation,
        bindingRecordVersion: Data(repeating: 0x11, count: SyncBindingIdentity.bindingRecordVersionByteCount)
    )
}

private func bootstrap(
    id: String,
    cursor: Int64,
    token: String?,
    complete: Bool
) -> MobileBootstrapResponse {
    var object: [String: Any] = [
        "ok": true,
        "bootstrapId": id,
        "snapshotCursor": cursor,
        "complete": complete,
        "entities": [],
    ]
    object["nextPageToken"] = token ?? NSNull()
    return decoded(object)
}

private func changes(from: Int64, next: Int64) -> MobileChangesResponse {
    decoded([
        "ok": true,
        "fromCursor": from,
        "nextCursor": next,
        "hasMore": false,
        "changes": [],
    ])
}

private func decoded<Value: Decodable>(_ object: Any) -> Value {
    let data = try! JSONSerialization.data(withJSONObject: object)
    return try! JSONDecoder().decode(Value.self, from: data)
}
