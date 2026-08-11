import Foundation

#if canImport(BackgroundTasks)
import BackgroundTasks
#endif

public struct SilentPushWake: Equatable, Sendable {
    public static let envelopeKey = "zephyr-one-wake"

    public let deviceID: String
    public let generation: String
    public let cursor: Int64

    public init(deviceID: String, generation: String, cursor: Int64) {
        self.deviceID = deviceID
        self.generation = generation
        self.cursor = cursor
    }

    /// Accepts only a content-available, payload-free sync hint. Account IDs,
    /// entity IDs and user content are deliberately not part of this envelope.
    public static func decode(userInfo: [AnyHashable: Any]) -> SilentPushWake? {
        guard userInfo.count == 2,
              Set(userInfo.keys.compactMap { $0 as? String }) == Set(["aps", envelopeKey]),
              let aps = userInfo["aps"] as? [String: Any],
              Set(aps.keys) == Set(["content-available"]),
              Self.integer(aps["content-available"]) == 1,
              let wake = userInfo[envelopeKey] as? [String: Any],
              Set(wake.keys) == Set(["kind", "deviceId", "generation", "cursor"]),
              wake["kind"] as? String == "sync-wake",
              let deviceID = wake["deviceId"] as? String, !deviceID.isEmpty,
              let generation = wake["generation"] as? String, !generation.isEmpty,
              let cursor = Self.integer(wake["cursor"]), cursor >= 0 else {
            return nil
        }
        return SilentPushWake(deviceID: deviceID, generation: generation, cursor: cursor)
    }

    private static func integer(_ value: Any?) -> Int64? {
        if let value = value as? Int64 { return value }
        if let value = value as? Int { return Int64(value) }
        if let value = value as? UInt, value <= UInt(Int64.max) { return Int64(value) }
        return nil
    }
}

public enum BackgroundSyncResult: Equatable, Sendable {
    case newData
    case noData
    case failed
    case ignored
}

/// APNs and background-task entry point for one binding-scoped runtime.
/// Silent push remains an opportunistic hint; foreground and connectivity
/// compensation in `SyncScheduler` are required even when this never runs.
public final class PushNotificationCoordinator: @unchecked Sendable {
    private let identity: SyncBindingIdentity
    private let triggerAction: @Sendable (
        ScheduledSyncSource,
        Int64?,
        Bool
    ) async -> ScheduledSyncResult

    public init(runtime: MobileBindingRuntime) {
        self.identity = runtime.identity
        self.triggerAction = { source, cursor, waitForCompletion in
            await runtime.trigger(
                source,
                cursor: cursor,
                waitForCompletion: waitForCompletion
            )
        }
    }

    init(identity: SyncBindingIdentity, scheduler: SyncScheduler) {
        self.identity = identity
        self.triggerAction = { source, cursor, waitForCompletion in
            await scheduler.trigger(
                source,
                cursor: cursor,
                for: identity,
                waitForCompletion: waitForCompletion
            )
        }
    }

    public func handleSilentPush(userInfo: [AnyHashable: Any]) async -> BackgroundSyncResult {
        guard let wake = SilentPushWake.decode(userInfo: userInfo) else { return .ignored }
        guard wake.deviceID == identity.deviceID, wake.generation == identity.generation else {
            return .ignored
        }
        return await map(
            triggerAction(
                .silentPush,
                wake.cursor,
                true
            )
        )
    }

    public func handleBackgroundTask() async -> BackgroundSyncResult {
        await map(
            triggerAction(
                .backgroundTask,
                nil,
                true
            )
        )
    }

    private func map(_ result: ScheduledSyncResult) -> BackgroundSyncResult {
        switch result {
        case .accepted: return .newData
        case .duplicate: return .noData
        case .staleBinding: return .ignored
        case .unavailable, .failed: return .failed
        }
    }
}

#if canImport(BackgroundTasks)
private final class BackgroundTaskCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var completed = false

    func finish(_ task: BGTask, success: Bool) {
        lock.lock()
        guard !completed else {
            lock.unlock()
            return
        }
        completed = true
        lock.unlock()
        task.setTaskCompleted(success: success)
    }
}

public enum BackgroundSyncTaskKind: Equatable, Sendable {
    case refresh
    case processing(requiresExternalPower: Bool)
}

/// Thin injectable bridge around Apple's opportunistic scheduler. Registration
/// belongs in application launch; submitted dates are requests, never promises.
public final class BackgroundSyncTaskBridge: @unchecked Sendable {
    public typealias Handler = @Sendable () async -> Bool
    public typealias ExpirationHandler = @Sendable () async -> Void

    private let identifier: String
    private let kind: BackgroundSyncTaskKind
    private let scheduler: BGTaskScheduler

    public init(
        identifier: String,
        kind: BackgroundSyncTaskKind,
        scheduler: BGTaskScheduler = .shared
    ) {
        self.identifier = identifier
        self.kind = kind
        self.scheduler = scheduler
    }

    @discardableResult
    public func register(
        handler: @escaping Handler,
        onExpiration: @escaping ExpirationHandler = {}
    ) -> Bool {
        scheduler.register(forTaskWithIdentifier: identifier, using: nil) { task in
            let completion = BackgroundTaskCompletion()
            let work = Task {
                let succeeded = await handler()
                completion.finish(task, success: succeeded && !Task.isCancelled)
            }
            task.expirationHandler = {
                work.cancel()
                completion.finish(task, success: false)
                Task { await onExpiration() }
            }
        }
    }

    public func submit(earliestBeginDate: Date? = nil) throws {
        switch kind {
        case .refresh:
            let request = BGAppRefreshTaskRequest(identifier: identifier)
            request.earliestBeginDate = earliestBeginDate
            try scheduler.submit(request)
        case .processing(let requiresExternalPower):
            let request = BGProcessingTaskRequest(identifier: identifier)
            request.earliestBeginDate = earliestBeginDate
            request.requiresNetworkConnectivity = true
            request.requiresExternalPower = requiresExternalPower
            try scheduler.submit(request)
        }
    }

    public func cancelPending() {
        scheduler.cancel(taskRequestWithIdentifier: identifier)
    }
}
#endif
