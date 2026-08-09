import Foundation

/// One filesystem entry as the peer sees it.
///
/// `canRead` and `canWrite` are real platform answers, not constants. The Dart
/// agent hardcodes both to true (`zephyr_agent/lib/fs/file_provider.dart`);
/// DEVELOPMENT.md 13.4 explicitly forbids that, because a share advertised as
/// writable that then fails every write turns into a corrupted half-copied file
/// on the Windows side rather than a clean refusal. The main end reads these
/// fields to render a file list and to decide whether to offer a write at all.
///
/// Field order in `toMeta()` matches `Zft2FileStat.toJson()` in the Kotlin port so
/// captured traces stay diffable between the two platforms.
public struct Zft2FileStat: Sendable, Equatable {
    public let name: String
    public let path: String
    public let isDir: Bool
    public let size: Int64
    public let mtime: Int64
    public let canRead: Bool
    public let canWrite: Bool

    public init(
        name: String,
        path: String,
        isDir: Bool,
        size: Int64,
        mtime: Int64,
        canRead: Bool,
        canWrite: Bool
    ) {
        self.name = name
        self.path = path
        self.isDir = isDir
        self.size = size
        self.mtime = mtime
        self.canRead = canRead
        self.canWrite = canWrite
    }

    /// Wire representation, in the key order the Kotlin port emits.
    ///
    /// Ordered pairs rather than a dictionary: `Zft2Meta` encodes in insertion
    /// order and the encoded length lands in the frame header, so key order is
    /// part of the bytes both ends agree on.
    public func toMeta() -> Zft2Meta {
        Zft2Meta([
            ("name", .string(name)),
            ("path", .string(path)),
            ("isDir", .bool(isDir)),
            ("size", .int(size)),
            ("mtime", .int(mtime)),
            ("canRead", .bool(canRead)),
            ("canWrite", .bool(canWrite)),
        ])
    }
}

/// Open modes the provider accepts, matching the Kotlin constants.
///
/// `write` must not truncate. RDPDR delivers a large file as sequential writes on
/// one handle, so a truncate-on-open mode would discard everything already
/// written on every write after the first.
public enum Zft2OpenMode: String, Sendable, CaseIterable {
    case read
    case write
    case writeTruncate
}

/// The platform half of the ZFT2 provider.
///
/// iOS implements this over a security-scoped URL and Android over SAF
/// `DocumentFile`/`ContentResolver`, per DEVELOPMENT.md 13.4. Everything above
/// this protocol is pure logic so the dispatch rules, the read-only jail and the
/// path validation are testable without a device.
///
/// Implementations must throw `Zft2Error` with a wire code. Anything else would
/// reach the peer as an unmapped failure, and on iOS a raw `NSError` description
/// carries the host path -- which SHARED_RESOURCE_RESIDENCY.md keeps off the wire.
public protocol Zft2FileProvider: AnyObject {

    /// Directory listing. Must reject a path that escapes the authorised root.
    func list(path: String) async throws -> [Zft2FileStat]

    func stat(path: String) async throws -> Zft2FileStat

    /// Opens `path` and returns an opaque handle.
    ///
    /// The handle must be unpredictable and bound to the canonical path plus the
    /// access mode (DEVELOPMENT.md 13.3): a guessable sequential handle would let
    /// a peer read a file it never opened, and a handle not bound to its mode
    /// would let a read-mode handle be written through.
    func open(path: String, mode: String) async throws -> String

    func read(handle: String, offset: Int64, length: Int) async throws -> Data

    func write(handle: String, offset: Int64, data: Data) async throws -> Int

    func close(handle: String) async throws

    func mkdir(path: String) async throws

    func delete(path: String, recursive: Bool) async throws

    func rename(oldPath: String, newPath: String) async throws

    func truncate(path: String, size: Int64) async throws

    /// Releases every open handle. Called on disconnect so a dropped socket
    /// cannot leak file descriptors or a security-scoped access claim.
    func closeAll() async
}
