import Foundation

/// Minting and resolving security-scoped bookmarks, on top of a [KeyValueStore].
///
/// ``BookmarkStore`` had no implementation at all: only a test fake, so
/// ``SecurityScopedGrants`` could hold a grant in memory and nothing more. On a real
/// device that means the app forgets every authorised directory on the next launch
/// while the user believes the share is still set up.
///
/// ## Why a bookmark and not a path
///
/// A path is not a durable reference on iOS. The container path changes between
/// installs, an iCloud or external-volume directory can move, and a raw path carries
/// no sandbox extension -- so reading through one fails even when the user granted
/// access. `URL.bookmarkData` is the only handle that survives a relaunch and
/// re-issues the extension when resolved.
///
/// ## Why the id is derived rather than supplied
///
/// The id has to be stable across relaunches and derived from the bookmark itself,
/// or a stored row could not be matched to the bookmark that backs it. It is the
/// resolved URL's absolute string, which is stable for a given directory and is
/// already what the picker hands over. It is not a secret: it names a location, and
/// the authority lives in the bookmark data the OS validates.
public final class PersistentBookmarkStore: BookmarkStore {

    private let store: KeyValueStore
    /// Resolved URLs, keyed by bookmark id, for the ids resolved this session.
    ///
    /// Held so ``url(for:)`` can hand a live security-scoped URL to the provider
    /// without re-resolving on every operation. Not a cache of authority: the OS
    /// still validates the extension when access is claimed.
    private var resolved: [String: URL] = [:]
    /// Ids the OS reported as stale when they were last resolved.
    private var staleIds: Set<String> = []

    public init(store: KeyValueStore) {
        self.store = store
        loadAll()
    }

    // MARK: - Minting

    /// Mints and stores a bookmark for a directory the user just picked.
    ///
    /// Must be called while the picker's grant is still live. `bookmarkData` fails
    /// outside that window, and a bookmark that cannot be minted has to be reported
    /// rather than retried: a share that works until the process dies is worse than
    /// an honest refusal.
    ///
    /// - Returns: the bookmark id, or nil when the OS refused to mint one.
    @discardableResult
    public func mint(from url: URL, allowWrite: Bool) -> String? {
        let identifier = Self.identifier(for: url)
        /* .withSecurityScope is deliberately absent: it is a macOS-only option and
         * passing it on iOS throws. On iOS a bookmark for a picked directory is
         * security-scoped by virtue of where it came from. */
        guard let data = try? url.bookmarkData(
            options: [],
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        ) else {
            return nil
        }

        store.edit { writer in
            writer.setData(Self.dataKey(identifier), data)
            writer.setBoolean(Self.writeKey(identifier), allowWrite)
            /* The index is rewritten from the live set rather than appended to, so an
             * id removed and re-added in one session cannot appear twice and be read
             * back as two rows. */
            var ids = Set(store.stringArray(Self.keyIndex))
            ids.insert(identifier)
            writer.setStringArray(Self.keyIndex, ids.sorted())
        }
        resolved[identifier] = url
        staleIds.remove(identifier)
        return identifier
    }

    /// The live URL for a bookmark, resolving it if this session has not yet.
    ///
    /// - Returns: nil when the bookmark no longer resolves, which is how a deleted or
    ///   moved directory presents.
    public func url(for bookmarkId: String) -> URL? {
        if let known = resolved[bookmarkId] { return known }
        return resolveFromStore(bookmarkId)
    }

    // MARK: - BookmarkStore

    public func stored() -> [ResolvedBookmark] {
        store.stringArray(Self.keyIndex).sorted().compactMap { identifier in
            /* Resolved on demand rather than trusted from storage. A bookmark stops
             * resolving when the directory is deleted or the volume detaches, and
             * nothing notifies the app, so a row that merely exists proves nothing. */
            guard url(for: identifier) != nil else { return nil }
            return ResolvedBookmark(
                bookmarkId: identifier,
                canRead: true,
                /* What was granted, not what is hoped for. A directory picked
                 * read-only must never present as writable, or the share offers a
                 * write that fails once the remote has started copying. */
                canWrite: store.boolean(Self.writeKey(identifier), default: false),
                isStale: staleIds.contains(identifier)
            )
        }
    }

