import Darwin
import Foundation

/// ``SecurityScopedFileSystem`` over a user-granted directory URL.
///
/// Security-sensitive operations never reopen an absolute path. The first
/// security-scope claim opens and holds the authorised root directory descriptor;
/// each operation duplicates that descriptor and walks components with
/// `openat(O_DIRECTORY | O_NOFOLLOW)`. Final operations use the corresponding
/// `*at` syscall and refuse a final symlink as well. Renaming an ancestor after a
/// check therefore cannot redirect the later syscall.
public final class PosixSecurityScopedFileSystem:
    SecurityScopedFileSystem,
    DescriptorRelativeSecurityScopedFileSystem
{

    private let rootURL: URL
    private let canonicalRoot: String
    private let rootDevice: dev_t
    private let rootInode: ino_t
    private let requiresSecurityScope: Bool

    private let stateLock = NSLock()
    private var rootDescriptor: Int32 = -1
    private var accessClaims = 0

    /// Creates a filesystem for a URL resolved from a security-scoped bookmark.
    public convenience init(root: URL) throws {
        try self.init(root: root, requiresSecurityScope: true)
    }

    /// Test seam for ordinary temporary directories, which are not security-scoped
    /// resources and make `startAccessingSecurityScopedResource()` return false.
    init(root: URL, requiresSecurityScope: Bool) throws {
        self.rootURL = root
        self.requiresSecurityScope = requiresSecurityScope
        guard let resolved = Self.realpath(root.path) else {
            throw Zft2Error(code: "not_found", message: "The shared directory is no longer available")
        }
        var status = stat()
        guard lstat(resolved, &status) == 0, (status.st_mode & S_IFMT) == S_IFDIR else {
            throw Zft2Error(code: "not_a_directory", message: "The shared resource is not a directory")
        }
        self.canonicalRoot = resolved
        self.rootDevice = status.st_dev
        self.rootInode = status.st_ino
    }

    deinit {
        stateLock.lock()
        let descriptor = rootDescriptor
        rootDescriptor = -1
        let claims = accessClaims
        accessClaims = 0
        stateLock.unlock()

        if descriptor >= 0 { Darwin.close(descriptor) }
        if requiresSecurityScope {
            for _ in 0..<claims {
                rootURL.stopAccessingSecurityScopedResource()
            }
        }
    }

    public var rootPath: String { canonicalRoot }

    // MARK: - Descriptor-relative security boundary

    func descriptorInfo(components: [String]) async throws -> FileNodeInfo? {
        try Self.validate(components)
        if components.isEmpty {
            let descriptor = try duplicateRootDescriptor()
            defer { Darwin.close(descriptor) }
            var status = stat()
            guard fstat(descriptor, &status) == 0 else {
                throw Self.mapErrno(errno, "Could not inspect the shared directory")
            }
            return Self.info(
                status: status,
                name: (canonicalRoot as NSString).lastPathComponent,
                parentDescriptor: descriptor,
                entryName: "."
            )
        }

        let parent = try openParent(of: components)
        defer { Darwin.close(parent.descriptor) }
        var status = stat()
        if fstatat(parent.descriptor, parent.name, &status, AT_SYMLINK_NOFOLLOW) != 0 {
            if errno == ENOENT { return nil }
            throw Self.mapErrno(errno, "Could not inspect the item")
        }
        try Self.rejectSymlink(status)
        return Self.info(
            status: status,
            name: parent.name,
            parentDescriptor: parent.descriptor,
            entryName: parent.name
        )
    }

    func descriptorChildren(components: [String], limit: Int) async throws -> [FileNodeInfo] {
        try Self.validate(components)
        if limit <= 0 { return [] }

        let directoryDescriptor = try openDirectory(components)
        defer { Darwin.close(directoryDescriptor) }
        let streamDescriptor = fcntl(directoryDescriptor, F_DUPFD_CLOEXEC, 0)
        guard streamDescriptor >= 0 else {
            throw Self.mapErrno(errno, "Could not list the directory")
        }
        guard let directory = fdopendir(streamDescriptor) else {
            Darwin.close(streamDescriptor)
            throw Self.mapErrno(errno, "Could not list the directory")
        }
        defer { closedir(directory) }

        var output: [FileNodeInfo] = []
        while output.count < limit {
            errno = 0
            guard let entry = readdir(directory) else {
                if errno != 0 {
                    throw Self.mapErrno(errno, "Could not list the directory")
                }
                break
            }
            let name = Self.name(of: entry)
            if name == "." || name == ".." { continue }

            var status = stat()
            if fstatat(directoryDescriptor, name, &status, AT_SYMLINK_NOFOLLOW) != 0 {
                if errno == ENOENT { continue }
                throw Self.mapErrno(errno, "Could not inspect a directory entry")
            }
            /* Symlinks are not advertised. Every operation would refuse them, and
             * listing an unusable path makes the share look corrupt to the peer. */
            if (status.st_mode & S_IFMT) == S_IFLNK { continue }
            output.append(Self.info(
                status: status,
                name: name,
                parentDescriptor: directoryDescriptor,
                entryName: name
            ))
        }
        return output
    }

    func descriptorOpen(
        components: [String],
        write: Bool,
        createIfMissing: Bool,
        truncate: Bool
    ) async throws -> DescriptorRelativeOpen {
        try Self.validateNonRoot(components)
        let parent = try openParent(of: components)
        defer { Darwin.close(parent.descriptor) }

        /* Inspecting first gives a stable invalid_path result for an existing link;
         * O_NOFOLLOW is still mandatory because the entry can change afterwards. */
        var before = stat()
        if fstatat(parent.descriptor, parent.name, &before, AT_SYMLINK_NOFOLLOW) == 0 {
            try Self.rejectSymlink(before)
            if (before.st_mode & S_IFMT) == S_IFDIR {
                throw Zft2Error(code: "is_a_directory", message: "Cannot open a directory")
            }
            if (before.st_mode & S_IFMT) != S_IFREG {
                throw Zft2Error(code: "unsupported", message: "Only regular files can be opened")
            }
        } else if errno != ENOENT {
            throw Self.mapErrno(errno, "Could not inspect the file")
        } else if !createIfMissing {
            throw Zft2Error(code: "not_found", message: "The file does not exist")
        }

        /* O_NONBLOCK prevents a final entry raced to a FIFO or device from
         * suspending the provider before fstat can reject the special file. It has
         * no effect on regular-file I/O. */
        var flags: Int32 = (write ? O_RDWR : O_RDONLY) | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK
        if createIfMissing { flags |= O_CREAT }
        if truncate { flags |= O_TRUNC }
        let descriptor = openat(parent.descriptor, parent.name, flags, mode_t(0o644))
        guard descriptor >= 0 else {
            throw Self.mapErrno(errno, "Could not open the file")
        }

        var status = stat()
        guard fstat(descriptor, &status) == 0 else {
            let failure = errno
            Darwin.close(descriptor)
            throw Self.mapErrno(failure, "Could not inspect the open file")
        }
        guard (status.st_mode & S_IFMT) != S_IFDIR else {
            Darwin.close(descriptor)
            throw Zft2Error(code: "is_a_directory", message: "Cannot open a directory")
        }
        guard (status.st_mode & S_IFMT) == S_IFREG else {
            Darwin.close(descriptor)
            throw Zft2Error(code: "unsupported", message: "Only regular files can be opened")
        }

        let info = Self.info(
            status: status,
            name: parent.name,
            parentDescriptor: parent.descriptor,
            entryName: parent.name,
            knownReadable: true,
            knownWritable: write ? true : nil
        )
        return DescriptorRelativeOpen(info: info, access: PosixRandomAccess(descriptor: descriptor))
    }

    func descriptorCreateDirectory(components: [String]) async throws {
        try Self.validateNonRoot(components)
        let parent = try openParent(of: components)
        defer { Darwin.close(parent.descriptor) }

        var status = stat()
        if fstatat(parent.descriptor, parent.name, &status, AT_SYMLINK_NOFOLLOW) == 0 {
            if (status.st_mode & S_IFMT) == S_IFLNK { try Self.rejectSymlink(status) }
            throw Zft2Error(code: "already_exists", message: "The destination already exists")
        }
        if errno != ENOENT {
            throw Self.mapErrno(errno, "Could not inspect the destination")
        }
        if mkdirat(parent.descriptor, parent.name, mode_t(0o755)) != 0 {
            throw Self.mapErrno(errno, "Could not create the directory")
        }
    }

    func descriptorDelete(components: [String], recursive: Bool) async throws {
        try Self.validateNonRoot(components)
        let parent = try openParent(of: components)
        defer { Darwin.close(parent.descriptor) }
        try removeEntry(parentDescriptor: parent.descriptor, name: parent.name, recursive: recursive)
    }

    func descriptorMove(from: [String], to: [String]) async throws {
        try Self.validateNonRoot(from)
        try Self.validateNonRoot(to)
        let sourceParent = try openParent(of: from)
        defer { Darwin.close(sourceParent.descriptor) }
        let destinationParent = try openParent(of: to)
        defer { Darwin.close(destinationParent.descriptor) }

        var sourceStatus = stat()
        guard fstatat(
            sourceParent.descriptor,
            sourceParent.name,
            &sourceStatus,
            AT_SYMLINK_NOFOLLOW
        ) == 0 else {
            throw Self.mapErrno(errno, "Could not inspect the source")
        }
        try Self.rejectSymlink(sourceStatus)

        var destinationStatus = stat()
        if fstatat(
            destinationParent.descriptor,
            destinationParent.name,
            &destinationStatus,
            AT_SYMLINK_NOFOLLOW
        ) == 0 {
            throw Zft2Error(code: "already_exists", message: "The destination already exists")
        }
        if errno != ENOENT {
            throw Self.mapErrno(errno, "Could not inspect the destination")
        }

        /* RENAME_EXCL preserves the provider's no-clobber contract even if a
         * destination appears after fstatat. RENAME_NOFOLLOW_ANY makes a source
         * swapped to a symlink fail in the rename syscall itself. */
        if renameatx_np(
            sourceParent.descriptor,
            sourceParent.name,
            destinationParent.descriptor,
            destinationParent.name,
            UInt32(RENAME_EXCL | RENAME_NOFOLLOW_ANY)
        ) != 0 {
            if errno == EXDEV {
                throw Zft2Error(code: "unsupported", message: "Cannot move between volumes")
            }
            throw Self.mapErrno(errno, "Could not move the item")
        }
    }

    func descriptorTruncate(components: [String], size: Int64) async throws {
        let opened = try await descriptorOpen(
            components: components,
            write: true,
            createIfMissing: false,
            truncate: false
        )
        do {
            try await opened.access.truncate(size: size)
        } catch {
            await opened.access.close()
            throw error
        }
        await opened.access.close()
    }

    // MARK: - Legacy absolute-path seam

    public func canonicalPath(of absolutePath: String) throws -> String? {
        Self.realpath(absolutePath)
    }

    public func info(at absolutePath: String) async throws -> FileNodeInfo? {
        try await descriptorInfo(components: try components(forAbsolutePath: absolutePath))
    }

    public func children(at absolutePath: String) async throws -> [FileNodeInfo] {
        try await descriptorChildren(
            components: try components(forAbsolutePath: absolutePath),
            limit: Int.max
        )
    }

    public func createFile(at absolutePath: String) async throws {
        let opened = try await descriptorOpen(
            components: try components(forAbsolutePath: absolutePath),
            write: true,
            createIfMissing: true,
            truncate: false
        )
        await opened.access.close()
    }

    public func createDirectory(at absolutePath: String) async throws {
        try await descriptorCreateDirectory(components: try components(forAbsolutePath: absolutePath))
    }

    public func delete(at absolutePath: String, recursive: Bool) async throws {
        try await descriptorDelete(
            components: try components(forAbsolutePath: absolutePath),
            recursive: recursive
        )
    }

    public func move(from absolutePath: String, to destinationPath: String) async throws {
        try await descriptorMove(
            from: try components(forAbsolutePath: absolutePath),
            to: try components(forAbsolutePath: destinationPath)
        )
    }

    public func openAccess(at absolutePath: String, write: Bool) async throws -> Zft2RandomAccess {
        try await descriptorOpen(
            components: try components(forAbsolutePath: absolutePath),
            write: write,
            createIfMissing: false,
            truncate: false
        ).access
    }

    // MARK: - Security-scope lifecycle

    public func beginAccess() -> Bool {
        let claimed = !requiresSecurityScope || rootURL.startAccessingSecurityScopedResource()
        guard claimed else { return false }

        stateLock.lock()
        if rootDescriptor < 0 {
            let descriptor = Darwin.open(
                canonicalRoot,
                O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
            )
            if descriptor < 0 {
                stateLock.unlock()
                if requiresSecurityScope { rootURL.stopAccessingSecurityScopedResource() }
                return false
            }
            var status = stat()
            if fstat(descriptor, &status) != 0
                || status.st_dev != rootDevice
                || status.st_ino != rootInode
            {
                Darwin.close(descriptor)
                stateLock.unlock()
                if requiresSecurityScope { rootURL.stopAccessingSecurityScopedResource() }
                return false
            }
            rootDescriptor = descriptor
        }
        accessClaims += 1
        stateLock.unlock()
        return true
    }

    public func endAccess() {
        stateLock.lock()
        guard accessClaims > 0 else {
            stateLock.unlock()
            return
        }
        accessClaims -= 1
        let shouldClose = accessClaims == 0
        let descriptor = shouldClose ? rootDescriptor : -1
        if shouldClose { rootDescriptor = -1 }
        stateLock.unlock()

        if descriptor >= 0 { Darwin.close(descriptor) }
        if requiresSecurityScope { rootURL.stopAccessingSecurityScopedResource() }
    }

    // MARK: - Descriptor helpers

    private struct Parent {
        let descriptor: Int32
        let name: String
    }

    private func duplicateRootDescriptor() throws -> Int32 {
        stateLock.lock()
        let hasRootDescriptor = rootDescriptor >= 0
        let descriptor = hasRootDescriptor
            ? fcntl(rootDescriptor, F_DUPFD_CLOEXEC, 0)
            : -1
        let failure = errno
        stateLock.unlock()
        guard descriptor >= 0 else {
            throw Self.mapErrno(
                hasRootDescriptor ? failure : EACCES,
                "The shared directory is not accessible"
            )
        }
        return descriptor
    }

    private func openDirectory(_ components: [String]) throws -> Int32 {
        var current = try duplicateRootDescriptor()
        do {
            for component in components {
                var status = stat()
                if fstatat(current, component, &status, AT_SYMLINK_NOFOLLOW) != 0 {
                    throw Self.mapErrno(errno, "Could not inspect a path component")
                }
                try Self.rejectSymlink(status)
                guard (status.st_mode & S_IFMT) == S_IFDIR else {
                    throw Zft2Error(code: "not_a_directory", message: "A path component is not a directory")
                }
                let next = openat(
                    current,
                    component,
                    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
                )
                guard next >= 0 else {
                    throw Self.mapErrno(errno, "Could not open a path component")
                }
                Darwin.close(current)
                current = next
            }
            return current
        } catch {
            Darwin.close(current)
            throw error
        }
    }

    private func openParent(of components: [String]) throws -> Parent {
        guard let name = components.last else {
            throw Zft2Error(code: "invalid_path", message: "The share root has no parent entry")
        }
        return Parent(
            descriptor: try openDirectory(Array(components.dropLast())),
            name: name
        )
    }

    private func removeEntry(parentDescriptor: Int32, name: String, recursive: Bool) throws {
        var status = stat()
        guard fstatat(parentDescriptor, name, &status, AT_SYMLINK_NOFOLLOW) == 0 else {
            throw Self.mapErrno(errno, "Could not inspect the item")
        }
        try Self.rejectSymlink(status)

        if (status.st_mode & S_IFMT) == S_IFDIR {
            if recursive {
                let directoryDescriptor = openat(
                    parentDescriptor,
                    name,
                    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
                )
                guard directoryDescriptor >= 0 else {
                    throw Self.mapErrno(errno, "Could not open the directory")
                }
                do {
                    try removeContents(of: directoryDescriptor)
                } catch {
                    Darwin.close(directoryDescriptor)
                    throw error
                }
                Darwin.close(directoryDescriptor)
            }
            if unlinkat(parentDescriptor, name, AT_REMOVEDIR) != 0 {
                throw Self.mapErrno(errno, "Could not delete the directory")
            }
            return
        }

        if unlinkat(parentDescriptor, name, 0) != 0 {
            throw Self.mapErrno(errno, "Could not delete the file")
        }
    }

    private func removeContents(of directoryDescriptor: Int32) throws {
        let streamDescriptor = fcntl(directoryDescriptor, F_DUPFD_CLOEXEC, 0)
        guard streamDescriptor >= 0 else {
            throw Self.mapErrno(errno, "Could not read the directory")
        }
        guard let directory = fdopendir(streamDescriptor) else {
            Darwin.close(streamDescriptor)
            throw Self.mapErrno(errno, "Could not read the directory")
        }
        defer { closedir(directory) }

        while true {
            errno = 0
            guard let entry = readdir(directory) else {
                if errno != 0 { throw Self.mapErrno(errno, "Could not read the directory") }
                return
            }
            let child = Self.name(of: entry)
            if child == "." || child == ".." { continue }
            do {
                try removeEntry(parentDescriptor: directoryDescriptor, name: child, recursive: true)
            } catch let error as Zft2Error where error.code == "not_found" {
                /* A concurrently removed entry is already in the requested state. */
                continue
            }
        }
    }

    private func components(forAbsolutePath absolutePath: String) throws -> [String] {
        if absolutePath == canonicalRoot { return [] }
        let prefix = canonicalRoot + "/"
        guard absolutePath.hasPrefix(prefix) else {
            throw Zft2Error(code: "invalid_path", message: "Path escapes the shared directory")
        }
        let components = String(absolutePath.dropFirst(prefix.count))
            .split(separator: "/", omittingEmptySubsequences: false)
            .map(String.init)
        try Self.validate(components)
        return components
    }

    private static func validate(_ components: [String]) throws {
        for component in components {
            try SecurityScopedFileProvider.requireAddressableName(component)
        }
    }

    private static func validateNonRoot(_ components: [String]) throws {
        guard !components.isEmpty else {
            throw Zft2Error(code: "invalid_path", message: "Operation is not permitted on the share root")
        }
        try validate(components)
    }

    private static func rejectSymlink(_ status: stat) throws {
        if (status.st_mode & S_IFMT) == S_IFLNK {
            throw Zft2Error(code: "invalid_path", message: "Symbolic links are not permitted")
        }
    }

    private static func info(
        status: stat,
        name: String,
        parentDescriptor: Int32,
        entryName: String,
        knownReadable: Bool? = nil,
        knownWritable: Bool? = nil
    ) -> FileNodeInfo {
        let isDirectory = (status.st_mode & S_IFMT) == S_IFDIR
        return FileNodeInfo(
            name: name,
            isDirectory: isDirectory,
            isSymlink: false,
            size: Int64(status.st_size),
            mtime: Int64(status.st_mtimespec.tv_sec) * 1000
                + Int64(status.st_mtimespec.tv_nsec) / 1_000_000,
            canRead: knownReadable
                ?? (faccessat(parentDescriptor, entryName, R_OK, AT_SYMLINK_NOFOLLOW) == 0),
            canWrite: knownWritable
                ?? (faccessat(parentDescriptor, entryName, W_OK, AT_SYMLINK_NOFOLLOW) == 0)
        )
    }

    private static func name(of entry: UnsafeMutablePointer<dirent>) -> String {
        var tuple = entry.pointee.d_name
        return withUnsafePointer(to: &tuple) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) {
                String(cString: $0)
            }
        }
    }

    static func realpath(_ path: String) -> String? {
        guard let buffer = Darwin.realpath(path, nil) else { return nil }
        defer { free(buffer) }
        return String(cString: buffer)
    }

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
        case ELOOP:
            wire = "invalid_path"
        default:
            wire = "io_error"
        }
        return Zft2Error(code: wire, message: what)
    }
}

