import Darwin
import Foundation

/// ``SecurityScopedFileSystem`` over a user-granted directory URL.
///
/// Everything here is the platform call and nothing else: resolution, the symlink
/// jail, handle binding and the read-only refusals all live in
/// ``SecurityScopedFileProvider``, which is why they can be unit-tested with
/// `swift test` on a plain host. This file is the part that genuinely needs a
/// device, a document picker and a real filesystem.
///
/// ## Why `lstat` and not `FileManager` attributes
///
/// `FileManager.attributesOfItem(atPath:)` follows the final symlink, so it cannot
/// answer "is this node itself a link" -- the exact question the jail turns on.
/// `URL.resourceValues` can answer it but allocates a dictionary of boxed values
/// per entry, and LIST is what a Windows Explorer window issues on every
/// navigation. One `lstat` returns type, size and mtime together, and `access(2)`
/// answers readability and writability the way the kernel will actually answer it
/// when the file is opened.
///
/// ## Why the claim is reference-counted here
///
/// `startAccessingSecurityScopedResource()` is balanced by
/// `stopAccessingSecurityScopedResource()`, and the OS counts the pairs. Leaking
/// one keeps a sandbox extension alive after the user stopped the share; releasing
/// one that was never taken unbalances a claim someone else holds. The provider
/// tracks its own count and this type simply forwards, so neither side has to
/// guess what the other did.
public final class PosixSecurityScopedFileSystem: SecurityScopedFileSystem {

    private let rootURL: URL
    private let canonicalRoot: String

    /// - Parameter root: the directory the user granted, resolved from a
    ///   security-scoped bookmark.
    /// - Throws: `Zft2Error` when the root cannot be canonicalised, which is how a
    ///   stale bookmark or a detached volume presents. Refusing here beats serving
    ///   a share whose root is not where it claims to be.
    public init(root: URL) throws {
        self.rootURL = root
        guard let resolved = Self.realpath(root.path) else {
            throw Zft2Error(
                code: "not_found",
                message: "The shared directory is no longer available"
            )
        }
        /* The root is stored canonicalised because every containment test compares
         * against it. If the root itself were an unresolved path containing a link,
         * every legitimate child would resolve to something outside it and the whole
         * share would refuse itself. */
        self.canonicalRoot = resolved
    }

    public var rootPath: String { canonicalRoot }

    public func canonicalPath(of absolutePath: String) throws -> String? {
        Self.realpath(absolutePath)
    }

    public func info(at absolutePath: String) async throws -> FileNodeInfo? {
        var status = stat()
        /* lstat, not stat: a final symlink must be reported as a link so the
         * provider can decide whether following it stays inside the root. */
        guard lstat(absolutePath, &status) == 0 else { return nil }

        let mode = status.st_mode & S_IFMT
        let isSymlink = mode == S_IFLNK
        let isDirectory: Bool
        if isSymlink {
            /* A link's own type is "link". Whether it points at a directory decides
             * how the peer will treat it, and that answer comes from following it --
             * which is safe here because the provider has already confirmed
             * containment before it asks for a listing. */
            var target = stat()
            isDirectory = stat(absolutePath, &target) == 0 && (target.st_mode & S_IFMT) == S_IFDIR
        } else {
            isDirectory = mode == S_IFDIR
        }

        return FileNodeInfo(
            name: (absolutePath as NSString).lastPathComponent,
            isDirectory: isDirectory,
            isSymlink: isSymlink,
            size: Int64(status.st_size),
            /* Milliseconds, matching the Kotlin port and the wire. st_mtimespec is
             * seconds plus nanoseconds; the main end renders a timestamp, so losing
             * sub-millisecond precision is not observable, but losing the unit
             * would put every file in 1970. */
            mtime: Int64(status.st_mtimespec.tv_sec) * 1000
                + Int64(status.st_mtimespec.tv_nsec) / 1_000_000,
            /* The kernel's answer, not a guess from the mode bits: DEVELOPMENT.md
             * 13.4 requires the real platform result, and mode bits ignore ACLs, a
             * read-only mount and the sandbox itself. */
            canRead: access(absolutePath, R_OK) == 0,
            canWrite: access(absolutePath, W_OK) == 0
        )
    }