    public func persist(bookmarkId: String, allowWrite: Bool) -> ResolvedBookmark? {
        /* Already minted by `mint(from:allowWrite:)`, which is the only moment the OS
         * will produce bookmark data. This confirms the row is real rather than
         * minting again: `SecurityScopedGrants` calls it to record a grant, and it
         * must not be able to invent a bookmark for a URL the user never picked. */
        guard store.data(Self.dataKey(bookmarkId)) != nil else { return nil }
        guard url(for: bookmarkId) != nil else { return nil }

        let granted = store.boolean(Self.writeKey(bookmarkId), default: false)
        return ResolvedBookmark(
            bookmarkId: bookmarkId,
            canRead: true,
            /* Narrowed to the intersection: the caller cannot widen a read-only
             * bookmark by asking for write. */
            canWrite: allowWrite && granted,
            isStale: staleIds.contains(bookmarkId)
        )
    }

    public func discard(bookmarkId: String) {
        store.edit { writer in
            writer.remove(Self.dataKey(bookmarkId))
            writer.remove(Self.writeKey(bookmarkId))
            let remaining = store.stringArray(Self.keyIndex).filter { $0 != bookmarkId }
            writer.setStringArray(Self.keyIndex, remaining)
        }
        resolved.removeValue(forKey: bookmarkId)
        staleIds.remove(bookmarkId)
    }

    // MARK: - Resolution

    /// Resolves every stored bookmark once, at construction.
    ///
    /// Done eagerly so `stored()` reports staleness from the first call. DEVELOPMENT.md
    /// 13.5 has iOS re-verify before reconnecting, and discovering a stale bookmark on
    /// the first READ means the remote has already opened a folder.
    private func loadAll() {
        for identifier in store.stringArray(Self.keyIndex) {
            _ = resolveFromStore(identifier)
        }
    }

    private func resolveFromStore(_ identifier: String) -> URL? {
        guard let data = store.data(Self.dataKey(identifier)) else { return nil }
        var isStale = false
        /* No .withSecurityScope here either, matching how the bookmark was minted:
         * resolving with different options than were used to create it fails. */
        guard let url = try? URL(
            resolvingBookmarkData: data,
            options: [],
            relativeTo: nil,
            bookmarkDataIsStale: &isStale
        ) else {
            /* Not discarded. A bookmark can fail to resolve because a volume is
             * temporarily absent, and deleting the row would lose a grant the user
             * would otherwise get back by reattaching the volume. It simply does not
             * appear in `stored()` while it cannot resolve, which reads as invalid. */
            return nil
        }

        if isStale {
            /* Recorded rather than ignored. A stale bookmark still resolves today, so
             * treating it as usable is exactly the mistake: the correct response is to
             * re-create it, and until then the share must count as invalid. */
            staleIds.insert(identifier)
        } else {
            staleIds.remove(identifier)
        }
        resolved[identifier] = url
        return url
    }

    /// The stable id for a directory URL.
    ///
    /// `standardizedFileURL` first so `/dir` and `/dir/` produce one id: two ids for
    /// one directory would let the same folder be authorised twice and appear as two
    /// shares the user cannot tell apart.
    static func identifier(for url: URL) -> String {
        url.standardizedFileURL.absoluteString
    }

    /// UserDefaults suite for the file-sync rows. Device-local; never synced.
    public static let suiteName = "one.zephyr.mobile.filesync"

    private static let keyIndex = "bookmark.ids"

    private static func dataKey(_ identifier: String) -> String { "bookmark.data." + identifier }

    private static func writeKey(_ identifier: String) -> String { "bookmark.write." + identifier }
}