/// Positional reads and writes on one descriptor.
actor PosixRandomAccess: Zft2RandomAccess {

    private var descriptor: Int32
    private var closed = false

    init(descriptor: Int32) {
        self.descriptor = descriptor
    }

    func readAt(offset: Int64, length: Int) async throws -> Data {
        if length <= 0 { return Data() }
        try requireOpen()
        guard length <= SecurityScopedFileProvider.defaultMaxReadBytes else {
            throw Zft2Error(code: "invalid_argument", message: "Read exceeds the chunk limit")
        }
        guard offset >= 0, Int64(length) <= Int64.max - offset else {
            throw Zft2Error(code: "invalid_argument", message: "Read range is too large")
        }

        var buffer = [UInt8](repeating: 0, count: length)
        var filled = 0
        while filled < length {
            let count = buffer.withUnsafeMutableBytes { raw -> Int in
                guard let start = raw.baseAddress else { return 0 }
                return pread(
                    descriptor,
                    start + filled,
                    length - filled,
                    off_t(offset + Int64(filled))
                )
            }
            if count < 0 {
                if errno == EINTR { continue }
                throw PosixSecurityScopedFileSystem.mapErrno(errno, "Read failed")
            }
            if count == 0 { break }
            filled += count
        }
        return Data(buffer.prefix(filled))
    }

    func writeAt(offset: Int64, data: Data) async throws -> Int {
        try requireOpen()
        if data.isEmpty { return 0 }
        guard offset >= 0, Int64(data.count) <= Int64.max - offset else {
            throw Zft2Error(code: "invalid_argument", message: "Write range is too large")
        }

        let bytes = [UInt8](data)
        var written = 0
        while written < bytes.count {
            let count = bytes.withUnsafeBytes { raw -> Int in
                guard let start = raw.baseAddress else { return 0 }
                return pwrite(
                    descriptor,
                    start + written,
                    bytes.count - written,
                    off_t(offset + Int64(written))
                )
            }
            if count < 0 {
                if errno == EINTR { continue }
                throw PosixSecurityScopedFileSystem.mapErrno(errno, "Write failed")
            }
            if count == 0 {
                throw Zft2Error(code: "io_error", message: "Write made no progress")
            }
            written += count
        }
        return written
    }

    func truncate(size: Int64) async throws {
        try requireOpen()
        guard size >= 0 else {
            throw Zft2Error(code: "invalid_argument", message: "Negative truncate size")
        }
        while ftruncate(descriptor, off_t(size)) != 0 {
            if errno == EINTR { continue }
            throw PosixSecurityScopedFileSystem.mapErrno(errno, "Truncate failed")
        }
    }

    func close() async {
        guard !closed else { return }
        closed = true
        Darwin.close(descriptor)
        descriptor = -1
    }

    private func requireOpen() throws {
        if closed {
            throw Zft2Error(code: "not_found", message: "The file is closed")
        }
    }
}
