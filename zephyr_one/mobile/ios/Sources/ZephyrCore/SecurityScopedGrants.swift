import Foundation

/// One authorised directory, as the platform currently reports it.
///
/// `grantValid` is re-derived rather than remembered. A security-scoped bookmark
/// survives relaunches, but it goes stale when the user moves or deletes the
/// directory, when the providing app is removed, or when an external volume is
/// detached -- and nothing notifies the app. A share whose bookmark is stale must
/// fail at the point the drive is mapped, not on the first READ after Windows
/// Explorer has already opened a folder (see the RDP drive policy, which refuses
/// to map an invalid grant for exactly this reason).
public struct SecurityScopedGrant: Sendable, Equatable {
    /// Stable id stored on the device-local override, never synced.
    public let profileId: String
    /// What the remote Windows session sees: PHONE, DOCUMENTS or a user label.
    public let shareName: String
    /// Opaque bookmark identity. Device-bound; DEVELOPMENT.md 3 forbids syncing it,
    /// because a bookmark resolved on another device names nothing.
    public let bookmarkId: String
    public let readOnly: Bool
    public let grantValid: Bool

    public init(
        profileId: String,
        shareName: String,
        bookmarkId: String,
        readOnly: Bool,
        grantValid: Bool
    ) {
        self.profileId = profileId
        self.shareName = shareName
        self.bookmarkId = bookmarkId
        self.readOnly = readOnly
        self.grantValid = grantValid
    }
}

/// A resolved bookmark as the platform reports it.
public struct ResolvedBookmark: Sendable, Equatable {
    public let bookmarkId: String
    public let canRead: Bool
    public let canWrite: Bool
    /// True when the OS reported the bookmark as stale on resolution.
    ///
    /// A stale bookmark can still resolve to a usable URL, which is why this is
    /// separate from a failure: AppKit/UIKit hand back a URL *and* a stale flag,
    /// and the correct response is to re-create the bookmark rather than to keep
    /// using one that will stop working.
    public let isStale: Bool

    public init(bookmarkId: String, canRead: Bool, canWrite: Bool, isStale: Bool) {
        self.bookmarkId = bookmarkId
        self.canRead = canRead
        self.canWrite = canWrite
        self.isStale = isStale
    }
}

/// The platform seam for security-scoped bookmark storage.
///
/// Separated from ``SecurityScopedGrants`` so the grant lifecycle -- which grants
/// are held, when one is released, how a stale bookmark is reported -- is testable
/// with `swift test` and no document picker. The production implementation stores
/// bookmark data in the keychain or user defaults and resolves it through
/// `URL(resolvingBookmarkData:)`.
public protocol BookmarkStore: AnyObject {

    /// Every bookmark the app currently holds.
    func stored() -> [ResolvedBookmark]

    /// Persists a bookmark for a directory the user just picked.
    ///
    /// Returns nil when the OS refused to mint one, which happens when the URL did
    /// not come from a picker result: the bookmark has to be for a directory the
    /// user just granted.
    func persist(bookmarkId: String, allowWrite: Bool) -> ResolvedBookmark?

    func discard(bookmarkId: String)
}

/// Tracks which directories the user has authorised for file sync on iOS.
///
/// The counterpart of Android's `SafShareGrants`, and the pair it exists to keep
/// honest is the same: (what the user granted) and (what the share config claims).
/// Those drift on both platforms, for platform-specific reasons -- a SAF grant is
/// revoked in system settings, a bookmark goes stale when the directory moves --
/// and in both cases nothing tells the app. So every read re-derives validity from
/// the store instead of trusting the stored row.
///
/// Writes are narrowed here rather than only in the UI. A directory can be granted
/// read-only, and offering a writable share over a read-only grant produces the
/// corrupted half-copy that DEVELOPMENT.md 13.4 calls out.
public final class SecurityScopedGrants {

    private let bookmarks: BookmarkStore
    /// Durable share rows. Device-local; nothing here is synced.
    private var store: [String: SecurityScopedGrant] = [:]

    public init(bookmarks: BookmarkStore) {
        self.bookmarks = bookmarks
    }

