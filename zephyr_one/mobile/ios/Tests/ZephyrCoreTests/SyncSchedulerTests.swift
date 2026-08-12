import Foundation
import XCTest
@testable import ZephyrCore

final class SyncSchedulerTests: XCTestCase {
    func testForegroundStreamCoalescesDuplicateCursorUsesResumeIDAndServerRetry() async throws {
        let identity = schedulerIdentity()
        let state = SchedulerTestState(snapshot: schedulerSnapshot(identity: identity, cursor: 4))
        let transport = ScriptedWakeTransport(
            events: [
                WakeStreamEvent(cursor: 5, epoch: "epoch-a", reason: .change, eventID: "epoch-a:5"),
                WakeStreamEvent(cursor: 5, epoch: "epoch-a", reason: .change, eventID: "epoch-a:5"),
            ],
            outcome: WakeStreamOutcome(connected: true, serverRetryMilliseconds: 7_000)
        )
        let clock = RecordingWakeClock(immediateDelaysBelow: 30_000)
        let scheduler = makeScheduler(
            identity: identity,
            state: state,
            transport: transport,
            clock: clock
        )

        await scheduler.connectivityDidChange(ConnectivityStatus(isReachable: true))
        await scheduler.applicationDidEnterForeground()

        let reconnected = await eventually { await transport.openCount() >= 2 }
        let resumeIDs = await transport.lastEventIDs()
        let recoveryRecorded = await eventually { await state.recordedTriggers().contains(.recovery) }
        let triggers = await state.recordedTriggers()
        let delays = await clock.recordedDelays()
        XCTAssertTrue(reconnected)
        XCTAssertEqual([nil, "epoch-a:5"], resumeIDs.prefix(2).map { $0 })
        XCTAssertTrue(recoveryRecorded)
        XCTAssertEqual(1, triggers.filter { $0 == .recovery }.count)
        XCTAssertTrue(delays.contains(7_000))

        await scheduler.applicationDidEnterBackground()
        let streamCancelled = await eventually { await transport.cancellationCount() >= 1 }
        XCTAssertTrue(streamCancelled)
    }

    func testWakeQueuedBeforeInitialDrainRunsAsOneTrailingRecovery() async {
        let identity = schedulerIdentity()
        let state = SchedulerTestState(snapshot: schedulerSnapshot(identity: identity, cursor: 4))
        let gate = SchedulerSyncGate()
        let transport = ScriptedWakeTransport(
            events: [
                WakeStreamEvent(cursor: 5, epoch: "epoch-a", reason: .change, eventID: "epoch-a:5"),
                WakeStreamEvent(cursor: 6, epoch: "epoch-a", reason: .change, eventID: "epoch-a:6"),
            ],
            outcome: WakeStreamOutcome(connected: true, serverRetryMilliseconds: 7_000)
        )
        let scheduler = SyncScheduler(
            identity: identity,
            wakeTransport: transport,
            clock: RecordingWakeClock(immediateDelaysBelow: 30_000),
            intervalSeconds: 86_400,
            jitter: { 1 },
            snapshotProvider: { await state.currentSnapshot() },
            syncRequest: { trigger in await gate.run(trigger) }
        )

        await scheduler.connectivityDidChange(ConnectivityStatus(isReachable: true))
        await scheduler.applicationDidEnterForeground()

        let initialEntered = await eventually {
            let entered = await gate.hasEntered()
            let triggers = await gate.recordedTriggers()
            return entered && triggers == [.foreground]
        }
        XCTAssertTrue(initialEntered)
        let wakesQueuedWhileInitialWasBlocked = await eventually {
            await transport.openCount() >= 2
        }
        XCTAssertTrue(wakesQueuedWhileInitialWasBlocked)
        await gate.release(result: true)

        let trailingEntered = await eventually {
            let entered = await gate.hasEntered()
            let triggers = await gate.recordedTriggers()
            return entered && triggers == [.foreground, .recovery]
        }
        XCTAssertTrue(trailingEntered)
        await gate.release(result: true)

        let exactlyTwoRounds = await eventually {
            await gate.recordedTriggers() == [.foreground, .recovery]
        }
        XCTAssertTrue(exactlyTwoRounds)
        await scheduler.applicationDidEnterBackground()
    }