    public func children(at absolutePath: String) async throws -> [FileNodeInfo] {
        let names: [String]
        do {
            names = try FileManager.default.contentsOfDirectory(atPath: absolutePath)
        } catch {
            /* An unreadable directory is a refusal, not an empty directory. Returning
             * [] would tell the peer the folder is empty and a copy of it would
             * silently produce nothing. */
            throw Zft2Error(code: "permission_denied", message: "Cannot list the directory")
        }

        var out: [FileNodeInfo] = []
        out.reserveCapacity(names.count)
        for name in names {
            /* A node that vanished between the listing and the stat is skipped rather
             * than failing the whole listing -- the same tolerance the Dart provider
             * needed for protected Windows entries. */
            if let info = try await info(at: absolutePath + "/" + name) {
                out.append(info)
            }
        }
        return out
    }

    public func createFile(at absolutePath: String) async throws {
        /* O_EXCL so a concurrent create cannot be silently adopted, and no O_TRUNC:
         * the provider calls this only when the file is absent, and a truncating
         * create would destroy a file that appeared in between. */
        let fd = Darwin.open(absolutePath, O_CREAT | O_EXCL | O_WRONLY, 0o644)
        if fd < 0 {
            throw Self.mapErrno(errno, "Could not create the file")
        }
        Darwin.close(fd)
    }

    public func createDirectory(at absolutePath: String) async throws {
        /* Not `withIntermediateDirectories`. The provider refuses to invent a parent
         * chain, and passing true here would reintroduce that behaviour underneath
         * it: one typo would leave a tree of empty directories in the user's share. */
        do {
            try FileManager.default.createDirectory(
                atPath: absolutePath,
                withIntermediateDirectories: false
            )
        } catch {
            throw Self.mapErrno(errno, "Could not create the directory")
        }
    }

    public func delete(at absolutePath: String, recursive: Bool) async throws {
        if !recursive {
            /* Non-recursive is enforced with the syscalls that cannot recurse:
             * rmdir(2) fails with ENOTEMPTY and unlink(2) refuses a directory. Using
             * removeItem here would delete a tree the peer asked to remove only if
             * empty -- and the provider's own emptiness check races, because a file
             * can arrive between the check and the delete. */
            var status = stat()
            if lstat(absolutePath, &status) == 0, (status.st_mode & S_IFMT) == S_IFDIR {
                if rmdir(absolutePath) != 0 {
                    if errno == ENOTEMPTY {
                        throw Zft2Error(code: "not_empty", message: "Directory is not empty")
                    }
                    throw Self.mapErrno(errno, "Could not delete the directory")
                }
                return
            }
            if unlink(absolutePath) != 0 {
                throw Self.mapErrno(errno, "Could not delete the file")
            }
            return
        }

        do {
            try FileManager.default.removeItem(atPath: absolutePath)
        } catch {
            throw Self.mapErrno(errno, "Could not delete the item")
        }
    }

    public func move(from absolutePath: String, to destinationPath: String) async throws {
        /* rename(2) rather than FileManager.moveItem: it is atomic within a volume
         * and it will not fall back to copy-then-delete. A copy that fails halfway
         * leaves two partial files while the peer believes it moved one. */
        if rename(absolutePath, destinationPath) != 0 {
            if errno == EXDEV {
                /* Different volumes. Refused rather than emulated, matching the
                 * Android provider's refusal when a document provider cannot move. */
                throw Zft2Error(
                    code: "unsupported",
                    message: "Cannot move between volumes"
                )
            }
            throw Self.mapErrno(errno, "Could not move the item")
        }
    }

    public func openAccess(at absolutePath: String, write: Bool) async throws -> Zft2RandomAccess {
        /* O_NOFOLLOW is deliberately absent: the provider has already canonicalised
         * the path and confirmed the result is inside the root, so the path handed
         * here contains no unresolved link. Adding it would refuse a legitimate file
         * reached through a contained link.
         *
         * No O_TRUNC either. RDPDR delivers a large file as sequential writes on one
         * handle, and truncating on open would discard everything already written at
         * any non-zero offset. Truncation is an explicit operation. */
        let flags = write ? O_RDWR : O_RDONLY
        let fd = Darwin.open(absolutePath, flags)
        if fd < 0 {
            throw Self.mapErrno(errno, "Could not open the file")
        }
        return PosixRandomAccess(descriptor: fd)
    }

    public func beginAccess() -> Bool {
        rootURL.startAccessingSecurityScopedResource()
    }

    public func endAccess() {
        rootURL.stopAccessingSecurityScopedResource()
    }

    // MARK: - Helpers

