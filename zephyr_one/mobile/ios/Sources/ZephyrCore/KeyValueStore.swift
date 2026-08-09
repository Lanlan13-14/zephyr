import Foundation

/// The narrow persistence seam the iOS file-sync bookkeeping is written against.
///
/// Exists for the same reason as ``SecurityScopedFileSystem`` and ``BookmarkStore``:
/// `UserDefaults` is a Foundation singleton whose real behaviour depends on a
/// process container, so code written directly against it can only be exercised on
/// a device or simulator. This repository has neither -- the Swift here compiles
/// only on the macOS CI runner -- so persistence behind a seam is the difference
/// between rules that are tested and rules that are merely written down.
///
/// The rules being protected are not incidental. A grant row that fails to persist
/// means the app holds a security-scoped bookmark with no row describing it: access
/// the user granted that the UI can no longer show or revoke. A stale connection
/// choice means a session reports "no directory is authorised" while the editor
/// still shows one as selected. Both are silent.
public protocol KeyValueStore: AnyObject {

    func string(_ key: String) -> String?

    func data(_ key: String) -> Data?

    func boolean(_ key: String, default defaultValue: Bool) -> Bool

    func stringArray(_ key: String) -> [String]

    /// Every key currently stored. Used to find rows whose owner has gone.
    func keys() -> [String]

    /// Applies a batch of writes.
    ///
    /// A batch rather than individual setters: a grant row spans several keys plus
    /// the id index, and a termination between two of them would leave an id in the
    /// index with no bookmark behind it.
    func edit(_ block: (KeyValueWriter) -> Void)
}

/// Accumulates one batch of writes.
public protocol KeyValueWriter: AnyObject {

    func setString(_ key: String, _ value: String)

    func setData(_ key: String, _ value: Data)

    func setBoolean(_ key: String, _ value: Bool)

    func setStringArray(_ key: String, _ value: [String])

    func remove(_ key: String)
}

/// ``KeyValueStore`` over `UserDefaults`.
///
/// A thin forward on purpose: every rule about what to store and when to drop it
/// lives above this class, where an XCTest can reach it without a container.
///
/// The suite name is explicit rather than `.standard` so the file-sync rows sit in
/// their own domain. Nothing here is synced -- DEVELOPMENT.md 3 forbids sending a
/// bookmark to another device, because one resolved elsewhere names nothing -- and a
/// separate domain is what keeps it out of any future iCloud-backed defaults.
public final class UserDefaultsKeyValueStore: KeyValueStore {

    private let defaults: UserDefaults

    public init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    /// - Returns: nil when the suite cannot be opened, which is how a misspelled
    ///   suite name presents. Refused rather than silently falling back to
    ///   `.standard`, where the rows would be written somewhere the next launch does
    ///   not look.
    public convenience init?(suiteName: String) {
        guard let suite = UserDefaults(suiteName: suiteName) else { return nil }
        self.init(defaults: suite)
    }

    public func string(_ key: String) -> String? { defaults.string(forKey: key) }

    public func data(_ key: String) -> Data? { defaults.data(forKey: key) }

    public func boolean(_ key: String, default defaultValue: Bool) -> Bool {
        /* object(forKey:) first: bool(forKey:) cannot distinguish a stored false from
         * an absent key, and the callers need that difference. A grant row that lost
         * its write flag must be read as read-only rather than as "false means
         * writable". */
        guard defaults.object(forKey: key) != nil else { return defaultValue }
        return defaults.bool(forKey: key)
    }

    public func stringArray(_ key: String) -> [String] {
        defaults.stringArray(forKey: key) ?? []
    }

    public func keys() -> [String] {
        Array(defaults.dictionaryRepresentation().keys)
    }

    public func edit(_ block: (KeyValueWriter) -> Void) {
        block(Writer(defaults: defaults))
    }

    private final class Writer: KeyValueWriter {
        private let defaults: UserDefaults

        init(defaults: UserDefaults) {
            self.defaults = defaults
        }

        func setString(_ key: String, _ value: String) { defaults.set(value, forKey: key) }

        func setData(_ key: String, _ value: Data) { defaults.set(value, forKey: key) }

        func setBoolean(_ key: String, _ value: Bool) { defaults.set(value, forKey: key) }

        func setStringArray(_ key: String, _ value: [String]) { defaults.set(value, forKey: key) }

        func remove(_ key: String) { defaults.removeObject(forKey: key) }
    }
}