    func testCancelAndJoinStopsBindingWorkBeforeAccountReplacement() async {
        let identity = schedulerIdentity()
        let state = SchedulerTestState(snapshot: schedulerSnapshot(identity: identity, cursor: 1))
        let transport = ScriptedWakeTransport(events: [], outcome: WakeStreamOutcome(connected: true))
        let scheduler = makeScheduler(
            identity: identity,
            state: state,
            transport: transport,
            clock: RecordingWakeClock(immediateDelaysBelow: 0)
        )

        await scheduler.connectivityDidChange(ConnectivityStatus(isReachable: true))
        await scheduler.applicationDidEnterForeground()
        let opened = await eventually { await transport.openCount() >= 1 }
        XCTAssertTrue(opened)

        await scheduler.cancelAndJoin(reason: .accountSwitch)

        let cancellations = await state.recordedCancellations()
        let streamCancelled = await eventually { await transport.cancellationCount() >= 1 }
        XCTAssertEqual([.accountSwitch], cancellations)
        XCTAssertTrue(streamCancelled)
    }

    func testChangedOwnerDeviceOrGenerationCannotTriggerSync() async {
        let identity = schedulerIdentity()
        let replacement = SyncBindingIdentity(
            serverID: identity.serverID,
            accountID: "account-b",
            deviceID: "device-b",
            generation: "generation-b"
        )
        let state = SchedulerTestState(snapshot: schedulerSnapshot(identity: replacement, cursor: 9))
        let scheduler = makeScheduler(
            identity: identity,
            state: state,
            transport: ScriptedWakeTransport(events: [], outcome: WakeStreamOutcome()),
            clock: RecordingWakeClock(immediateDelaysBelow: 0)
        )

        let result = await scheduler.trigger(.silentPush, cursor: 10, for: identity)

        XCTAssertEqual(.staleBinding, result)
        let triggers = await state.recordedTriggers()
        let cancellations = await state.recordedCancellations()
        XCTAssertTrue(triggers.isEmpty)
        XCTAssertEqual([.accountSwitch], cancellations)
    }

    func testSameGenerationRecordVersionReplacementCannotTriggerSync() async {
        let identity = schedulerIdentity()
        let replacement = identity.replacingBindingRecordVersion(
            Data(repeating: 0x42, count: SyncBindingIdentity.bindingRecordVersionByteCount)
        )
        let state = SchedulerTestState(snapshot: schedulerSnapshot(identity: replacement, cursor: 9))
        let scheduler = makeScheduler(
            identity: identity,
            state: state,
            transport: ScriptedWakeTransport(events: [], outcome: WakeStreamOutcome()),
            clock: RecordingWakeClock(immediateDelaysBelow: 0)
        )

        let result = await scheduler.trigger(.silentPush, cursor: 10, for: identity)

        XCTAssertEqual(.staleBinding, result)
        let triggers = await state.recordedTriggers()
        let cancellations = await state.recordedCancellations()
        XCTAssertTrue(triggers.isEmpty)
        XCTAssertEqual([.accountSwitch], cancellations)
    }

    func testSchedulerRechecksRecordVersionAfterInflightSyncRequest() async {
        let identity = schedulerIdentity()
        let replacement = identity.replacingBindingRecordVersion(
            Data(repeating: 0x43, count: SyncBindingIdentity.bindingRecordVersionByteCount)
        )
        let state = SchedulerTestState(snapshot: schedulerSnapshot(identity: identity, cursor: 1))
        let gate = SchedulerSyncGate()
        let scheduler = SyncScheduler(
            identity: identity,
            wakeTransport: ScriptedWakeTransport(events: [], outcome: WakeStreamOutcome()),
            clock: RecordingWakeClock(immediateDelaysBelow: 0),
            snapshotProvider: { await state.currentSnapshot() },
            syncRequest: { trigger in await gate.run(trigger) },
            syncCancellation: { reason in await state.recordCancellation(reason) }
        )

        let request = Task {
            await scheduler.trigger(.silentPush, cursor: 2, for: identity)
        }
        let entered = await eventually { await gate.hasEntered() }
        XCTAssertTrue(entered)
        await state.replaceSnapshot(schedulerSnapshot(identity: replacement, cursor: 1))
        await gate.release(result: true)
        let result = await request.value

        XCTAssertEqual(.failed, result)
        let cancellations = await state.recordedCancellations()
        XCTAssertEqual([.accountSwitch], cancellations)
        let triggers = await gate.recordedTriggers()
        XCTAssertEqual([.recovery], triggers)
    }

