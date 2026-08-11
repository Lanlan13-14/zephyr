import Foundation
import XCTest
@testable import ZephyrCore

/// An in-memory ``SecurityScopedFileSystem``.
///
/// Models the parts of a real POSIX filesystem the provider has to survive rather
/// than a friendly abstraction: symlinks that resolve elsewhere, nodes that are
/// unreadable, and names the virtual-path layer must refuse. The symlink support is
/// the point of the whole fake -- it is the hazard the Android seam does not have,
/// and it cannot be exercised without a filesystem that has links.
final class FakeSecurityScopedFileSystem:
    SecurityScopedFileSystem,
    DescriptorRelativeSecurityScopedFileSystem
{

    final class Node {
        var isDirectory: Bool
        /// Absolute host path this node points at, when it is a symlink.
        var linkTarget: String?
        var bytes: Data
        var mtime: Int64
        var canRead: Bool
        var canWrite: Bool

        init(
            isDirectory: Bool,
            linkTarget: String? = nil,
            bytes: Data = Data(),
            mtime: Int64 = 1_700_000_000_000,
            canRead: Bool = true,
            canWrite: Bool = true
        ) {
            self.isDirectory = isDirectory
            self.linkTarget = linkTarget
            self.bytes = bytes
            self.mtime = mtime
            self.canRead = canRead
            self.canWrite = canWrite
        }
    }

    let rootPath: String

    /// Every node, keyed by absolute host path. Paths carry no trailing slash.
    var nodes: [String: Node] = [:]

    /// Absolute paths handed to `openAccess`, so a test can prove a descriptor was
    /// requested read-only.
    var opened: [String] = []

    /// Descriptors handed out and not yet closed. Proves closeAll and truncate
    /// release theirs.
    var liveAccess: [String] = []

    /// Balance of beginAccess/endAccess. Must return to zero when a bridge stops.
    var accessBalance = 0

    /// Set to refuse the security-scoped claim, which is how a stale bookmark
    /// presents.
    var refuseAccess = false

    /// Set to make `move` report a cross-volume failure.
    var refuseMove = false

    /// The bound passed by LIST. Proves the provider pushes the memory ceiling
    /// into the filesystem instead of truncating an already-materialised array.
    var lastDescriptorListLimit: Int?

    /// One-shot suspension point used to interleave closeAll with an open that has
    /// entered the provider but has not returned a descriptor yet.
    var pauseNextDescriptorOpen: (() async -> Void)?

    /// Lengths that reached the random-access layer after provider clamping.
    var readLengths: [Int] = []

    init(rootPath: String = "/granted") {
        self.rootPath = rootPath
        nodes[rootPath] = Node(isDirectory: true)
    }

    // MARK: - Fixture helpers

    func addDirectory(_ path: String, canWrite: Bool = true) {
        nodes[path] = Node(isDirectory: true, canWrite: canWrite)
    }

    func addFile(_ path: String, contents: String = "", canRead: Bool = true, canWrite: Bool = true) {
        nodes[path] = Node(
            isDirectory: false,
            bytes: Data(contents.utf8),
            canRead: canRead,
            canWrite: canWrite
        )
    }

    /// Adds a symlink at `path` pointing at `target`.
    func addSymlink(_ path: String, to target: String) {
        nodes[path] = Node(isDirectory: false, linkTarget: target)
    }

    func contents(of path: String) -> String {
        String(decoding: nodes[path]?.bytes ?? Data(), as: UTF8.self)
    }

    // MARK: - SecurityScopedFileSystem

    /// Resolves every component, following links, like `realpath(3)`.
    ///
    /// Resolving the whole path rather than the last component is what the provider
    /// depends on, so the fake has to do it too: a link in the middle is the case a
    /// prefix test on the unresolved string misses.
    func canonicalPath(of absolutePath: String) throws -> String? {
        var resolved = ""
        for component in absolutePath.split(separator: "/") {
            let next = resolved + "/" + String(component)
            guard let node = nodes[next] else { return nil }
            if let target = node.linkTarget {
                guard let onward = try canonicalPath(of: target) else { return nil }
                resolved = onward
            } else {
                resolved = next
            }
        }
        return resolved.isEmpty ? "/" : resolved
    }

    func info(at absolutePath: String) async throws -> FileNodeInfo? {
        guard let node = nodes[absolutePath] else { return nil }
        let isLink = node.linkTarget != nil
        var isDirectory = node.isDirectory
        if let target = node.linkTarget {
            isDirectory = nodes[target]?.isDirectory ?? false
        }
        return FileNodeInfo(
            name: (absolutePath as NSString).lastPathComponent,
            isDirectory: isDirectory,
            isSymlink: isLink,
            size: Int64(node.bytes.count),
            mtime: node.mtime,
            canRead: node.canRead,
            canWrite: node.canWrite
        )
    }

    func children(at absolutePath: String) async throws -> [FileNodeInfo] {
        let prefix = absolutePath == "/" ? "/" : absolutePath + "/"
        var out: [FileNodeInfo] = []
        for path in nodes.keys.sorted() where path.hasPrefix(prefix) {
            let tail = String(path.dropFirst(prefix.count))
            // Direct children only.
            if tail.isEmpty || tail.contains("/") { continue }
            let childInfo = try await info(at: path)
            if let childInfo { out.append(childInfo) }
        }
        return out
    }

    func createFile(at absolutePath: String) async throws {
        if nodes[absolutePath] != nil {
            throw Zft2Error(code: "already_exists", message: "exists")
        }
        nodes[absolutePath] = Node(isDirectory: false)
    }

    func createDirectory(at absolutePath: String) async throws {
        if nodes[absolutePath] != nil {
            throw Zft2Error(code: "already_exists", message: "exists")
        }
        nodes[absolutePath] = Node(isDirectory: true)
    }

    func delete(at absolutePath: String, recursive: Bool) async throws {
        guard let node = nodes[absolutePath] else {
            throw Zft2Error(code: "not_found", message: "absent")
        }
        if node.isDirectory {
            let prefix = absolutePath + "/"
            let descendants = nodes.keys.filter { $0.hasPrefix(prefix) }
            if !descendants.isEmpty && !recursive {
                throw Zft2Error(code: "not_empty", message: "not empty")
            }
            for path in descendants { nodes.removeValue(forKey: path) }
        }
        nodes.removeValue(forKey: absolutePath)
    }

    func move(from absolutePath: String, to destinationPath: String) async throws {
        if refuseMove {
            throw Zft2Error(code: "unsupported", message: "Cannot move between volumes")
        }
        guard let node = nodes.removeValue(forKey: absolutePath) else {
            throw Zft2Error(code: "not_found", message: "absent")
        }
        nodes[destinationPath] = node

        let prefix = absolutePath + "/"
        for path in nodes.keys.filter({ $0.hasPrefix(prefix) }) {
            let moved = destinationPath + "/" + String(path.dropFirst(prefix.count))
            nodes[moved] = nodes.removeValue(forKey: path)
        }
    }

    func openAccess(at absolutePath: String, write: Bool) async throws -> Zft2RandomAccess {
        guard let node = nodes[absolutePath] else {
            throw Zft2Error(code: "not_found", message: "absent")
        }
        opened.append(absolutePath + ":" + (write ? "rw" : "r"))
        liveAccess.append(absolutePath)
        return FakeRandomAccess(node: node, path: absolutePath, owner: self)
    }

    // MARK: - Descriptor-relative seam

    func descriptorInfo(components: [String]) async throws -> FileNodeInfo? {
        let resolved = try securePath(components, finalMayBeMissing: true)
        guard let node = resolved.node else { return nil }
        return nodeInfo(node, path: resolved.path)
    }

    func descriptorChildren(components: [String], limit: Int) async throws -> [FileNodeInfo] {
        lastDescriptorListLimit = limit
        if limit <= 0 { return [] }
        let resolved = try securePath(components, finalMayBeMissing: false)
        guard let directory = resolved.node, directory.isDirectory else {
            throw Zft2Error(code: "not_a_directory", message: "not a directory")
        }

        let prefix = resolved.path == "/" ? "/" : resolved.path + "/"
        var output: [FileNodeInfo] = []
        for path in nodes.keys.sorted() where path.hasPrefix(prefix) {
            let tail = String(path.dropFirst(prefix.count))
            if tail.isEmpty || tail.contains("/") { continue }
            guard let node = nodes[path], node.linkTarget == nil else { continue }
            output.append(nodeInfo(node, path: path))
            if output.count >= limit { break }
        }
        return output
    }

    func descriptorOpen(
        components: [String],
        write: Bool,
        createIfMissing: Bool,
        truncate: Bool
    ) async throws -> DescriptorRelativeOpen {
        if let pause = pauseNextDescriptorOpen {
            pauseNextDescriptorOpen = nil
            await pause()
        }

        var resolved = try securePath(components, finalMayBeMissing: createIfMissing)
        if resolved.node == nil {
            guard createIfMissing else {
                throw Zft2Error(code: "not_found", message: "absent")
            }
            let created = Node(isDirectory: false)
            nodes[resolved.path] = created
            resolved = (path: resolved.path, node: created)
        }
        guard let node = resolved.node else {
            throw Zft2Error(code: "not_found", message: "absent")
        }
        guard !node.isDirectory else {
            throw Zft2Error(code: "is_a_directory", message: "directory")
        }
        guard node.canRead else {
            throw Zft2Error(code: "permission_denied", message: "not readable")
        }
        if write && !node.canWrite {
            throw Zft2Error(code: "permission_denied", message: "not writable")
        }
        if truncate { node.bytes = Data() }

        opened.append(resolved.path + ":" + (write ? "rw" : "r"))
        liveAccess.append(resolved.path)
        return DescriptorRelativeOpen(
            info: nodeInfo(node, path: resolved.path),
            access: FakeRandomAccess(node: node, path: resolved.path, owner: self)
        )
    }

    func descriptorCreateDirectory(components: [String]) async throws {
        let resolved = try securePath(components, finalMayBeMissing: true)
        guard resolved.node == nil else {
            throw Zft2Error(code: "already_exists", message: "exists")
        }
        nodes[resolved.path] = Node(isDirectory: true)
    }

    func descriptorDelete(components: [String], recursive: Bool) async throws {
        let resolved = try securePath(components, finalMayBeMissing: false)
        guard let node = resolved.node else {
            throw Zft2Error(code: "not_found", message: "absent")
        }
        if node.isDirectory {
            let prefix = resolved.path + "/"
            let descendants = nodes.keys.filter { $0.hasPrefix(prefix) }
            if !descendants.isEmpty && !recursive {
                throw Zft2Error(code: "not_empty", message: "not empty")
            }
            if descendants.contains(where: { nodes[$0]?.linkTarget != nil }) {
                throw Zft2Error(code: "invalid_path", message: "symlink")
            }
            for path in descendants { nodes.removeValue(forKey: path) }
        }
        nodes.removeValue(forKey: resolved.path)
    }

    func descriptorMove(from: [String], to: [String]) async throws {
        if refuseMove {
            throw Zft2Error(code: "unsupported", message: "Cannot move between volumes")
        }
        let source = try securePath(from, finalMayBeMissing: false)
        guard let node = source.node else {
            throw Zft2Error(code: "not_found", message: "absent")
        }
        let destination = try securePath(to, finalMayBeMissing: true)
        guard destination.node == nil else {
            throw Zft2Error(code: "already_exists", message: "exists")
        }
        nodes.removeValue(forKey: source.path)
        nodes[destination.path] = node

        let prefix = source.path + "/"
        for path in nodes.keys.filter({ $0.hasPrefix(prefix) }) {
            let moved = destination.path + "/" + String(path.dropFirst(prefix.count))
            nodes[moved] = nodes.removeValue(forKey: path)
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

    func beginAccess() -> Bool {
        if refuseAccess { return false }
        accessBalance += 1
        return true
    }

    func endAccess() {
        accessBalance -= 1
    }

    func releaseAccess(_ path: String) {
        if let index = liveAccess.firstIndex(of: path) {
            liveAccess.remove(at: index)
        }
    }

    func recordRead(length: Int) {
        readLengths.append(length)
    }

    private func securePath(
        _ components: [String],
        finalMayBeMissing: Bool
    ) throws -> (path: String, node: Node?) {
        guard let root = nodes[rootPath], root.linkTarget == nil, root.isDirectory else {
            throw Zft2Error(code: "not_found", message: "root absent")
        }
        if components.isEmpty { return (rootPath, root) }

        var current = rootPath
        for (index, component) in components.enumerated() {
            try SecurityScopedFileProvider.requireAddressableName(component)
            let next = current + "/" + component
            guard let node = nodes[next] else {
                if finalMayBeMissing && index == components.count - 1 {
                    return (next, nil)
                }
                throw Zft2Error(code: "not_found", message: "absent")
            }
            if node.linkTarget != nil {
                throw Zft2Error(code: "invalid_path", message: "symlink")
            }
            if index < components.count - 1 && !node.isDirectory {
                throw Zft2Error(code: "not_a_directory", message: "not a directory")
            }
            current = next
        }
        return (current, nodes[current])
    }

    private func nodeInfo(_ node: Node, path: String) -> FileNodeInfo {
        FileNodeInfo(
            name: (path as NSString).lastPathComponent,
            isDirectory: node.isDirectory,
            isSymlink: false,
            size: Int64(node.bytes.count),
            mtime: node.mtime,
            canRead: node.canRead,
            canWrite: node.canWrite
        )
    }
}

/// Positional access over one fake node.
final class FakeRandomAccess: Zft2RandomAccess, @unchecked Sendable {

    private let node: FakeSecurityScopedFileSystem.Node
    private let path: String
    private weak var owner: FakeSecurityScopedFileSystem?

    init(node: FakeSecurityScopedFileSystem.Node, path: String, owner: FakeSecurityScopedFileSystem) {
        self.node = node
        self.path = path
        self.owner = owner
    }

    func readAt(offset: Int64, length: Int) async throws -> Data {
        owner?.recordRead(length: length)
        if offset >= Int64(node.bytes.count) { return Data() }
        let start = Int(offset)
        let end = min(node.bytes.count, start + length)
        return node.bytes.subdata(in: start..<end)
    }

    func writeAt(offset: Int64, data: Data) async throws -> Int {
        let end = Int(offset) + data.count
        if end > node.bytes.count {
            node.bytes.append(Data(repeating: 0, count: end - node.bytes.count))
        }
        node.bytes.replaceSubrange(Int(offset)..<end, with: data)
        return data.count
    }

    func truncate(size: Int64) async throws {
        let target = Int(size)
        if target < node.bytes.count {
            node.bytes = node.bytes.subdata(in: 0..<target)
        } else if target > node.bytes.count {
            node.bytes.append(Data(repeating: 0, count: target - node.bytes.count))
        }
    }

    func close() async {
        owner?.releaseAccess(path)
    }
}

/// In-memory ``BookmarkStore``.
final class FakeBookmarkStore: BookmarkStore {

    private var bookmarks: [String: ResolvedBookmark] = [:]

    /// Bookmarks the OS will refuse to mint, e.g. for a URL not from a picker.
    var refuse: Set<String> = []

    /// Bookmarks granted read but not write, which a read-only volume produces.
    var readOnly: Set<String> = []

    /// Bookmarks the OS reports as stale on resolution.
    var stale: Set<String> = []

    var discarded: [String] = []

    func stored() -> [ResolvedBookmark] {
        bookmarks.keys.sorted().compactMap { bookmarks[$0] }
    }

    func persist(bookmarkId: String, allowWrite: Bool) -> ResolvedBookmark? {
        if refuse.contains(bookmarkId) { return nil }
        let resolved = ResolvedBookmark(
            bookmarkId: bookmarkId,
            canRead: true,
            canWrite: allowWrite && !readOnly.contains(bookmarkId),
            isStale: stale.contains(bookmarkId)
        )
        bookmarks[bookmarkId] = resolved
        return resolved
    }

    func discard(bookmarkId: String) {
        discarded.append(bookmarkId)
        bookmarks.removeValue(forKey: bookmarkId)
    }

    /// Simulates the directory moving away under a live bookmark.
    func goStale(_ bookmarkId: String) {
        guard let existing = bookmarks[bookmarkId] else { return }
        bookmarks[bookmarkId] = ResolvedBookmark(
            bookmarkId: existing.bookmarkId,
            canRead: existing.canRead,
            canWrite: existing.canWrite,
            isStale: true
        )
    }

    /// Simulates the bookmark ceasing to resolve at all.
    func vanish(_ bookmarkId: String) {
        bookmarks.removeValue(forKey: bookmarkId)
    }

    /// Simulates the user re-creating a stale bookmark.
    ///
    /// The inverse of `goStale`, and it is what proves validity is re-derived rather
    /// than remembered: a persisted `grantValid = false` would survive this and leave
    /// the share broken after the user had already fixed it.
    func refresh(_ bookmarkId: String) {
        guard let existing = bookmarks[bookmarkId] else { return }
        bookmarks[bookmarkId] = ResolvedBookmark(
            bookmarkId: existing.bookmarkId,
            canRead: existing.canRead,
            canWrite: existing.canWrite,
            isStale: false
        )
    }
}
