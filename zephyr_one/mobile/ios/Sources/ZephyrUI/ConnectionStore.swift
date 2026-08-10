import Foundation

/// The local write path rejected the operation.
///
/// Carries the machine-readable reason the gateway reported so the view model
/// can map "capability_denied" to a permission message instead of a generic
/// failure (SCREEN_CATALOG.md 2: capability 不足要显示原因).
public struct LocalWriteRejected: Error, Equatable, Sendable {
    public let reason: String

    public init(reason: String) {
        self.reason = reason
    }
}

/// The narrow persistence seam the connection view models are written
/// against.
///
/// Exists for the same reason ``KeyValueStore`` exists in ZephyrCore: the real
/// store is the sync mirror plus the /api/mobile/v1 gateway, neither of which
/// can run inside `swift test` on the CI host. Every save/delete rule above
/// this seam is exercised against a fake instead.
public protocol ConnectionStore: AnyObject {

    func find(_ connectionId: String) -> Connection?

    /// Local-first save: commit the row to this device and queue the masked
    /// operation. Throws ``LocalWriteRejected`` when the gateway refuses.
    func save(
        connection: Connection,
        mask: [String],
        secrets: [String: SecretState],
        ownerUserId: String,
        createdLocally: Bool
    ) async throws

    /// Queues the tombstone. The confirmation is the screen's job; by the time
    /// this runs the user has already agreed.
    func delete(_ connection: Connection, ownerUserId: String) async throws

    /// The directory intent is device-local, so it has its own write that
    /// never touches the sync queue.
    func setFileSyncIntent(
        _ connectionId: String,
        _ intent: FileSyncDirectoryIntent,
        _ nowMs: Int64
    ) async throws
}

/// String preference seam for device-local settings such as favourites.
public protocol PreferenceStore: AnyObject {

    func preference(_ key: String) -> String?

    func putPreference(_ key: String, _ value: String)
}
