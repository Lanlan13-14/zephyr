import Foundation

/// One filesystem node as the platform reports it.
///
/// `isSymlink` has no counterpart in the Android seam, and that is the important
/// difference between the two platforms rather than an oversight. SAF addresses
/// documents by opaque id and exposes no link concept at all, so the Android
/// provider cannot be handed a link. A security-scoped iOS root is a real
/// directory on a real filesystem, so a symlink inside it can point anywhere the
/// sandbox can reach, and DEVELOPMENT.md 13.4 requires links that leave the root
/// to be refused rather than followed.
public struct FileNodeInfo: Sendable, Equatable {
    public let name: String
    public let isDirectory: Bool
    /// True when the node itself is a symbolic link, before resolution.
    public let isSymlink: Bool
    public let size: Int64
    /// Milliseconds since the epoch, matching the Kotlin port and the wire.
    public let mtime: Int64
    public let canRead: Bool
    public let canWrite: Bool

    public init(
        name: String,
        isDirectory: Bool,
        isSymlink: Bool,
        size: Int64,
        mtime: Int64,
        canRead: Bool,
        canWrite: Bool
    ) {
        self.name = name
        self.isDirectory = isDirectory
        self.isSymlink = isSymlink
        self.size = size
        self.mtime = mtime
        self.canRead = canRead
        self.canWrite = canWrite
    }
}

/// Random access to one open file.
///
/// Every operation carries its own absolute offset rather than relying on a
/// stream position. Reads on one handle can be in flight concurrently
/// (DEVELOPMENT.md 13.3 keeps reads parallel), and two seeking readers sharing one
/// descriptor would interleave into each other's data -- corruption that looks
/// like a network fault and appears only under parallel readahead.
public protocol Zft2RandomAccess: AnyObject, Sendable {

    /// Reads at most `length` bytes from `offset`. A short read means end of file.
    func readAt(offset: Int64, length: Int) async throws -> Data

    /// Writes `data` at `offset` and returns the number of bytes accepted.
    func writeAt(offset: Int64, data: Data) async throws -> Int

    func truncate(size: Int64) async throws

    func close() async
}

/// The narrow platform seam the iOS ZFT2 provider is written against.
///
/// The split is the same one the Android module makes, and for the same reason:
/// the provider above this protocol -- path resolution, the symlink jail, the
/// read-only refusals, handle binding, listing limits -- is then testable with
/// `swift test` on a plain host, with no simulator, no document picker and no
/// user-granted URL. Only the macOS CI runner compiles this tree at all, so
/// anything that needs a device to exercise is in practice unexercised.
///
/// Implementations receive absolute host paths that the provider produced by
/// joining validated components onto `rootPath`, and they must not interpret
/// virtual paths. They are also permitted to be ignorant of the jail: the
/// provider canonicalises and re-checks containment at every step, so an
/// implementation that faithfully performs what it is asked cannot be talked into
/// reaching outside the root.
public protocol SecurityScopedFileSystem: AnyObject {

    /// Canonical absolute path of the granted root, with symlinks already
    /// resolved. Every resolution starts here and can only descend.
    var rootPath: String { get }

    /// Fully resolves `absolutePath`, following symlinks, or nil when it does not
    /// exist.
    ///
    /// This is what makes the jail hold on a real filesystem. It must resolve
    /// every component, not just the last: a link in the middle of a path is the
    /// case a `hasPrefix` check on the unresolved string misses entirely.
    ///
    /// - Throws: `Zft2Error` when the platform cannot answer. Refusing beats
    ///   guessing -- DEVELOPMENT.md 13.4 says a path that cannot be reliably
    ///   judged is rejected.
    func canonicalPath(of absolutePath: String) throws -> String?

    /// Metadata for one node, without following a final symlink.
    func info(at absolutePath: String) async throws -> FileNodeInfo?

    /// Direct children of a directory.
    ///
    /// Reported verbatim: the provider filters names it cannot address safely, so
    /// an implementation must not sanitise them. A name the provider would refuse
    /// has to be visible to it, not silently repaired into a different name.
    func children(at absolutePath: String) async throws -> [FileNodeInfo]

    func createFile(at absolutePath: String) async throws

    func createDirectory(at absolutePath: String) async throws

    /// Deletes a node, recursively when it is a directory.
    func delete(at absolutePath: String, recursive: Bool) async throws

    /// Moves or renames within the granted root.
    ///
    /// One operation rather than the two SAF needs: POSIX `rename(2)` changes the
    /// parent and the name together, so there is no equivalent of the Android
    /// seam's separate `move` and the "this provider cannot move" refusal.
    func move(from absolutePath: String, to destinationPath: String) async throws

    func openAccess(at absolutePath: String, write: Bool) async throws -> Zft2RandomAccess

    /// Claims the security-scoped resource, balanced by `endAccess()`.
    ///
    /// Unlike a SAF grant, an iOS security-scoped URL is not ambiently readable:
    /// access has to be claimed and released, the claims are reference-counted by
    /// the OS, and leaking one keeps a sandbox extension alive after the user
    /// believes the share stopped. Returns false when the claim was refused,
    /// which is how a stale bookmark presents.
    func beginAccess() -> Bool

    func endAccess()
}