    func testIntervalTickRechecksExactRecordVersionBeforeEnqueue() async {
        let identity = schedulerIdentity()
        let replacement = identity.replacingBindingRecordVersion(
            Data(repeating: 0x44, count: SyncBindingIdentity.bindingRecordVersionByteCount)
        )
        let state = SchedulerTestState(snapshot: schedulerSnapshot(identity: identity, cursor: 1))
        let clock = SchedulerTickClock()
        let scheduler = SyncScheduler(
            identity: identity,
            wakeTransport: ScriptedWakeTransport(events: [], outcome: WakeStreamOutcome()),
            clock: clock,
            intervalSeconds: 60,
            snapshotProvider: { await state.currentSnapshot() },
            syncRequest: { trigger in await state.record(trigger) },
            syncCancellation: { reason in await state.recordCancellation(reason) }
        )

        await scheduler.connectivityDidChange(ConnectivityStatus(isReachable: true))
        await scheduler.applicationDidEnterForeground()
        let ready = await eventually {
            let sleeping = await clock.isSleeping()
            let triggers = await state.recordedTriggers()
            return sleeping && triggers.contains(.foreground)
        }
        XCTAssertTrue(ready)
        await state.replaceSnapshot(schedulerSnapshot(identity: replacement, cursor: 1))
        await clock.release()

        let invalidated = await eventually {
            await state.recordedCancellations().contains(.accountSwitch)
        }
        XCTAssertTrue(invalidated)
        let triggers = await state.recordedTriggers()
        XCTAssertFalse(triggers.contains(.interval))
    }

    func testEveryBindingEndReasonCancelsThroughInjectedEngineBoundary() async {
        for reason in [
            SyncSchedulerCancellationReason.unbind,
            .revocation,
            .accountSwitch,
        ] {
            let identity = schedulerIdentity()
            let state = SchedulerTestState(snapshot: schedulerSnapshot(identity: identity, cursor: 0))
            let scheduler = makeScheduler(
                identity: identity,
                state: state,
                transport: ScriptedWakeTransport(events: [], outcome: WakeStreamOutcome()),
                clock: RecordingWakeClock(immediateDelaysBelow: 0)
            )

            await scheduler.cancelAndJoin(reason: reason)

            let cancellations = await state.recordedCancellations()
            XCTAssertEqual([reason], cancellations)
        }
    }

    func testTerminalWakeOutcomesReportTypedRevocationAndCancelAsRevoked() async {
        let terminalCases: [(String, MobileServerRevocationReason)] = [
            ("client_revoked", .clientRevoked),
            ("device_revoked", .deviceRevoked),
            ("account_unavailable", .accountUnavailable),
        ]

        for (code, expectedReason) in terminalCases {
            let identity = schedulerIdentity()
            let state = SchedulerTestState(snapshot: schedulerSnapshot(identity: identity, cursor: 0))
            let recorder = SchedulerRevocationRecorder()
            let scheduler = makeScheduler(
                identity: identity,
                state: state,
                transport: ScriptedWakeTransport(
                    events: [],
                    outcome: WakeStreamOutcome(failureCode: code)
                ),
                clock: RecordingWakeClock(immediateDelaysBelow: 0),
                serverRevocationHandler: {
                    await state.recordRevocationHandler()
                    recorder.append($0)
                }
            )

            await scheduler.connectivityDidChange(ConnectivityStatus(isReachable: true))
            await scheduler.applicationDidEnterForeground()

            let reported = await eventually { recorder.values() == [expectedReason] }
            let cancellations = await state.recordedCancellations()
            let revocationOrder = await state.recordedRevocationOrder()
            XCTAssertTrue(reported, "Expected a typed callback for \(code)")
            XCTAssertEqual([.revocation], cancellations)
            XCTAssertEqual(["isolate", "fence", "handler"], revocationOrder)
        }
    }

    func testTerminalWakeRetriesFailedDurableFenceBeforeReportingRevocation() async {
        let identity = schedulerIdentity()
        let state = SchedulerTestState(snapshot: schedulerSnapshot(identity: identity, cursor: 0))
        await state.failNextRevocationFence()
        let recorder = SchedulerRevocationRecorder()
        let clock = RecordingWakeClock(immediateDelaysBelow: 30_000)
        let scheduler = makeScheduler(
            identity: identity,
            state: state,
            transport: ScriptedWakeTransport(
                events: [],
                outcome: WakeStreamOutcome(failureCode: "device_revoked")
            ),
            clock: clock,
            serverRevocationHandler: {
                await state.recordRevocationHandler()
                recorder.append($0)
            }
        )

        await scheduler.connectivityDidChange(ConnectivityStatus(isReachable: true))
        await scheduler.applicationDidEnterForeground()

        let reported = await eventually { recorder.values() == [.deviceRevoked] }
        let fenceAttempts = await state.revocationFenceAttemptCount()
        let revocationOrder = await state.recordedRevocationOrder()
        let delays = await clock.recordedDelays()
        XCTAssertTrue(reported)
        XCTAssertEqual(2, fenceAttempts)
        XCTAssertEqual(["isolate", "fence", "handler"], revocationOrder)
        XCTAssertFalse(delays.isEmpty)
    }

