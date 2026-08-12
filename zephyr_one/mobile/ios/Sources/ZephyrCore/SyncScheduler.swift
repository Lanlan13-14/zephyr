import Foundation
import ZephyrContracts

public protocol WakeSchedulingClock: Sendable {
    func sleep(forMilliseconds milliseconds: Int64) async throws
}

public struct SystemWakeSchedulingClock: WakeSchedulingClock {
    public init() {}

    public func sleep(forMilliseconds milliseconds: Int64) async throws {
        guard milliseconds > 0 else {
            try Task.checkCancellation()
            return
        }
        let bounded = min(milliseconds, Int64.max / 1_000_000)
        try await Task.sleep(nanoseconds: UInt64(bounded) * 1_000_000)
    }
}

public enum WakeReconnectPolicy {
    public static let maximumDelayMilliseconds: Int64 = 15 * 60 * 1_000

    public static func delayMilliseconds(
        outcome: WakeStreamOutcome,
        consecutiveFailures: Int,
        jitter: Double
    ) -> Int64 {
        if let retryAfter = outcome.retryAfterMilliseconds {
            return min(max(100, retryAfter), maximumDelayMilliseconds)
        }
        if let serverRetry = outcome.serverRetryMilliseconds {
            return min(max(100, serverRetry), maximumDelayMilliseconds)
        }

        let steps = SyncContract.retryBackoffMs
        let index = min(max(consecutiveFailures, 0), steps.count - 1)
        let finiteJitter = jitter.isFinite ? jitter : 1
        let boundedJitter = min(max(finiteJitter, 0.5), 1.5)
        return min(
            maximumDelayMilliseconds,
            Int64((Double(steps[index]) * boundedJitter).rounded())
        )
    }
}

public enum ScheduledSyncSource: Equatable, Sendable {
    case foreground
    case networkRestored
    case interval
    case serverWake
    case silentPush
    case backgroundTask

    var engineTrigger: SyncTrigger {
        switch self {
        case .foreground: return .foreground
        case .interval: return .interval
        case .networkRestored, .serverWake, .silentPush, .backgroundTask: return .recovery
        }
    }
}

public enum ScheduledSyncResult: Equatable, Sendable {
    case accepted
    case duplicate
    case staleBinding
    case unavailable
    case failed
}

public enum SyncSchedulerCancellationReason: Equatable, Sendable {
    case unbind
    case revocation
    case accountSwitch
}

