import Foundation

/// The iOS half of the ZFT2 provider, over a security-scoped root.
///
/// The counterpart of `SafZft2FileProvider` on Android, and the reason both exist
/// is recorded in DEVELOPMENT.md 2.2 as M3's open blocker: the ZFT2 dispatcher,
/// the codec, the frame reader and the path jail were all present and tested on
/// both platforms, but neither had anything that could serve a byte. F-027 was
/// `missing` for exactly that reason.
///
/// Written against ``SecurityScopedFileSystem`` rather than `FileManager`
/// directly, so the jail, the read-only refusals, handle binding and the limits
/// run under `swift test` on a plain host with no simulator and no user-granted
/// URL. Only the macOS CI runner compiles this tree, so logic that needs a device
/// is logic nobody exercises.
///
/// ## Why the jail is shaped differently from Android's
///
/// The Android provider resolves a path by walking child-by-child from the
/// granted root, which makes traversal *unreachable*: SAF addresses documents by
/// opaque id, `..` is not a name any child has, and there is no link concept to
/// abuse. None of that holds here. A security-scoped root is a real directory on
/// a real filesystem, so:
///
/// * `..` is rejected by ``VirtualPath/normalize(_:)`` before anything is joined,
///   and
/// * every resolved path is canonicalised -- symlinks and all -- and re-checked
///   for containment against the canonical root.
///
/// The second check is the one that does the work, and it must canonicalise the
/// whole path rather than the last component. A link in the *middle* of a path is
/// the case a prefix test on the unresolved string misses completely: with
/// `/root/link -> /etc`, the string `/root/link/passwd` is inside `/root` by any
/// textual measure and resolves to `/etc/passwd`.
///
/// A path that cannot be judged is refused rather than guessed at, which is what
/// DEVELOPMENT.md 13.4 requires.
public actor SecurityScopedFileProvider: Zft2FileProvider {

    /// One open file, bound to the path and mode it was opened with.
    ///
    /// The binding is the security property, not bookkeeping: DEVELOPMENT.md 13.3
    /// requires each handle to carry its canonical path and access mode, so a
    /// handle opened for reading cannot be written through even if the peer sends
    /// a WRITE naming it.
    private struct OpenFile {
        let path: String
        let hostPath: String
        let writable: Bool
        let access: Zft2RandomAccess
    }

    private let fileSystem: SecurityScopedFileSystem

    /// The effective read-only value, already narrowed to the strictest of
    /// profile, connection and server by the RDP drive policy.
    ///
    /// Enforced again here, per operation. ADR-004 requires it: there is no single
    /// trustworthy read-only switch at the protocol layer, and a dispatcher that
    /// refuses write ops is not enough on its own, because the JSON-RPC surface
    /// reaches this provider too.
    private let readOnly: Bool
    private let maxOpenHandles: Int
    private let maxListEntries: Int

    private var handles: [String: OpenFile] = [:]
    /// Balanced claim count. `beginAccess()` is reference-counted by the OS, and
    /// leaking one keeps a sandbox extension alive after the user stopped the
    /// share; releasing one we never took would unbalance someone else's.
    private var accessClaims = 0

    public init(
        fileSystem: SecurityScopedFileSystem,
        readOnly: Bool,
        maxOpenHandles: Int = SecurityScopedFileProvider.defaultMaxOpenHandles,
        maxListEntries: Int = SecurityScopedFileProvider.defaultMaxListEntries
    ) {
        self.fileSystem = fileSystem
        self.readOnly = readOnly
        self.maxOpenHandles = maxOpenHandles
        self.maxListEntries = maxListEntries
    }

    // MARK: - Zft2FileProvider

    public func list(path: String) async throws -> [Zft2FileStat] {
        let target = try await resolveExisting(path)
        guard target.info.isDirectory else {
            throw Zft2Error(code: "not_a_directory", message: "Not a directory: " + target.path)
        }

        var entries: [Zft2FileStat] = []
        for child in try await fileSystem.children(at: target.hostPath) {
            /* A name the virtual-path layer would reject is skipped rather than
             * listed. Offering it would advertise a file the peer then cannot
             * address -- every later op on that name is refused by normalize() --
             * and a name carrying a separator or a control character is a classic
             * way to spoof a different path in the main end's file browser. One
             * hostile name must not fail the whole listing. */
            guard let childPath = joinChild(parent: target.path, name: child.name) else { continue }

            /* A symlink is listed but never followed for its metadata. Reporting
             * the target's size and type would describe a file the peer cannot
             * open, because opening it goes through the containment check below.
             * Escaping links are dropped entirely: advertising one invites a
             * request that will be refused. */
            if child.isSymlink {
                guard let resolved = try fileSystem.canonicalPath(of: target.hostPath + "/" + child.name),
                      VirtualPath.isWithin(root: fileSystem.rootPath, candidate: resolved)
                else { continue }
            }

            entries.append(stat(for: child, at: childPath))
            /* Bounded while building, not after. The dispatcher checks the count
             * too, but it can only do so once the whole list is in memory, and a
             * directory with a million children is exactly the case where that
             * allocation is the problem. One extra entry is collected so the
             * dispatcher's own limit still trips rather than this silently
             * truncating a directory. */
            if entries.count > maxListEntries { break }
        }
        return entries
    }

    public func stat(path: String) async throws -> Zft2FileStat {
        let target = try await resolveExisting(path)
        return stat(for: target.info, at: target.path)
    }

    public func open(path: String, mode: String) async throws -> String {
        let normalized = try VirtualPath.normalize(path)
        guard let openMode = Zft2OpenMode(rawValue: mode) else {
            throw Zft2Error(code: "invalid_argument", message: "Unsupported open mode " + mode)
        }
        let wantsWrite = openMode != .read
        if wantsWrite && readOnly {
            throw Zft2Error(code: "read_only", message: "Share is read-only")
        }

        /* Checked before touching the platform: refusing a handle-exhaustion
         * attempt must be cheap, and opening a descriptor we are about to reject
         * would leak it. Re-checked after the await below, because an actor
         * suspends there and two concurrent opens both pass a check made before
         * either inserted. */
        if handles.count >= maxOpenHandles {
            throw Zft2Error(code: "too_many_handles", message: "Too many open handles")
        }

        let target: Resolved
        if wantsWrite {
            target = try await resolveForWrite(normalized)
        } else {
            target = try await resolveExisting(normalized)
        }

        if target.info.isDirectory {
            throw Zft2Error(code: "is_a_directory", message: "Cannot open a directory: " + normalized)
        }
        guard target.info.canRead else {
            throw Zft2Error(code: "permission_denied", message: "Not readable: " + normalized)
        }
        if wantsWrite && !target.info.canWrite {
            /* The platform's answer overrides the config's optimism. A bookmark
             * can go stale, or the file can sit on a read-only volume, and
             * discovering that on the first WRITE means the remote has already
             * started copying. */
            throw Zft2Error(code: "permission_denied", message: "Not writable: " + normalized)
        }

        let access = try await fileSystem.openAccess(at: target.hostPath, write: wantsWrite)
        if openMode == .writeTruncate {
            try await access.truncate(size: 0)
        }

        if handles.count >= maxOpenHandles {
            await access.close()
            throw Zft2Error(code: "too_many_handles", message: "Too many open handles")
        }
        let handle = Self.newHandle()
        handles[handle] = OpenFile(
            path: normalized,
            hostPath: target.hostPath,
            writable: wantsWrite,
            access: access
        )
        return handle
    }

    public func read(handle: String, offset: Int64, length: Int) async throws -> Data {
        if offset < 0 {
            throw Zft2Error(code: "invalid_argument", message: "Negative read offset")
        }
        if length <= 0 { return Data() }
        let open = try requireHandle(handle)
        return try await open.access.readAt(offset: offset, length: length)
    }

    public func write(handle: String, offset: Int64, data: Data) async throws -> Int {
        if readOnly {
            throw Zft2Error(code: "read_only", message: "Share is read-only")
        }
        if offset < 0 {
            throw Zft2Error(code: "invalid_argument", message: "Negative write offset")
        }
        let open = try requireHandle(handle)
        /* The mode the handle was opened with decides, not the current frame. A
         * peer that opens for reading and then sends WRITE naming that handle is
         * refused here. */
        guard open.writable else {
            throw Zft2Error(code: "read_only", message: "Handle is open for reading")
        }
        return try await open.access.writeAt(offset: offset, data: data)
    }

    public func close(handle: String) async throws {
        /* Closing an unknown handle succeeds. CLOSE is idempotent on the wire: a
         * peer that retries after a dropped response must not receive an error for
         * work already done. */
        guard let open = handles.removeValue(forKey: handle) else { return }
        await open.access.close()
    }

    public func mkdir(path: String) async throws {
        try requireWritable()
        let normalized = try VirtualPath.normalize(path)
        if normalized == Self.root {
            throw Zft2Error(code: "already_exists", message: "Root already exists")
        }
        let name = VirtualPath.basename(normalized)
        try Self.requireAddressableName(name)

        let parent = try await resolveExisting(VirtualPath.parent(normalized))
        guard parent.info.isDirectory else {
            throw Zft2Error(code: "not_a_directory", message: "Parent is not a directory")
        }
        try requireWritableTarget(parent.info)

        let hostPath = parent.hostPath + "/" + name
        let existing = try await fileSystem.info(at: hostPath)
        if existing != nil {
            throw Zft2Error(code: "already_exists", message: "Already exists: " + normalized)
        }
        try await fileSystem.createDirectory(at: hostPath)
    }

    public func delete(path: String, recursive: Bool) async throws {
        try requireWritable()
        let normalized = try VirtualPath.normalize(path)
        /* Deleting the granted root would revoke the share from inside a file
         * operation. The peer asked to delete a directory, not to give up the
         * grant. */
        if normalized == Self.root {
            throw Zft2Error(code: "invalid_path", message: "Cannot delete the share root")
        }

        let target = try await resolveExisting(normalized)
        try requireWritableTarget(target.info)
        if target.info.isDirectory && !recursive {
            /* Refused explicitly rather than left to the platform: a
             * non-recursive request over a non-empty directory must not quietly
             * become recursive, which would be data loss the peer did not ask
             * for. */
            let children = try await fileSystem.children(at: target.hostPath)
            if !children.isEmpty {
                throw Zft2Error(code: "not_empty", message: "Directory is not empty: " + normalized)
            }
        }
        try await fileSystem.delete(at: target.hostPath, recursive: recursive)
    }

    public func rename(oldPath: String, newPath: String) async throws {
        try requireWritable()
        let from = try VirtualPath.normalize(oldPath)
        let to = try VirtualPath.normalize(newPath)
        if from == Self.root || to == Self.root {
            throw Zft2Error(code: "invalid_path", message: "Cannot rename the share root")
        }
        if from == to {
            throw Zft2Error(code: "invalid_path", message: "Rename source equals destination")
        }
        /* Renaming a directory into itself would detach the subtree: the moved node
         * becomes its own ancestor and everything under it stops resolving. POSIX
         * rename(2) reports EINVAL for this, but the check is here so the peer gets
         * a wire code rather than a mapped errno. */
        if VirtualPath.isWithin(root: from, candidate: to) {
            throw Zft2Error(code: "invalid_path", message: "Cannot move a directory into itself")
        }

        let newName = VirtualPath.basename(to)
        try Self.requireAddressableName(newName)

        let source = try await resolveExisting(from)
        try requireWritableTarget(source.info)
        let destinationParent = try await resolveExisting(VirtualPath.parent(to))
        guard destinationParent.info.isDirectory else {
            throw Zft2Error(code: "not_a_directory", message: "Destination parent is not a directory")
        }
        try requireWritableTarget(destinationParent.info)

        let destination = destinationParent.hostPath + "/" + newName
        let occupant = try await fileSystem.info(at: destination)
        if occupant != nil {
            throw Zft2Error(code: "already_exists", message: "Destination exists: " + to)
        }
        try await fileSystem.move(from: source.hostPath, to: destination)
    }

    public func truncate(path: String, size: Int64) async throws {
        try requireWritable()
        if size < 0 {
            throw Zft2Error(code: "invalid_argument", message: "Negative truncate size")
        }
        let normalized = try VirtualPath.normalize(path)
        let target = try await resolveExisting(normalized)
        if target.info.isDirectory {
            throw Zft2Error(code: "is_a_directory", message: "Cannot truncate a directory: " + normalized)
        }
        try requireWritableTarget(target.info)

        let access = try await fileSystem.openAccess(at: target.hostPath, write: true)
        do {
            try await access.truncate(size: size)
        } catch {
            /* Closed even when truncate throws. This descriptor is not tracked in
             * `handles`, so nothing else would ever close it. */
            await access.close()
            throw error
        }
        await access.close()
    }

    public func closeAll() async {
        /* Copied into an Array before clearing. Dictionary.Values is a view onto
         * the dictionary, and reading it after removeAll() is a trap worth not
         * setting even though CoW happens to save it today. */
        let open = Array(handles.values)
        handles.removeAll()
        for entry in open {
            await entry.access.close()
        }
        /* Every claim released, not one. The share is going away, and a residual
         * claim keeps a sandbox extension alive after the user stopped it. */
        while accessClaims > 0 {
            fileSystem.endAccess()
            accessClaims -= 1
        }
    }

    /// Open handle count, for tests and for the file-sync screen's diagnostics.
    public func openHandleCount() -> Int { handles.count }

    /// Outstanding security-scoped claims. Must be zero once the bridge stops.
    public func accessClaimCount() -> Int { accessClaims }

    /// Claims the security-scoped resource for the lifetime of the bridge.
    ///
    /// Separate from `init` because it can fail and because the claim is
    /// reference-counted: DEVELOPMENT.md 13.5 has iOS re-verify the binding and
    /// the file-bridge lease on foreground resume, which means claiming again
    /// after a release rather than assuming the first claim survived.
    public func beginAccess() throws {
        guard fileSystem.beginAccess() else {
            throw Zft2Error(
                code: "permission_denied",
                message: "The shared directory is no longer available"
            )
        }
        accessClaims += 1
    }

    // MARK: - Resolution

    private struct Resolved {
        let path: String
        let hostPath: String
        let info: FileNodeInfo
    }

    /// Resolves a virtual path to an existing node inside the granted root.
    ///
    /// The containment check is on the *canonical* path, so a symlink anywhere
    /// along the way cannot carry the resolution outside the root. That is the
    /// whole jail on this platform.
    private func resolveExisting(_ path: String) async throws -> Resolved {
        let normalized = try VirtualPath.normalize(path)
        let hostPath = try canonicalHostPath(for: normalized)
        guard let info = try await fileSystem.info(at: hostPath) else {
            throw Zft2Error(code: "not_found", message: "Not found: " + normalized)
        }
        return Resolved(path: normalized, hostPath: hostPath, info: info)
    }

    /// Resolves for writing, creating the file when absent.
    ///
    /// Parent directories are NOT created. `open` is a file operation; a peer that
    /// wants a directory sends MKDIR. Auto-creating the chain would turn a single
    /// typo into a tree of empty directories inside the user's shared folder.
    private func resolveForWrite(_ normalized: String) async throws -> Resolved {
        do {
            return try await resolveExisting(normalized)
        } catch let failure as Zft2Error where failure.code == "not_found" {
            /* Absent, so fall through and create it. Only not_found means that.
             *
             * Deliberately a typed catch rather than `try?`. `try?` discards every
             * error, including the invalid_path raised when a path resolves outside
             * the granted root, and then reports whatever the create attempt
             * happens to fail with -- so a symlink escape would surface as some
             * unrelated code. It is not by itself an escape, because the parent is
             * resolved below through the same containment check and refuses
             * independently (verified by transliterating both versions). Relying on
             * that would mean the jail holds here only as a side effect of a check
             * further down, which is exactly the kind of accidental safety that
             * breaks when the code below is refactored. */
        }

        let name = VirtualPath.basename(normalized)
        try Self.requireAddressableName(name)
        let parent = try await resolveExisting(VirtualPath.parent(normalized))
        guard parent.info.isDirectory else {
            throw Zft2Error(code: "not_a_directory", message: "Parent is not a directory")
        }
        try requireWritableTarget(parent.info)

        /* Built from the parent's canonical path, so the new file lands inside the
         * root even if the virtual parent was reached through a link. */
        let hostPath = parent.hostPath + "/" + name
        try await fileSystem.createFile(at: hostPath)
        guard let info = try await fileSystem.info(at: hostPath) else {
            throw Zft2Error(code: "io_error", message: "Created file is not readable")
        }
        return Resolved(path: normalized, hostPath: hostPath, info: info)
    }

    /// Maps a normalised virtual path onto a canonical host path inside the root.
    ///
    /// Refuses rather than guesses when the platform cannot canonicalise, which is
    /// what DEVELOPMENT.md 13.4 asks for: "cannot be reliably judged" means
    /// rejected, not followed.
    private func canonicalHostPath(for normalized: String) throws -> String {
        let root = fileSystem.rootPath
        let joined = normalized == Self.root ? root : root + normalized

        guard let canonical = try fileSystem.canonicalPath(of: joined) else {
            /* The node does not exist yet. Its parent chain still has to be inside
             * the root, so the deepest existing ancestor is canonicalised and the
             * remaining components appended. Returning the unresolved string would
             * let `/root/link/new` be created under the link's target. */
            return try canonicalHostPathForMissing(normalized)
        }
        guard VirtualPath.isWithin(root: root, candidate: canonical) else {
            /* The path resolved outside the granted root: a symlink escape. Reported
             * as invalid_path rather than not_found, because the file may well
             * exist -- it is simply not ours to serve. */
            throw Zft2Error(code: "invalid_path", message: "Path escapes the shared directory")
        }
        return canonical
    }

    private func canonicalHostPathForMissing(_ normalized: String) throws -> String {
        let root = fileSystem.rootPath
        var components = normalized.split(separator: "/").map(String.init)
        var trailing: [String] = []

        while !components.isEmpty {
            trailing.insert(components.removeLast(), at: 0)
            let ancestorVirtual = components.isEmpty ? Self.root : "/" + components.joined(separator: "/")
            let ancestorJoined = ancestorVirtual == Self.root ? root : root + ancestorVirtual
            guard let ancestor = try fileSystem.canonicalPath(of: ancestorJoined) else { continue }
            guard VirtualPath.isWithin(root: root, candidate: ancestor) else {
                throw Zft2Error(code: "invalid_path", message: "Path escapes the shared directory")
            }
            return ancestor + "/" + trailing.joined(separator: "/")
        }
        /* Not even the root canonicalises. The grant is gone rather than the path
         * being wrong, so this is not an invalid_path. */
        throw Zft2Error(code: "not_found", message: "The shared directory is no longer available")
    }

    // MARK: - Helpers

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

    private func requireWritableTarget(_ info: FileNodeInfo) throws {
        guard info.canWrite else {
            throw Zft2Error(code: "permission_denied", message: "Not writable: " + info.name)
        }
    }

    /// Reports the read-write answer the *share* gives, not just the file.
    ///
    /// A read-only share must advertise `canWrite=false` on every entry even when
    /// the underlying file is writable, because the main end reads this field to
    /// decide whether to offer a write at all. Advertising true and refusing later
    /// is the corrupted-half-copy failure DEVELOPMENT.md 13.4 calls out.
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

    /// Refuses a name the virtual-path layer could not address.
    ///
    /// A name containing a separator would resolve to a different path than the
    /// one requested, which is how a create lands outside the directory the peer
    /// named.
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

    /// Nil when `name` cannot be addressed as a virtual path component.
    private func joinChild(parent: String, name: String) -> String? {
        do {
            try Self.requireAddressableName(name)
            return try VirtualPath.normalize(parent == Self.root ? "/" + name : parent + "/" + name)
        } catch {
            return nil
        }
    }

    /// An unguessable handle.
    ///
    /// DEVELOPMENT.md 13.3 requires it. A sequential handle lets a peer name a file
    /// it never opened -- including one another operation opened for writing -- so
    /// the value carries 128 bits from the system CSPRNG rather than a counter.
    ///
    /// `SystemRandomNumberGenerator` is the cryptographically secure source in the
    /// Swift standard library, which keeps this file free of a CryptoKit import for
    /// something the stdlib already guarantees.
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

    static let root = "/"
    private static let handleBytes = 16
}

extension String {
    /// Left-pads to a fixed width, so a hex chunk keeps its full byte count.
    ///
    /// Without it a value below 0x1000... renders short and the handle loses
    /// entropy from its printed form -- which is what a peer sees and what a test
    /// measures.
    func leftPadded(to width: Int, with pad: Character) -> String {
        if count >= width { return self }
        return String(repeating: pad, count: width - count) + self
    }
}