    /// Records a directory the user just picked.
    ///
    /// - Parameter requestWrite: what the share config asks for. The result is
    ///   narrowed to what the OS actually granted: a read-only grant yields a
    ///   read-only share, never a writable one.
    /// - Returns: the stored grant, or nil when no bookmark could be minted -- in
    ///   which case nothing is stored, because a share that cannot survive a
    ///   relaunch is worse than an absent one.
    @discardableResult
    public func authorize(
        profileId: String,
        shareName: String,
        bookmarkId: String,
        requestWrite: Bool
    ) -> SecurityScopedGrant? {
        guard let resolved = bookmarks.persist(bookmarkId: bookmarkId, allowWrite: requestWrite) else {
            return nil
        }
        /* A bookmark can be minted and still not be readable, and a share that
         * cannot be read is not a share. Discarded again rather than left
         * dangling. */
        guard resolved.canRead else {
            bookmarks.discard(bookmarkId: bookmarkId)
            return nil
        }

        let trimmed = shareName.trimmingCharacters(in: .whitespacesAndNewlines)
        let grant = SecurityScopedGrant(
            profileId: profileId,
            shareName: trimmed.isEmpty ? Self.defaultShareName : trimmed,
            bookmarkId: bookmarkId,
            readOnly: !requestWrite || !resolved.canWrite,
            grantValid: true
        )
        store[profileId] = grant
        return grant
    }

    /// The stored share with its validity re-derived from the live bookmark list.
    ///
    /// Nil means no such profile. A profile whose bookmark is gone or stale still
    /// returns a grant, with `grantValid` false: the caller needs to tell the user
    /// which directory to re-authorise, and it cannot do that from a nil.
    public func grant(profileId: String) -> SecurityScopedGrant? {
        guard let stored = store[profileId] else { return nil }
        let live = bookmarks.stored().first { $0.bookmarkId == stored.bookmarkId }
        return SecurityScopedGrant(
            profileId: stored.profileId,
            shareName: stored.shareName,
            bookmarkId: stored.bookmarkId,
            /* A grant downgraded to read-only after the fact narrows the share. The
             * reverse never widens it: the config's own readOnly stays authoritative
             * when it is stricter. */
            readOnly: stored.readOnly || live == nil || !(live?.canWrite ?? false),
            /* A stale bookmark counts as invalid even though it may still resolve.
             * DEVELOPMENT.md 13.5 has iOS re-verify before reconnecting, and
             * "resolves today" is not the same as "will resolve for this session". */
            grantValid: live != nil && live!.canRead && !live!.isStale
        )
    }

    public func all() -> [SecurityScopedGrant] {
        store.keys.sorted().compactMap { grant(profileId: $0) }
    }

    /// Shares that can actually serve right now.
    public func usable() -> [SecurityScopedGrant] {
        all().filter { $0.grantValid }
    }

    /// Forgets a share and drops its bookmark.
    ///
    /// Discarding matters: a bookmark left behind keeps the app able to resolve a
    /// directory the user has removed from the app's own list, which is precisely
    /// the ambient access security-scoped URLs exist to avoid.
    public func revoke(profileId: String) {
        guard let stored = store.removeValue(forKey: profileId) else { return }
        /* Only when no other profile still points at the same bookmark. Two shares
         * over one directory is legal (DEVELOPMENT.md 13.2 allows multiple
         * profiles), and discarding on the first removal would break the second. */
        if !store.values.contains(where: { $0.bookmarkId == stored.bookmarkId }) {
            bookmarks.discard(bookmarkId: stored.bookmarkId)
        }
    }

    /// Drops grants whose bookmark no longer resolves or has gone stale.
    ///
    /// Called on foreground resume. DEVELOPMENT.md 13.5 requires the binding and the
    /// file-bridge lease to be re-verified before reconnecting; a stale row that
    /// survived that check would advertise a share the provider cannot open.
    ///
    /// - Returns: the profile ids that were dropped, so the UI can name what needs
    ///   re-authorising.
    @discardableResult
    public func pruneInvalid() -> [String] {
        let live = Set(bookmarks.stored().filter { $0.canRead && !$0.isStale }.map(\.bookmarkId))
        let dropped = store.filter { !live.contains($0.value.bookmarkId) }.keys.sorted()
        for profileId in dropped {
            store.removeValue(forKey: profileId)
        }
        return dropped
    }

    /// Matches Android's default so both platforms label an unnamed share alike.
    public static let defaultShareName = "PHONE"
}
