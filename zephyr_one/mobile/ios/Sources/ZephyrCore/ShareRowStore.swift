import Foundation

/// Durable storage for the share rows ``SecurityScopedGrants`` holds.
///
/// Separate from ``BookmarkStore`` because the two answer different questions and
/// die at different times. A bookmark is the platform authority for one directory;
/// a share row is this app's decision to expose that directory under a name, with a
/// narrowed write flag. One directory can back several rows (DEVELOPMENT.md 13.2
/// allows multiple profiles), so a row cannot own its bookmark's lifetime.
///
/// A protocol rather than a concrete type so ``SecurityScopedGrants`` keeps working
/// against an in-memory implementation in the existing XCTest suites, which is what
/// makes the grant lifecycle testable without a container.
public protocol ShareRowStore: AnyObject {

    /// Every stored row, in a stable order.
    func rows() -> [SecurityScopedGrant]

    func put(_ row: SecurityScopedGrant)

    func remove(profileId: String)
}

/// Non-persistent ``ShareRowStore``. The default, and what the tests use.
public final class InMemoryShareRowStore: ShareRowStore {

    private var store: [String: SecurityScopedGrant] = [:]

    public init() {}

    public func rows() -> [SecurityScopedGrant] {
        store.keys.sorted().compactMap { store[$0] }
    }

    public func put(_ row: SecurityScopedGrant) {
        store[row.profileId] = row
    }

    public func remove(profileId: String) {
        store.removeValue(forKey: profileId)
    }
}

/// ``ShareRowStore`` over a [KeyValueStore], so a picked directory survives a
/// relaunch.
///
/// Without it the app would hold a security-scoped bookmark with no row describing
/// it: access the user granted that the UI can no longer show or revoke. That is the
/// same gap `PersistentShareStore` closes on Android, and it is worth stating that
/// both platforms needed it separately -- the grant logic was testable and correct
/// on both, and on neither did anything write it down.
///
/// ## Why one key per field
///
/// A bookmark id is a URL string and a share name is user text. Packing them into
/// one value with a separator would make the encoding a parsing problem, and a share
/// named with the separator would either corrupt the row or have to be silently
/// rewritten. Distinct keys have no delimiter to inject.
public final class PersistentShareRowStore: ShareRowStore {

    private let store: KeyValueStore

    public init(store: KeyValueStore) {
        self.store = store
    }

    public func rows() -> [SecurityScopedGrant] {
        store.stringArray(Self.keyIndex).sorted().compactMap { profileId in
            /* A row missing its bookmark id is dropped rather than repaired. That only
             * happens if the store was truncated, and a row naming no bookmark cannot
             * address anything. */
            guard let bookmarkId = store.string(Self.bookmarkKey(profileId)) else { return nil }
            return SecurityScopedGrant(
                profileId: profileId,
                shareName: store.string(Self.nameKey(profileId)) ?? SecurityScopedGrants.defaultShareName,
                bookmarkId: bookmarkId,
                /* Read-only when the flag is missing. The strictest reading is the safe
                 * one: assuming writable would offer a write on a row whose recorded
                 * authority is unknown. */
                readOnly: store.boolean(Self.readOnlyKey(profileId), default: true),
                /* Always true on load, never persisted as false. Validity is re-derived
                 * from the live bookmark list on every read, so a persisted false would
                 * outlive the condition that caused it and leave the share broken after
                 * the user re-granted the directory. */
                grantValid: true
            )
        }
    }

    public func put(_ row: SecurityScopedGrant) {
        store.edit { writer in
            writer.setString(Self.bookmarkKey(row.profileId), row.bookmarkId)
            writer.setString(Self.nameKey(row.profileId), row.shareName)
            writer.setBoolean(Self.readOnlyKey(row.profileId), row.readOnly)
            var ids = Set(store.stringArray(Self.keyIndex))
            ids.insert(row.profileId)
            writer.setStringArray(Self.keyIndex, ids.sorted())
        }
    }

    public func remove(profileId: String) {
        store.edit { writer in
            writer.remove(Self.bookmarkKey(profileId))
            writer.remove(Self.nameKey(profileId))
            writer.remove(Self.readOnlyKey(profileId))
            writer.setStringArray(
                Self.keyIndex,
                store.stringArray(Self.keyIndex).filter { $0 != profileId }
            )
        }
    }

    private static let keyIndex = "share.profileIds"

    private static func bookmarkKey(_ profileId: String) -> String { "share." + profileId + ".bookmark" }

    private static func nameKey(_ profileId: String) -> String { "share." + profileId + ".name" }

    private static func readOnlyKey(_ profileId: String) -> String { "share." + profileId + ".readOnly" }
}

/// Which authorised directory each connection uses, on iOS.
///
/// Device-local by contract. DEVELOPMENT.md 13.2 keeps the directory *intent* on the
/// synced connection and the chosen profile id on the device, because a profile id
/// names a bookmark that resolves on exactly one device. Syncing it would give the
/// other device a row pointing at a bookmark it cannot resolve, and the share would
/// fail on first read rather than ask to be re-authorised.
public final class ConnectionShareChoices {

    private let store: KeyValueStore

    public init(store: KeyValueStore) {
        self.store = store
    }

    /// The profile chosen for `connectionId`, or nil when the user has not chosen.
    public func profile(for connectionId: String) -> String? {
        store.string(Self.key(connectionId)).flatMap { $0.isEmpty ? nil : $0 }
    }

    public func choose(connectionId: String, profileId: String) {
        store.edit { writer in writer.setString(Self.key(connectionId), profileId) }
    }

    /// Forgets one connection's choice, leaving the directory itself authorised.
    ///
    /// Clearing the choice means "ask again", which is what `storageIntent=ask`
    /// expects; releasing the bookmark here would break every other connection
    /// pointing at it.
    public func forget(connectionId: String) {
        store.edit { writer in writer.remove(Self.key(connectionId)) }
    }

    /// Drops choices naming a profile that no longer exists.
    ///
    /// A dangling choice is worse than no choice: the coordinator resolves it to nil
    /// and the session reports "no directory is authorised" while the connection
    /// editor still shows a directory as selected.
    ///
    /// - Returns: the connection ids whose choice was dropped.
    @discardableResult
    public func pruneMissing(knownProfileIds: Set<String>) -> [String] {
        let dropped = store.keys()
            .filter { $0.hasPrefix(Self.prefix) }
            .compactMap { storedKey -> String? in
                guard let profileId = store.string(storedKey),
                      knownProfileIds.contains(profileId)
                else {
                    return String(storedKey.dropFirst(Self.prefix.count))
                }
                return nil
            }
            .sorted()
        if dropped.isEmpty { return [] }
        store.edit { writer in
            for connectionId in dropped { writer.remove(Self.key(connectionId)) }
        }
        return dropped
    }

    private static let prefix = "connection.share."

    private static func key(_ connectionId: String) -> String { prefix + connectionId }
}