/// Foreground wake and compensation coordinator for exactly one binding.
///
/// The complete identity, including the binding-record lease version, is checked before and after
/// stream/tick work and before every sync trigger. Requests are held to one in-flight operation
/// plus one coalesced trailing operation.
public actor SyncScheduler {
    public typealias SnapshotProvider = @Sendable () async throws -> SyncRepositorySnapshot?
    public typealias SyncRequest = @Sendable (SyncTrigger) async -> Bool
    public typealias SyncCancellation = @Sendable (SyncSchedulerCancellationReason) async -> Void
    public typealias RevocationFence = @Sendable () async throws -> Void
    public typealias JitterSource = @Sendable () -> Double

    public nonisolated let identity: SyncBindingIdentity

    private let wakeTransport: any WakeStreamTransport
    private let clock: any WakeSchedulingClock
    private let snapshotProvider: SnapshotProvider
    private let syncRequest: SyncRequest
    private let syncCancellation: SyncCancellation
    private let revocationFence: RevocationFence
    private let serverRevocationHandler: MobileServerRevocationHandler
    private let jitter: JitterSource
    private let intervalMilliseconds: Int64

    private var connectivity = ConnectivityStatus.unknown
    private var isForeground = false
    private var invalidated = false
    private var lastEventID: String?
    private var lastEpoch: String?
    private var highestWakeCursor: Int64 = -1
    private var reconnectFailures = 0

    private var streamTask: Task<Void, Never>?
    private var intervalTask: Task<Void, Never>?
    private var syncTask: Task<Bool, Never>?
    private var pendingSyncTrigger: SyncTrigger?
    private var connectivityMonitor: (any ConnectivityMonitoring)?

    init(
        identity: SyncBindingIdentity,
        repository: any SyncRepository,
        engine: SyncEngine,
        wakeTransport: any WakeStreamTransport,
        clock: any WakeSchedulingClock = SystemWakeSchedulingClock(),
        intervalSeconds: Int = SyncContract.defaultIntervalSec,
        jitter: @escaping JitterSource = { Double.random(in: 0.5...1.5) },
        serverRevocationHandler: @escaping MobileServerRevocationHandler = { _ in }
    ) {
        self.identity = identity
        self.wakeTransport = wakeTransport
        self.clock = clock
        self.snapshotProvider = { try await repository.runnableSnapshot(for: identity) }
        self.syncRequest = { trigger in
            let results = await engine.request(trigger)
            return results.allSatisfy {
                $0.termination != .failed && $0.termination != .bindingChanged &&
                    $0.termination != .cancelled && $0.termination != .notRunnable
            }
        }
        self.syncCancellation = { reason in
            switch reason {
            case .revocation:
                await engine.cancelForRevocation(identity)
            case .unbind, .accountSwitch:
                await engine.cancelForUnbind(identity)
            }
        }
        self.revocationFence = {
            try await repository.saveBindingState(.revoked, for: identity)
        }
        self.serverRevocationHandler = serverRevocationHandler
        self.jitter = jitter
        self.intervalMilliseconds = Int64(SyncContract.clampIntervalSec(intervalSeconds)) * 1_000
    }

    init(
        identity: SyncBindingIdentity,
        wakeTransport: any WakeStreamTransport,
        clock: any WakeSchedulingClock = SystemWakeSchedulingClock(),
        intervalSeconds: Int = SyncContract.defaultIntervalSec,
        jitter: @escaping JitterSource = { Double.random(in: 0.5...1.5) },
        snapshotProvider: @escaping SnapshotProvider,
        syncRequest: @escaping SyncRequest,
        syncCancellation: @escaping SyncCancellation = { _ in },
        revocationFence: @escaping RevocationFence = {},
        serverRevocationHandler: @escaping MobileServerRevocationHandler = { _ in }
    ) {
        self.identity = identity
        self.wakeTransport = wakeTransport
        self.clock = clock
        self.snapshotProvider = snapshotProvider
        self.syncRequest = syncRequest
        self.syncCancellation = syncCancellation
        self.revocationFence = revocationFence
        self.serverRevocationHandler = serverRevocationHandler
        self.jitter = jitter
        self.intervalMilliseconds = Int64(SyncContract.clampIntervalSec(intervalSeconds)) * 1_000
    }

    /// Starts foreground compensation and the live stream when a path is available.
    public func applicationDidEnterForeground() async {
        guard !invalidated else { return }
        isForeground = true
        await activateForeground(source: .foreground)
    }

    public func attachConnectivityMonitor(_ monitor: any ConnectivityMonitoring) {
        guard !invalidated else {
            monitor.cancel()
            return
        }
        connectivityMonitor?.cancel()
        connectivityMonitor = monitor
        monitor.start { [weak self] status in
            guard let self else { return }
            Task { await self.connectivityDidChange(status) }
        }
    }

    /// Stops and joins foreground-only work. Background triggers remain available.
    public func applicationDidEnterBackground() async {
        isForeground = false
        await stopForegroundTasks()
    }

    /// A restored path always gets a foreground compensation round; SSE delivery
    /// is only a latency optimization and is never the sole correctness path.
    public func connectivityDidChange(_ status: ConnectivityStatus) async {
        let restored = !connectivity.isReachable && status.isReachable
        connectivity = status
        guard !invalidated, isForeground else { return }
        if status.isReachable {
            await activateForeground(source: restored ? .networkRestored : nil)
        } else {
            await stopForegroundTasks()
        }
    }

    @discardableResult
    public func trigger(
        _ source: ScheduledSyncSource,
        cursor: Int64? = nil,
        for expectedIdentity: SyncBindingIdentity,
        waitForCompletion: Bool = true
    ) async -> ScheduledSyncResult {
        guard !invalidated, expectedIdentity == identity else { return .staleBinding }
        switch await bindingCheck() {
        case .unavailable:
            return .unavailable
        case .ended:
            await cancelAndJoin(reason: .accountSwitch)
            return .staleBinding
        case .current(let snapshot):
            if let cursor {
                guard cursor >= 0 else { return .duplicate }
                let floor = max(snapshot.appliedCursor, highestWakeCursor)
                guard cursor > floor else { return .duplicate }
                highestWakeCursor = cursor
            }
        }

        let task = enqueueSync(source.engineTrigger)
        if waitForCompletion {
            let succeeded = await task.value
            if !succeeded { return .failed }
        }
        return .accepted
    }

    /// Cancels and joins the stream, ticker and queued sync before old binding
    /// credentials may be removed by unbind, revocation or account replacement.
    public func cancelAndJoin(reason: SyncSchedulerCancellationReason) async {
        guard !invalidated || streamTask != nil || intervalTask != nil || syncTask != nil else { return }
        let wasInvalidated = invalidated
        invalidated = true
        isForeground = false
        pendingSyncTrigger = nil

        let stream = streamTask
        let interval = intervalTask
        let sync = syncTask
        streamTask = nil
        intervalTask = nil
        syncTask = nil
        connectivityMonitor?.cancel()
        connectivityMonitor = nil
        // A terminal stream owns the durable revocation fence after it marks the scheduler
        // invalid. Join that task without cancelling it so cancellation-sensitive storage can
        // still commit the fence. Ordinary teardown continues to cancel an active stream.
        if !wasInvalidated { stream?.cancel() }
        interval?.cancel()
        sync?.cancel()
        if !wasInvalidated { await syncCancellation(reason) }
        if let stream { _ = await stream.value }
        if let interval { _ = await interval.value }
        if let sync { _ = await sync.value }
    }

    private enum BindingCheck {
        case current(SyncRepositorySnapshot)
        case ended
        case unavailable
    }

    private func bindingCheck() async -> BindingCheck {
        do {
            guard let snapshot = try await snapshotProvider() else { return .ended }
            guard snapshot.identity == identity, snapshot.canRunSync else { return .ended }
            return .current(snapshot)
        } catch {
            return .unavailable
        }
    }

    private func activateForeground(source: ScheduledSyncSource?) async {
        guard connectivity.isReachable else { return }
        switch await bindingCheck() {
        case .unavailable:
            return
        case .ended:
            await cancelAndJoin(reason: .accountSwitch)
        case .current(let snapshot):
            highestWakeCursor = max(highestWakeCursor, snapshot.appliedCursor)
            ensureStreamTask()
            ensureIntervalTask()
            if let source { _ = enqueueSync(source.engineTrigger) }
        }
    }

    private func ensureStreamTask() {
        guard streamTask == nil, isForeground, connectivity.isReachable, !invalidated else { return }
        streamTask = Task { await self.runStreamLoop() }
    }

    private func ensureIntervalTask() {
        guard intervalTask == nil, isForeground, connectivity.isReachable, !invalidated else { return }
        intervalTask = Task { await self.runIntervalLoop() }
    }

    private func stopForegroundTasks() async {
        let stream = streamTask
        let interval = intervalTask
        streamTask = nil
        intervalTask = nil
        stream?.cancel()
        interval?.cancel()
        if let stream { _ = await stream.value }
        if let interval { _ = await interval.value }
    }

    private func runStreamLoop() async {
        while !Task.isCancelled, isForeground, connectivity.isReachable, !invalidated {
            switch await bindingCheck() {
            case .ended:
                await invalidateFromActiveTask(reason: .accountSwitch)
                return
            case .unavailable:
                let delay = WakeReconnectPolicy.delayMilliseconds(
                    outcome: WakeStreamOutcome(failureCode: "binding_unavailable"),
                    consecutiveFailures: reconnectFailures,
                    jitter: jitter()
                )
                reconnectFailures = min(reconnectFailures + 1, SyncContract.retryBackoffMs.count - 1)
                do { try await clock.sleep(forMilliseconds: delay) } catch { return }
                continue
            case .current(let snapshot):
                highestWakeCursor = max(highestWakeCursor, snapshot.appliedCursor)
            }

            let outcome = await wakeTransport.open(lastEventID: lastEventID) { event in
                await self.receive(event)
            }
            guard !Task.isCancelled, isForeground, connectivity.isReachable, !invalidated else { break }
            switch await bindingCheck() {
            case .current:
                break
            case .unavailable:
                continue
            case .ended:
                await invalidateFromActiveTask(reason: .accountSwitch)
                return
            }
            if let reason = MobileServerRevocationReason(errorCode: outcome.failureCode) {
                await isolateForTerminalRevocation()
                await persistTerminalRevocationFence()
                await serverRevocationHandler(reason)
                return
            }
            if outcome.connected {
                reconnectFailures = 0
            } else {
                reconnectFailures = min(reconnectFailures + 1, SyncContract.retryBackoffMs.count - 1)
            }
            let delay = WakeReconnectPolicy.delayMilliseconds(
                outcome: outcome,
                consecutiveFailures: max(0, reconnectFailures - 1),
                jitter: jitter()
            )
            do { try await clock.sleep(forMilliseconds: delay) } catch { break }
        }
        streamTask = nil
    }

    /// A terminal wake must not return control to the reconnect loop until the repository is
    /// durably non-runnable. Cancellation may race this path, so a cancelled sleep yields and
    /// retries the exact identity-scoped write instead of silently dropping the fence.
    private func persistTerminalRevocationFence() async {
        var retry = 0
        while true {
            do {
                try await revocationFence()
                return
            } catch {
                let steps = SyncContract.retryBackoffMs
                let delay = Int64(steps[min(retry, steps.count - 1)])
                retry += 1
                do { try await clock.sleep(forMilliseconds: delay) }
                catch { await Task.yield() }
            }
        }
    }

    /// Stops every other network producer before durable fencing. Repository and binding-record
    /// I/O may retry indefinitely, but a terminal server decision must isolate the data plane first.
    private func isolateForTerminalRevocation() async {
        guard !invalidated else { return }
        invalidated = true
        isForeground = false
        pendingSyncTrigger = nil

        let interval = intervalTask
        let sync = syncTask
        intervalTask = nil
        syncTask = nil
        interval?.cancel()
        sync?.cancel()
        connectivityMonitor?.cancel()
        connectivityMonitor = nil
        await syncCancellation(.revocation)
        if let interval { _ = await interval.value }
        if let sync { _ = await sync.value }
    }

    private func runIntervalLoop() async {
        while !Task.isCancelled, isForeground, connectivity.isReachable, !invalidated {
            do { try await clock.sleep(forMilliseconds: intervalMilliseconds) } catch { break }
            guard !Task.isCancelled, isForeground, connectivity.isReachable, !invalidated else { break }
            switch await bindingCheck() {
            case .current:
                _ = enqueueSync(ScheduledSyncSource.interval.engineTrigger)
            case .unavailable:
                continue
            case .ended:
                await invalidateFromActiveTask(reason: .accountSwitch)
                return
            }
        }
        intervalTask = nil
    }

    private func receive(_ event: WakeStreamEvent) async {
        guard !invalidated else { return }
        switch await bindingCheck() {
        case .unavailable:
            return
        case .ended:
            await invalidateFromActiveTask(reason: .accountSwitch)
            return
        case .current(let snapshot):
            let epochChanged = lastEpoch.map { $0 != event.epoch } ?? false
            if epochChanged { highestWakeCursor = snapshot.appliedCursor }
            lastEpoch = event.epoch
            lastEventID = event.eventID

            let floor = max(snapshot.appliedCursor, highestWakeCursor)
            guard epochChanged || event.reason == .epochChanged || event.cursor > floor else { return }
            highestWakeCursor = max(highestWakeCursor, event.cursor)
            _ = enqueueSync(ScheduledSyncSource.serverWake.engineTrigger)
        }
    }

    private func enqueueSync(_ trigger: SyncTrigger) -> Task<Bool, Never> {
        if let syncTask {
            if pendingSyncTrigger == nil { pendingSyncTrigger = trigger }
            return syncTask
        }

        let task = Task { await self.drainSyncRequests(initialTrigger: trigger) }
        syncTask = task
        return task
    }

    private func drainSyncRequests(initialTrigger: SyncTrigger) async -> Bool {
        var succeeded = true
        var nextTrigger: SyncTrigger? = initialTrigger
        while !Task.isCancelled, !invalidated, let trigger = nextTrigger {
            switch await bindingCheck() {
            case .current:
                break
            case .unavailable:
                succeeded = false
                nextTrigger = takePendingSyncTrigger()
                continue
            case .ended:
                await invalidateFromActiveTask(reason: .accountSwitch)
                return false
            }
            let requestSucceeded = await syncRequest(trigger)
            switch await bindingCheck() {
            case .current:
                break
            case .unavailable:
                succeeded = false
                nextTrigger = takePendingSyncTrigger()
                continue
            case .ended:
                await invalidateFromActiveTask(reason: .accountSwitch)
                return false
            }
            if !requestSucceeded {
                succeeded = false
                let check = await bindingCheck()
                if case .current(let snapshot) = check {
                    highestWakeCursor = snapshot.appliedCursor
                }
            }
            nextTrigger = takePendingSyncTrigger()
        }
        syncTask = nil
        return succeeded
    }

    private func takePendingSyncTrigger() -> SyncTrigger? {
        defer { pendingSyncTrigger = nil }
        return pendingSyncTrigger
    }

    private func invalidateFromActiveTask(reason: SyncSchedulerCancellationReason) async {
        guard !invalidated else { return }
        invalidated = true
        isForeground = false
        pendingSyncTrigger = nil
        streamTask?.cancel()
        intervalTask?.cancel()
        syncTask?.cancel()
        connectivityMonitor?.cancel()
        connectivityMonitor = nil
        await syncCancellation(reason)
    }
}
