import Foundation
import ZephyrContracts

/// The result of opening a file relative to an already-open authorised root.
struct DescriptorRelativeOpen: Sendable {
    let info: FileNodeInfo
    let access: Zft2RandomAccess
}

/// The security boundary used by ``SecurityScopedFileProvider``.
///
/// Paths are validated virtual-path components, never absolute host paths. The
/// implementation must start at a held descriptor for the authorised root and
/// refuse symbolic links in every ancestor and at the target. This keeps the
/// check and the syscall in the same descriptor-relative walk, so replacing a
/// canonicalised ancestor cannot redirect a later open, create, delete, rename,
/// or truncate outside the grant.
protocol DescriptorRelativeSecurityScopedFileSystem: SecurityScopedFileSystem {
    func descriptorInfo(components: [String]) async throws -> FileNodeInfo?
    func descriptorChildren(components: [String], limit: Int) async throws -> [FileNodeInfo]
    func descriptorOpen(
        components: [String],
        write: Bool,
        createIfMissing: Bool,
        truncate: Bool
    ) async throws -> DescriptorRelativeOpen
    func descriptorCreateDirectory(components: [String]) async throws
    func descriptorDelete(components: [String], recursive: Bool) async throws
    func descriptorMove(from: [String], to: [String]) async throws
    func descriptorTruncate(components: [String], size: Int64) async throws
}