    func testRefreshableWakeOutcomeDoesNotReportTerminalRevocation() async {
        let identity = schedulerIdentity()
        let state = SchedulerTestState(snapshot: schedulerSnapshot(identity: identity, cursor: 0))
        let transport = ScriptedWakeTransport(
            events: [],
            outcome: WakeStreamOutcome(failureCode: "access_credential_expired")
        )
        let recorder = SchedulerRevocationRecorder()
        let scheduler = makeScheduler(
            identity: identity,
            state: state,
            transport: transport,
            clock: RecordingWakeClock(immediateDelaysBelow: 30_000),
            serverRevocationHandler: { recorder.append($0) }
        )

        await scheduler.connectivityDidChange(ConnectivityStatus(isReachable: true))
        await scheduler.applicationDidEnterForeground()

        let reconnected = await eventually { await transport.openCount() >= 2 }
        let cancellations = await state.recordedCancellations()
        XCTAssertTrue(reconnected)
        XCTAssertTrue(recorder.values().isEmpty)
        XCTAssertTrue(cancellations.isEmpty)
        await scheduler.applicationDidEnterBackground()
    }

    func testRebindOnlyWakeOutcomesDoNotDestroyTheBinding() async {
        for code in ["token_missing", "token_rotated", "refresh_replayed"] {
            let identity = schedulerIdentity()
            let state = SchedulerTestState(snapshot: schedulerSnapshot(identity: identity, cursor: 0))
            let recorder = SchedulerRevocationRecorder()
            let transport = ScriptedWakeTransport(
                events: [],
                outcome: WakeStreamOutcome(failureCode: code)
            )
            let scheduler = makeScheduler(
                identity: identity,
                state: state,
                transport: transport,
                clock: RecordingWakeClock(immediateDelaysBelow: 30_000),
                serverRevocationHandler: { recorder.append($0) }
            )

            await scheduler.connectivityDidChange(ConnectivityStatus(isReachable: true))
            await scheduler.applicationDidEnterForeground()

            let reconnected = await eventually { await transport.openCount() >= 2 }
            let cancellations = await state.recordedCancellations()
            XCTAssertTrue(reconnected)
            XCTAssertTrue(recorder.values().isEmpty, "\(code) requires rebind, not destructive revocation")
            XCTAssertTrue(cancellations.isEmpty)
            await scheduler.applicationDidEnterBackground()
        }
    }

    private func makeScheduler(
        identity: SyncBindingIdentity,
        state: SchedulerTestState,
        transport: ScriptedWakeTransport,
        clock: RecordingWakeClock,
        serverRevocationHandler: @escaping MobileServerRevocationHandler = { _ in }
    ) -> SyncScheduler {
        SyncScheduler(
            identity: identity,
            wakeTransport: transport,
            clock: clock,
            intervalSeconds: 86_400,
            jitter: { 1 },
            snapshotProvider: { await state.currentSnapshot() },
            syncRequest: { trigger in await state.record(trigger) },
            syncCancellation: { reason in await state.recordCancellation(reason) },
            revocationFence: { try await state.persistRevocationFence() },
            serverRevocationHandler: serverRevocationHandler
        )
    }
}