    /// Fully resolves a path, or nil when it does not exist.
    ///
    /// `realpath(3)` resolves every component, not just the last, which is the
    /// property the jail needs: a link in the middle of a path is the case a prefix
    /// test on the unresolved string misses entirely.
    static func realpath(_ path: String) -> String? {
        guard let buffer = Darwin.realpath(path, nil) else { return nil }
        defer { free(buffer) }
        return String(cString: buffer)
    }

    /// Maps an errno onto a wire code.
    ///
    /// The message never carries the platform text. `strerror` and an `NSError`
    /// description both include the host path, and SHARED_RESOURCE_RESIDENCY.md
    /// keeps device paths off the wire; the peer gets a code it can act on instead.
    static func mapErrno(_ code: Int32, _ what: String) -> Zft2Error {
        let wire: String
        switch code {
        case EACCES, EPERM, EROFS:
            wire = "permission_denied"
        case ENOENT:
            wire = "not_found"
        case EEXIST:
            wire = "already_exists"
        case ENOSPC, EDQUOT:
            wire = "no_space"
        case EISDIR:
            wire = "is_a_directory"
        case ENOTDIR:
            wire = "not_a_directory"
        case ENOTEMPTY:
            wire = "not_empty"
        default:
            wire = "io_error"
        }
        return Zft2Error(code: wire, message: what)
    }
}

/// Positional reads and writes on one descriptor.
///
/// `pread`/`pwrite` rather than seek-then-read: they take the offset as an
/// argument and do not move the shared file position. Reads on one handle run
/// concurrently (DEVELOPMENT.md 13.3), and two seeking readers on one descriptor
/// would interleave into each other's data -- corruption that looks like a network
/// fault and only appears under parallel readahead.
///
/// An `actor` so the descriptor cannot be closed while a read is in flight, which
/// would otherwise read from whatever the kernel next assigned to that number.
actor PosixRandomAccess: Zft2RandomAccess {

    private var descriptor: Int32
    private var closed = false

    init(descriptor: Int32) {
        self.descriptor = descriptor
    }

    func readAt(offset: Int64, length: Int) async throws -> Data {
        if length <= 0 { return Data() }
        try requireOpen()

        var buffer = [UInt8](repeating: 0, count: length)
        var filled = 0
        while filled < length {
            let count = buffer.withUnsafeMutableBytes { raw -> Int in
                guard let start = raw.baseAddress else { return 0 }
                return pread(descriptor, start + filled, length - filled, off_t(offset) + off_t(filled))
            }
            if count < 0 {
                if errno == EINTR { continue }
                throw PosixSecurityScopedFileSystem.mapErrno(errno, "Read failed")
            }
            /* Zero means end of file. A short READ response is legal in ZFT2 and the
             * remote re-requests the remainder, but looping until EOF keeps a large
             * transfer from taking many more round trips than it needs. */
            if count == 0 { break }
            filled += count
        }
        return Data(buffer.prefix(filled))
    }

    func writeAt(offset: Int64, data: Data) async throws -> Int {
        try requireOpen()
        if data.isEmpty { return 0 }

        let bytes = [UInt8](data)
        var written = 0
        while written < bytes.count {
            let count = bytes.withUnsafeBytes { raw -> Int in
                guard let start = raw.baseAddress else { return 0 }
                return pwrite(descriptor, start + written, bytes.count - written, off_t(offset) + off_t(written))
            }
            if count < 0 {
                if errno == EINTR { continue }
                throw PosixSecurityScopedFileSystem.mapErrno(errno, "Write failed")
            }
            /* A zero-byte write is not progress. Returning the partial count would
             * tell the peer the bytes landed and the file would be silently short. */
            if count == 0 {
                throw Zft2Error(code: "io_error", message: "Write made no progress")
            }
            written += count
        }
        return written
    }

    func truncate(size: Int64) async throws {
        try requireOpen()
        while ftruncate(descriptor, off_t(size)) != 0 {
            if errno == EINTR { continue }
            throw PosixSecurityScopedFileSystem.mapErrno(errno, "Truncate failed")
        }
    }

    func close() async {
        guard !closed else { return }
        closed = true
        Darwin.close(descriptor)
        /* Poisoned rather than left dangling. A later use would otherwise read from
         * whatever the kernel next assigned to this number, which is a
         * cross-file read with no error to notice. */
        descriptor = -1
    }

    private func requireOpen() throws {
        if closed {
            throw Zft2Error(code: "not_found", message: "The file is closed")
        }
    }
}