/// The iOS half of the ZFT2 provider, over a security-scoped root.
///
/// Every filesystem operation is expressed relative to a held root descriptor.
/// Virtual-path validation rejects traversal and the platform walk rejects every
/// ancestor or target symlink with `O_NOFOLLOW`/`AT_SYMLINK_NOFOLLOW`. Static
/// `realpath` results are deliberately not used as authority for a later syscall:
/// a path name can be replaced after `realpath` returns.
public actor SecurityScopedFileProvider: Zft2FileProvider {

    private struct OpenFile {
        let path: String
        let writable: Bool
        let access: Zft2RandomAccess
    }

    private enum Lifecycle: Equatable {
        case active
        case closing
        case closed
    }

    private let fileSystem: SecurityScopedFileSystem
    private let descriptorFileSystem: DescriptorRelativeSecurityScopedFileSystem?
    private let readOnly: Bool
    private let maxOpenHandles: Int
    private let maxListEntries: Int
    private let maxReadBytes: Int

    private var handles: [String: OpenFile] = [:]
    private var accessClaims = 0
    private var lifecycle = Lifecycle.active
    /// Includes operations suspended in a filesystem or random-access call. The
    /// security-scope claim cannot be released until this reaches zero.
    private var inFlightOperations = 0

    public init(
        fileSystem: SecurityScopedFileSystem,
        readOnly: Bool,
        maxOpenHandles: Int = SecurityScopedFileProvider.defaultMaxOpenHandles,
        maxListEntries: Int = SecurityScopedFileProvider.defaultMaxListEntries,
        maxReadBytes: Int = SecurityScopedFileProvider.defaultMaxReadBytes
    ) {
        self.fileSystem = fileSystem
        self.descriptorFileSystem = fileSystem as? DescriptorRelativeSecurityScopedFileSystem
        self.readOnly = readOnly
        self.maxOpenHandles = max(0, maxOpenHandles)
        self.maxListEntries = max(0, maxListEntries)
        /* The negotiated value may narrow the protocol ceiling, but must never
         * raise it. Keeping the lower bound positive also prevents a malformed
         * configuration from disabling the allocation guard. */
        self.maxReadBytes = min(max(1, maxReadBytes), Self.defaultMaxReadBytes)
    }

    // MARK: - Zft2FileProvider

    public func list(path: String) async throws -> [Zft2FileStat] {
        try beginOperation()
        defer { finishOperation() }

        let normalized = try VirtualPath.normalize(path)
        let fileSystem = try requireDescriptorFileSystem()
        let components = Self.components(of: normalized)
        guard let info = try await fileSystem.descriptorInfo(components: components) else {
            throw Zft2Error(code: "not_found", message: "Not found: " + normalized)
        }
        guard info.isDirectory else {
            throw Zft2Error(code: "not_a_directory", message: "Not a directory: " + normalized)
        }

        /* One extra entry is collected so the dispatcher can report its existing
         * too-many-entries error rather than receiving a silently truncated list.
         * The filesystem stops readdir at this bound and never materialises the
         * rest of a hostile million-entry directory. */
        let limit = maxListEntries == Int.max ? Int.max : maxListEntries + 1
        let children = try await fileSystem.descriptorChildren(components: components, limit: limit)
        var entries: [Zft2FileStat] = []
        entries.reserveCapacity(min(children.count, limit))
        for child in children {
            guard let childPath = joinChild(parent: normalized, name: child.name) else { continue }
            /* Descriptor implementations omit symlinks. Keep this check at the
             * boundary as a fail-closed assertion for alternate implementations. */
            guard !child.isSymlink else { continue }
            entries.append(stat(for: child, at: childPath))
            if entries.count >= limit { break }
        }
        return entries
    }

    public func stat(path: String) async throws -> Zft2FileStat {
        try beginOperation()
        defer { finishOperation() }

        let normalized = try VirtualPath.normalize(path)
        let fileSystem = try requireDescriptorFileSystem()
        guard let info = try await fileSystem.descriptorInfo(components: Self.components(of: normalized)) else {
            throw Zft2Error(code: "not_found", message: "Not found: " + normalized)
        }
        return stat(for: info, at: normalized)
    }

    public func open(path: String, mode: String) async throws -> String {
        try beginOperation()
        defer { finishOperation() }

        let normalized = try VirtualPath.normalize(path)
        guard let openMode = Zft2OpenMode(rawValue: mode) else {
            throw Zft2Error(code: "invalid_argument", message: "Unsupported open mode " + mode)
        }
        let wantsWrite = openMode != .read
        if wantsWrite && readOnly {
            throw Zft2Error(code: "read_only", message: "Share is read-only")
        }
        guard handles.count < maxOpenHandles else {
            throw Zft2Error(code: "too_many_handles", message: "Too many open handles")
        }

        let fileSystem = try requireDescriptorFileSystem()
        let opened = try await fileSystem.descriptorOpen(
            components: Self.components(of: normalized),
            write: wantsWrite,
            createIfMissing: wantsWrite,
            truncate: openMode == .writeTruncate
        )

        /* `closeAll` may run while descriptorOpen is suspended. Once closing has
         * started, the newly returned descriptor is closed instead of being added
         * behind the drain loop. */
        guard lifecycle == .active else {
            await opened.access.close()
            throw Self.closingError()
        }
        if handles.count >= maxOpenHandles {
            await opened.access.close()
            throw Zft2Error(code: "too_many_handles", message: "Too many open handles")
        }
        if opened.info.isDirectory {
            await opened.access.close()
            throw Zft2Error(code: "is_a_directory", message: "Cannot open a directory: " + normalized)
        }

        let handle = Self.newHandle()
        handles[handle] = OpenFile(path: normalized, writable: wantsWrite, access: opened.access)
        return handle
    }

    public func read(handle: String, offset: Int64, length: Int) async throws -> Data {
        try beginOperation()
        defer { finishOperation() }

        if offset < 0 {
            throw Zft2Error(code: "invalid_argument", message: "Negative read offset")
        }
        if length <= 0 { return Data() }
        let open = try requireHandle(handle)
        /* The dispatcher normally clamps to the negotiated chunk. This fixed
         * protocol ceiling is repeated here because this provider is also reached
         * from JSON-RPC and must never allocate an attacker-supplied `Int.max`. */
        return try await open.access.readAt(offset: offset, length: min(length, maxReadBytes))
    }

    public func write(handle: String, offset: Int64, data: Data) async throws -> Int {
        try beginOperation()
        defer { finishOperation() }

        if readOnly {
            throw Zft2Error(code: "read_only", message: "Share is read-only")
        }
        if offset < 0 {
            throw Zft2Error(code: "invalid_argument", message: "Negative write offset")
        }
        let open = try requireHandle(handle)
        guard open.writable else {
            throw Zft2Error(code: "read_only", message: "Handle is open for reading")
        }
        return try await open.access.writeAt(offset: offset, data: data)
    }

    public func close(handle: String) async throws {
        guard beginCloseOperation() else { return }
        defer { finishOperation() }

        /* CLOSE remains idempotent during shutdown. It is cleanup, not a new file
         * operation, so allowing it helps the closing drain converge. */
        guard let open = handles.removeValue(forKey: handle) else { return }
        await open.access.close()
    }

    public func mkdir(path: String) async throws {
        try beginOperation()
        defer { finishOperation() }
        try requireWritable()

        let normalized = try VirtualPath.normalize(path)
        if normalized == Self.root {
            throw Zft2Error(code: "already_exists", message: "Root already exists")
        }
        try Self.requireAddressableName(VirtualPath.basename(normalized))
        try await requireDescriptorFileSystem().descriptorCreateDirectory(
            components: Self.components(of: normalized)
        )
    }

    public func delete(path: String, recursive: Bool) async throws {
        try beginOperation()
        defer { finishOperation() }
        try requireWritable()

        let normalized = try VirtualPath.normalize(path)
        if normalized == Self.root {
            throw Zft2Error(code: "invalid_path", message: "Cannot delete the share root")
        }
        try await requireDescriptorFileSystem().descriptorDelete(
            components: Self.components(of: normalized),
            recursive: recursive
        )
    }

    public func rename(oldPath: String, newPath: String) async throws {
        try beginOperation()
        defer { finishOperation() }
        try requireWritable()

        let from = try VirtualPath.normalize(oldPath)
        let to = try VirtualPath.normalize(newPath)
        if from == Self.root || to == Self.root {
            throw Zft2Error(code: "invalid_path", message: "Cannot rename the share root")
        }
        if from == to {
            throw Zft2Error(code: "invalid_path", message: "Rename source equals destination")
        }
        if VirtualPath.isWithin(root: from, candidate: to) {
            throw Zft2Error(code: "invalid_path", message: "Cannot move a directory into itself")
        }
        try Self.requireAddressableName(VirtualPath.basename(to))
        try await requireDescriptorFileSystem().descriptorMove(
            from: Self.components(of: from),
            to: Self.components(of: to)
        )
    }

    public func truncate(path: String, size: Int64) async throws {
        try beginOperation()
        defer { finishOperation() }
        try requireWritable()

        if size < 0 {
            throw Zft2Error(code: "invalid_argument", message: "Negative truncate size")
        }
        let normalized = try VirtualPath.normalize(path)
        try await requireDescriptorFileSystem().descriptorTruncate(
            components: Self.components(of: normalized),
            size: size
        )
    }

    public func closeAll() async {
        switch lifecycle {
        case .active:
            lifecycle = .closing
        case .closing:
            /* Exactly one closeAll owns claim release. A concurrent caller waits;
             * otherwise it could release the claim while the owner is suspended
             * closing a descriptor. */
            while lifecycle != .closed {
                await Task<Never, Never>.yield()
            }
            return
        case .closed:
            return
        }

        /* Operations that entered before the closing fence may still be suspended.
         * Drain in a loop: an in-flight open either closes itself after observing
         * `.closing`, or (for a non-conforming implementation) becomes visible in
         * `handles` and is collected by the next pass. */
        while inFlightOperations > 0 || !handles.isEmpty {
            let open = Array(handles.values)
            handles.removeAll()
            for entry in open {
                await entry.access.close()
            }
            if inFlightOperations > 0 || !handles.isEmpty {
                await Task<Never, Never>.yield()
            }
        }

        /* Claims are released only after every operation and descriptor drained.
         * Closing the POSIX root descriptor at the final endAccess is therefore
         * ordered after all descriptor-relative syscalls. */
        while accessClaims > 0 {
            fileSystem.endAccess()
            accessClaims -= 1
        }
        lifecycle = .closed
    }

    public func openHandleCount() -> Int { handles.count }

    public func accessClaimCount() -> Int { accessClaims }

    public func beginAccess() throws {
        guard lifecycle == .active else { throw Self.closingError() }
        guard descriptorFileSystem != nil else {
            throw Zft2Error(code: "unsupported", message: "Secure relative filesystem unavailable")
        }
        guard fileSystem.beginAccess() else {
            throw Zft2Error(
                code: "permission_denied",
                message: "The shared directory is no longer available"
            )
        }
        accessClaims += 1
    }

    // MARK: - Operation fence

    private func beginOperation() throws {
        guard lifecycle == .active else { throw Self.closingError() }
        guard descriptorFileSystem != nil else {
            throw Zft2Error(code: "unsupported", message: "Secure relative filesystem unavailable")
        }
        inFlightOperations += 1
    }

    private func beginCloseOperation() -> Bool {
        guard lifecycle != .closed else { return false }
        inFlightOperations += 1
        return true
    }

    private func finishOperation() {
        precondition(inFlightOperations > 0)
        inFlightOperations -= 1
    }

    private static func closingError() -> Zft2Error {
        Zft2Error(code: "not_found", message: "The shared file provider is closing")
    }

    // MARK: - Helpers

    private func requireDescriptorFileSystem() throws -> DescriptorRelativeSecurityScopedFileSystem {
        guard let descriptorFileSystem else {
            throw Zft2Error(code: "unsupported", message: "Secure relative filesystem unavailable")
        }
        return descriptorFileSystem
    }

    private func requireHandle(_ handle: String) throws -> OpenFile {
        guard let open = handles[handle] else {
            throw Zft2Error(code: "not_found", message: "Invalid handle")
        }
        return open
    }

    private func requireWritable() throws {
        if readOnly {
            throw Zft2Error(code: "read_only", message: "Share is read-only")
        }
    }

    private func stat(for info: FileNodeInfo, at path: String) -> Zft2FileStat {
        Zft2FileStat(
            name: path == Self.root ? "" : VirtualPath.basename(path),
            path: path,
            isDir: info.isDirectory,
            size: info.isDirectory ? 0 : info.size,
            mtime: info.mtime,
            canRead: info.canRead,
            canWrite: info.canWrite && !readOnly
        )
    }

    static func requireAddressableName(_ name: String) throws {
        if name.isEmpty {
            throw Zft2Error(code: "invalid_path", message: "Empty name")
        }
        if name == "." || name == ".." {
            throw Zft2Error(code: "invalid_path", message: "Relative name")
        }
        if name.contains("/") || name.contains("\\") {
            throw Zft2Error(code: "invalid_path", message: "Name contains a path separator")
        }
        if name.utf8.count > VirtualPath.maxSegmentLength {
            throw Zft2Error(code: "invalid_path", message: "Name is too long")
        }
        for scalar in name.unicodeScalars where scalar.value < 0x20 || scalar.value == 0x7f {
            throw Zft2Error(code: "invalid_path", message: "Name contains control characters")
        }
    }

    private static func components(of normalized: String) -> [String] {
        normalized == root ? [] : normalized.split(separator: "/").map(String.init)
    }

    private func joinChild(parent: String, name: String) -> String? {
        do {
            try Self.requireAddressableName(name)
            return try VirtualPath.normalize(parent == Self.root ? "/" + name : parent + "/" + name)
        } catch {
            return nil
        }
    }

    static func newHandle() -> String {
        var generator = SystemRandomNumberGenerator()
        var text = "h_"
        for _ in 0..<(handleBytes / 8) {
            let chunk = UInt64.random(in: UInt64.min...UInt64.max, using: &generator)
            text += String(chunk, radix: 16).leftPadded(to: 16, with: "0")
        }
        return text
    }

    public static let defaultMaxOpenHandles = 64
    public static let defaultMaxListEntries = 2000
    /// Frozen ZFT2 payload ceiling. A negotiated value can only narrow it.
    public static let defaultMaxReadBytes = Zft2Contract.maxPayloadBytes

    static let root = "/"
    private static let handleBytes = 16
}

extension String {
    func leftPadded(to width: Int, with pad: Character) -> String {
        if count >= width { return self }
        return String(repeating: pad, count: width - count) + self
    }
}