private final class SchedulerRevocationRecorder: @unchecked Sendable {
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

private actor SchedulerTestState {
    private var snapshot: SyncRepositorySnapshot?
    private var triggers = [SyncTrigger]()
    private var cancellations = [SyncSchedulerCancellationReason]()
    private var revocationOrder = [String]()
    private var revocationFenceAttempts = 0
    private var revocationFenceFailuresRemaining = 0

    init(snapshot: SyncRepositorySnapshot?) {
        self.snapshot = snapshot
    }

    func currentSnapshot() -> SyncRepositorySnapshot? { snapshot }

    func replaceSnapshot(_ replacement: SyncRepositorySnapshot?) {
        snapshot = replacement
    }

    func record(_ trigger: SyncTrigger) -> Bool {
        triggers.append(trigger)
        return true
    }

    func recordCancellation(_ reason: SyncSchedulerCancellationReason) {
        cancellations.append(reason)
        if reason == .revocation { revocationOrder.append("isolate") }
    }

    func failNextRevocationFence() { revocationFenceFailuresRemaining += 1 }

    func persistRevocationFence() throws {
        revocationFenceAttempts += 1
        if revocationFenceFailuresRemaining > 0 {
            revocationFenceFailuresRemaining -= 1
            throw MobileBindingCoordinatorError.incompleteBinding
        }
        revocationOrder.append("fence")
        guard let current = snapshot else { return }
        snapshot = SyncRepositorySnapshot(
            identity: current.identity,
            runtimeLeaseState: current.runtimeLeaseState,
            bindingState: .revoked,
            appliedCursor: current.appliedCursor,
            acknowledgedCursor: current.acknowledgedCursor,
            snapshotCursor: current.snapshotCursor,
            registryHash: current.registryHash
        )
    }

    func recordRevocationHandler() { revocationOrder.append("handler") }

    func recordedTriggers() -> [SyncTrigger] { triggers }
    func recordedCancellations() -> [SyncSchedulerCancellationReason] { cancellations }
    func recordedRevocationOrder() -> [String] { revocationOrder }
    func revocationFenceAttemptCount() -> Int { revocationFenceAttempts }
}

private actor SchedulerSyncGate {
    private var triggers = [SyncTrigger]()
    private var continuation: CheckedContinuation<Bool, Never>?

    func run(_ trigger: SyncTrigger) async -> Bool {
        triggers.append(trigger)
        return await withCheckedContinuation { continuation = $0 }
    }

    func hasEntered() -> Bool { continuation != nil }

    func release(result: Bool) {
        continuation?.resume(returning: result)
        continuation = nil
    }

    func recordedTriggers() -> [SyncTrigger] { triggers }
}

private actor SchedulerTickClock: WakeSchedulingClock {
    private var continuation: CheckedContinuation<Void, Error>?

    func sleep(forMilliseconds milliseconds: Int64) async throws {
        try await withCheckedThrowingContinuation { continuation = $0 }
    }

    func isSleeping() -> Bool { continuation != nil }

    func release() {
        continuation?.resume()
        continuation = nil
    }
}

private actor ScriptedWakeTransport: WakeStreamTransport {
    private let firstEvents: [WakeStreamEvent]
    private let firstOutcome: WakeStreamOutcome
    private var opens = [String?]()
    private var cancellations = 0

    init(events: [WakeStreamEvent], outcome: WakeStreamOutcome) {
        self.firstEvents = events
        self.firstOutcome = outcome
    }

    func open(
        lastEventID: String?,
        onWake: @escaping @Sendable (WakeStreamEvent) async -> Void
    ) async -> WakeStreamOutcome {
        opens.append(lastEventID)
        if opens.count == 1, !firstEvents.isEmpty {
            for event in firstEvents { await onWake(event) }
            return firstOutcome
        }
        if opens.count == 1, firstOutcome.failureCode != nil {
            return firstOutcome
        }
        do {
            try await Task.sleep(nanoseconds: 60_000_000_000)
            return firstOutcome
        } catch {
            cancellations += 1
            return WakeStreamOutcome(failureCode: "cancelled")
        }
    }

    func openCount() -> Int { opens.count }
    func lastEventIDs() -> [String?] { opens }
    func cancellationCount() -> Int { cancellations }
}

private actor RecordingWakeClock: WakeSchedulingClock {
    private let immediateDelaysBelow: Int64
    private var delays = [Int64]()

    init(immediateDelaysBelow: Int64) {
        self.immediateDelaysBelow = immediateDelaysBelow
    }

    func sleep(forMilliseconds milliseconds: Int64) async throws {
        delays.append(milliseconds)
        if milliseconds < immediateDelaysBelow { return }
        try await Task.sleep(nanoseconds: 60_000_000_000)
    }

    func recordedDelays() -> [Int64] { delays }
}

private func schedulerIdentity() -> SyncBindingIdentity {
    SyncBindingIdentity(
        serverID: "server-a",
        accountID: "account-a",
        deviceID: "device-a",
        generation: "generation-a",
        bindingRecordVersion: Data(
            repeating: 0x41,
            count: SyncBindingIdentity.bindingRecordVersionByteCount
        )
    )
}

private func schedulerSnapshot(identity: SyncBindingIdentity, cursor: Int64) -> SyncRepositorySnapshot {
    SyncRepositorySnapshot(
        identity: identity,
        bindingState: .idle,
        appliedCursor: cursor,
        acknowledgedCursor: cursor
    )
}

private func eventually(
    attempts: Int = 2_000,
    _ condition: @escaping @Sendable () async -> Bool
) async -> Bool {
    for _ in 0..<attempts {
        if await condition() { return true }
        await Task.yield()
    }
    return false
}
