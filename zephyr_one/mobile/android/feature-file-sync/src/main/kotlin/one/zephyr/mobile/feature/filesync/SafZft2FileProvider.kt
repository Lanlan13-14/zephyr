package one.zephyr.mobile.feature.filesync

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import one.zephyr.mobile.protocol.zft2.VirtualPath
import one.zephyr.mobile.protocol.zft2.Zft2Exception
import one.zephyr.mobile.protocol.zft2.Zft2FileProvider
import one.zephyr.mobile.protocol.zft2.Zft2FileStat
import java.security.SecureRandom

/**
 * The Android half of the ZFT2 provider, over a SAF document tree.
 *
 * [Zft2FileProvider] had no implementation anywhere in the tree. The dispatcher, the session, the
 * path jail and the foreground service were all present and unit-tested, but nothing could serve a
 * byte: `FileBridgeForegroundService` showed a notification for a share that could not answer a
 * single LIST. DEVELOPMENT.md 2.2 records this as M3's open blocker: the SAF authorisation
 * chain and the iOS security-scoped provider are both unimplemented. It is why F-026 is `missing`.
 *
 * Written against [SafDocumentTree] rather than `DocumentFile` directly. The whole point is that
 * this file -- resolution, the jail, handle binding, the read-only refusals -- is testable on the
 * JVM. There is no Gradle wrapper here and the Android tree compiles only in CI, so anything that
 * needs a device to exercise is in practice unexercised.
 *
 * ## Why resolution walks instead of concatenating
 *
 * SAF has no path lookup. A tree URI plus a relative path can be built into a child document id by
 * string concatenation, and that is what makes it dangerous: the id then encodes an unverified path,
 * and a provider that accepts a crafted id addresses whatever it names. So every path is resolved by
 * walking child-by-child from the granted root, matching names exactly. A component that does not
 * exist as a real child of the previous document ends the walk. Traversal is not blocked by a check
 * that could be forgotten; it is unreachable, because `..` is not a name any child has.
 *
 * [VirtualPath.normalize] still runs first, and still rejects `..`, NUL, control characters,
 * backslashes, drive letters and UNC prefixes. Both layers are kept: the validator gives a peer a
 * precise `invalid_path` instead of a confusing `not_found`, and the walk is what actually confines.
 */
class SafZft2FileProvider(
    private val tree: SafDocumentTree,
    /**
     * The effective read-only value, already narrowed to the strictest of profile, connection and
     * server by [one.zephyr.mobile.protocol.rdp.RdpDrivePolicy].
     *
     * Enforced again here, per operation. ADR-004 requires it: there is no single trustworthy
     * read-only switch at the protocol layer, and `Zft2Dispatcher` refusing write ops is not enough
     * on its own -- the JSON-RPC surface reaches this provider too, and a future caller could reach
     * it directly.
     */
    private val readOnly: Boolean,
    private val maxOpenHandles: Int = DEFAULT_MAX_OPEN_HANDLES,
    private val maxListEntries: Int = DEFAULT_MAX_LIST_ENTRIES,
    private val random: SecureRandom = SecureRandom(),
) : Zft2FileProvider {

    /**
     * One open document, bound to the path and mode it was opened with.
     *
     * The binding is the security property, not bookkeeping: DEVELOPMENT.md 13.3 requires each handle
     * to carry its canonical path and access mode, so a handle opened for reading cannot be written
     * through even if the peer sends a WRITE naming it.
     */
    private class OpenDocument(
        val path: String,
        val documentId: String,
        val writable: Boolean,
        val access: SafRandomAccess,
    )

    private val handlesLock = Mutex()
    private val handles = LinkedHashMap<String, OpenDocument>()

    /**
     * Serialises the mutating operations on one path.
     *
     * Held across the platform call, not just the map update. Two concurrent creates of the same
     * name would otherwise both find nothing and both create, and SAF happily produces two children
     * with the same display name -- after which the walk resolves the name to whichever comes first
     * and the peer's writes land in a file it cannot see again.
     */
    private val pathLocks = HashMap<String, Mutex>()
    private val pathLocksGuard = Mutex()

    override suspend fun list(path: String): List<Zft2FileStat> {
        val target = resolveExisting(path)
        if (!target.document.isDirectory) {
            throw Zft2Exception("not_a_directory", "Not a directory: " + path)
        }

        val entries = ArrayList<Zft2FileStat>()
        for (child in tree.children(target.document.documentId)) {
            /* A name the virtual-path layer would reject is skipped rather than listed.
             *
             * Offering it would advertise a file the peer then cannot address -- every later op on
             * that name is refused by normalize() -- and a name carrying a separator or a control
             * character is a classic way to spoof a different path in the main end's file browser.
             * Skipping keeps one hostile name from failing the whole listing, which is the behaviour
             * the Dart provider settled on for unreadable entries. */
            val childPath = joinChild(target.path, child.name) ?: continue
            entries += child.toStat(childPath)
            /* Bounded while building, not after. The dispatcher also checks the count, but it can
             * only do so once the whole list is in memory, and a directory with a million children
             * is exactly the case where that allocation is the problem. One extra entry is collected
             * so the dispatcher's own limit still trips rather than silently truncating. */
            if (entries.size > maxListEntries) break
        }
        return entries
    }

    override suspend fun stat(path: String): Zft2FileStat {
        val target = resolveExisting(path)
        return target.document.toStat(target.path)
    }

    override suspend fun open(path: String, mode: String): String {
        val normalized = VirtualPath.normalize(path)
        val wantsWrite = mode != MODE_READ
        if (wantsWrite && readOnly) throw Zft2Exception("read_only", "Share is read-only")
        if (mode != MODE_READ && mode != MODE_WRITE && mode != MODE_WRITE_TRUNCATE) {
            throw Zft2Exception("invalid_argument", "Unsupported open mode " + mode)
        }

        /* Checked before touching the platform: refusing a handle-exhaustion attempt must be cheap,
         * and opening a descriptor we are about to reject would leak it. */
        handlesLock.withLock {
            if (handles.size >= maxOpenHandles) {
                throw Zft2Exception("too_many_handles", "Too many open handles")
            }
        }

        val document = withPathLock(normalized) {
            if (wantsWrite) openOrCreateForWrite(normalized) else resolveExisting(normalized).document
        }

        if (document.isDirectory) throw Zft2Exception("is_a_directory", "Cannot open a directory: " + normalized)
        if (!document.canRead) throw Zft2Exception("permission_denied", "Not readable: " + normalized)
        if (wantsWrite && !document.canWrite) {
            /* The platform's answer overrides the config's optimism. A grant can be revoked, or the
             * document can sit on a read-only volume, and discovering that on the first WRITE means
             * the remote has already started copying. */
            throw Zft2Exception("permission_denied", "Not writable: " + normalized)
        }

        val access = tree.openAccess(document.documentId, write = wantsWrite)
        if (mode == MODE_WRITE_TRUNCATE) access.truncate(0L)

        val handle = newHandle()
        handlesLock.withLock {
            /* Re-checked under the lock. The earlier check is the cheap rejection; this is the one
             * that holds, because concurrent opens both pass a check made before either inserted. */
            if (handles.size >= maxOpenHandles) {
                access.close()
                throw Zft2Exception("too_many_handles", "Too many open handles")
            }
            handles[handle] = OpenDocument(normalized, document.documentId, wantsWrite, access)
        }
        return handle
    }

    override suspend fun read(handle: String, offset: Long, length: Int): ByteArray {
        if (offset < 0L) throw Zft2Exception("invalid_argument", "Negative read offset")
        if (length <= 0) return ByteArray(0)
        val open = requireHandle(handle)
        return open.access.readAt(offset, length)
    }

    override suspend fun write(handle: String, offset: Long, data: ByteArray): Int {
        if (readOnly) throw Zft2Exception("read_only", "Share is read-only")
        if (offset < 0L) throw Zft2Exception("invalid_argument", "Negative write offset")
        val open = requireHandle(handle)
        /* The mode the handle was opened with decides, not the current frame. A peer that opens for
         * reading and then sends WRITE naming that handle is refused here. */
        if (!open.writable) throw Zft2Exception("read_only", "Handle is open for reading")
        return open.access.writeAt(offset, data)
    }

    override suspend fun close(handle: String) {
        val open = handlesLock.withLock { handles.remove(handle) }
        /* Closing an unknown handle succeeds. CLOSE is idempotent on the wire: a peer that retries
         * after a dropped response must not receive an error for work already done. */
        open?.access?.close()
    }

    override suspend fun mkdir(path: String) {
        requireWritable()
        val normalized = VirtualPath.normalize(path)
        if (normalized == ROOT) throw Zft2Exception("already_exists", "Root already exists")
        val name = VirtualPath.basename(normalized)
        requireAddressableName(name)

        withPathLock(normalized) {
            val parent = resolveExisting(VirtualPath.parent(normalized))
            if (!parent.document.isDirectory) {
                throw Zft2Exception("not_a_directory", "Parent is not a directory")
            }
            requireWritableTarget(parent.document)
            if (childNamed(parent.document.documentId, name) != null) {
                throw Zft2Exception("already_exists", "Already exists: " + normalized)
            }
            tree.createDirectory(parent.document.documentId, name)
        }
    }

    override suspend fun delete(path: String, recursive: Boolean) {
        requireWritable()
        val normalized = VirtualPath.normalize(path)
        /* Deleting the granted root would revoke the share from inside a file operation. The peer
         * asked to delete a directory, not to give up the grant. */
        if (normalized == ROOT) throw Zft2Exception("invalid_path", "Cannot delete the share root")

        withPathLock(normalized) {
            val target = resolveExisting(normalized)
            requireWritableTarget(target.document)
            if (target.document.isDirectory && !recursive) {
                /* SAF deletes a directory tree unconditionally, so a non-recursive request over a
                 * non-empty directory has to be refused here or it silently becomes recursive --
                 * data loss the peer did not ask for. */
                if (tree.children(target.document.documentId).isNotEmpty()) {
                    throw Zft2Exception("not_empty", "Directory is not empty: " + normalized)
                }
            }
            if (!tree.delete(target.document.documentId)) {
                throw Zft2Exception("io_error", "Delete failed: " + normalized)
            }
        }
    }

    override suspend fun rename(oldPath: String, newPath: String) {
        requireWritable()
        val from = VirtualPath.normalize(oldPath)
        val to = VirtualPath.normalize(newPath)
        if (from == ROOT || to == ROOT) throw Zft2Exception("invalid_path", "Cannot rename the share root")
        if (from == to) throw Zft2Exception("invalid_path", "Rename source equals destination")
        /* Renaming a directory into itself would detach the subtree: the moved node becomes its own
         * ancestor and everything under it stops resolving from the root. */
        if (VirtualPath.isWithin(from, to)) {
            throw Zft2Exception("invalid_path", "Cannot move a directory into itself")
        }

        val newName = VirtualPath.basename(to)
        requireAddressableName(newName)

        withPathLock(from) {
            val source = resolveExisting(from)
            requireWritableTarget(source.document)
            val targetParent = resolveExisting(VirtualPath.parent(to))
            if (!targetParent.document.isDirectory) {
                throw Zft2Exception("not_a_directory", "Destination parent is not a directory")
            }
            requireWritableTarget(targetParent.document)
            if (childNamed(targetParent.document.documentId, newName) != null) {
                throw Zft2Exception("already_exists", "Destination exists: " + to)
            }

            val sourceParent = resolveExisting(VirtualPath.parent(from))
            val sameParent = sourceParent.document.documentId == targetParent.document.documentId
            if (sameParent) {
                tree.rename(source.document.documentId, newName)
                    ?: throw Zft2Exception("io_error", "Rename failed: " + from)
            } else {
                /* Cross-directory moves need moveDocument, which a document provider may not
                 * implement. Refused as unsupported rather than emulated with copy-then-delete: a
                 * copy that fails halfway leaves two partial files and the peer believes it moved
                 * one. */
                val moved = tree.move(
                    source.document.documentId,
                    sourceParent.document.documentId,
                    targetParent.document.documentId,
                ) ?: throw Zft2Exception("unsupported", "This directory does not support moving files")
                if (moved.name != newName) {
                    tree.rename(moved.documentId, newName)
                        ?: throw Zft2Exception("io_error", "Rename after move failed: " + to)
                }
            }
        }
    }

    override suspend fun truncate(path: String, size: Long) {
        requireWritable()
        if (size < 0L) throw Zft2Exception("invalid_argument", "Negative truncate size")
        val normalized = VirtualPath.normalize(path)

        withPathLock(normalized) {
            val target = resolveExisting(normalized)
            if (target.document.isDirectory) {
                throw Zft2Exception("is_a_directory", "Cannot truncate a directory: " + normalized)
            }
            requireWritableTarget(target.document)
            val access = tree.openAccess(target.document.documentId, write = true)
            try {
                access.truncate(size)
            } finally {
                /* Closed even when truncate throws. This descriptor is not tracked in `handles`, so
                 * nothing else would ever close it. */
                access.close()
            }
        }
    }

    override suspend fun closeAll() {
        val open = handlesLock.withLock {
            val snapshot = handles.values.toList()
            handles.clear()
            snapshot
        }
        for (entry in open) {
            /* One failing close must not strand the rest. This runs on disconnect, when the grant may
             * already be gone and closing is expected to fail. */
            runCatching { entry.access.close() }
        }
    }

    /** Open handle count, for tests and for the file-sync UI's diagnostics. */
    suspend fun openHandleCount(): Int = handlesLock.withLock { handles.size }

    // ---- resolution ---------------------------------------------------------

    private data class Resolved(val path: String, val document: SafDocument)

    /**
     * Walks [path] from the granted root, requiring every component to be a real child.
     *
     * This is the jail. There is no string arithmetic on document ids and no way to name a document
     * outside the tree, because each step asks the platform for the children of the previous step.
     */
    private suspend fun resolveExisting(path: String): Resolved {
        val normalized = VirtualPath.normalize(path)
        val root = tree.document(tree.rootId)
            ?: throw Zft2Exception("not_found", "The shared directory is no longer available")
        if (normalized == ROOT) return Resolved(ROOT, root)

        var current = root
        for (component in normalized.removePrefix("/").split('/')) {
            if (!current.isDirectory) {
                throw Zft2Exception("not_a_directory", "Not a directory: " + component)
            }
            current = childNamed(current.documentId, component)
                ?: throw Zft2Exception("not_found", "Not found: " + normalized)
        }
        return Resolved(normalized, current)
    }

    /**
     * Resolves for writing, creating the file when absent.
     *
     * Parent directories are NOT created. `open` is a file operation; a peer that wants a directory
     * sends MKDIR. Auto-creating the chain would turn a single typo into a tree of empty directories
     * inside the user's shared folder.
     */
    private suspend fun openOrCreateForWrite(path: String): SafDocument {
        val name = VirtualPath.basename(path)
        requireAddressableName(name)
        val parent = resolveExisting(VirtualPath.parent(path))
        if (!parent.document.isDirectory) {
            throw Zft2Exception("not_a_directory", "Parent is not a directory")
        }
        requireWritableTarget(parent.document)
        childNamed(parent.document.documentId, name)?.let { return it }
        return tree.createFile(parent.document.documentId, name)
    }

    /** Exact-name child lookup. Case-sensitive: SAF display names are, and so is the wire path. */
    private suspend fun childNamed(parentId: String, name: String): SafDocument? =
        tree.children(parentId).firstOrNull { it.name == name }

    private suspend fun requireHandle(handle: String): OpenDocument =
        handlesLock.withLock { handles[handle] }
            ?: throw Zft2Exception("not_found", "Invalid handle")

    private fun requireWritable() {
        if (readOnly) throw Zft2Exception("read_only", "Share is read-only")
    }

    private fun requireWritableTarget(document: SafDocument) {
        if (!document.canWrite) {
            throw Zft2Exception("permission_denied", "Not writable: " + document.name)
        }
    }

    /**
     * Refuses a name the virtual-path layer could not address.
     *
     * A name containing a separator would resolve to a different path than the one requested, which
     * is how a create lands outside the directory the peer named.
     */
    private fun requireAddressableName(name: String) {
        if (name.isEmpty()) throw Zft2Exception("invalid_path", "Empty name")
        if (name == "." || name == "..") throw Zft2Exception("invalid_path", "Relative name")
        if (name.contains('/') || name.contains('\\')) {
            throw Zft2Exception("invalid_path", "Name contains a path separator")
        }
        if (name.length > VirtualPath.MAX_SEGMENT_LENGTH) {
            throw Zft2Exception("invalid_path", "Name is too long")
        }
        if (name.any { it.code < 0x20 || it.code == 0x7f }) {
            throw Zft2Exception("invalid_path", "Name contains control characters")
        }
    }

    /** Null when [name] cannot be addressed as a virtual path component. */
    private fun joinChild(parent: String, name: String): String? = try {
        requireAddressableName(name)
        VirtualPath.normalize(if (parent == ROOT) "/" + name else parent + "/" + name)
    } catch (rejected: Zft2Exception) {
        null
    }

    private suspend fun <T> withPathLock(path: String, block: suspend () -> T): T {
        val lock = pathLocksGuard.withLock { pathLocks.getOrPut(path) { Mutex() } }
        return lock.withLock { block() }
    }

    /**
     * An unguessable handle.
     *
     * DEVELOPMENT.md 13.3 requires it. A sequential handle lets a peer name a document it never
     * opened -- including one opened for writing by a different operation -- so the value carries 128
     * bits from [SecureRandom] rather than a counter.
     */
    private fun newHandle(): String {
        val bytes = ByteArray(HANDLE_BYTES)
        random.nextBytes(bytes)
        val text = StringBuilder(HANDLE_BYTES * 2 + 2)
        text.append("h_")
        for (byte in bytes) {
            val value = byte.toInt() and 0xFF
            text.append(HEX[value ushr 4])
            text.append(HEX[value and 0x0F])
        }
        return text.toString()
    }

    /**
     * Reports the read-write answer the *share* gives, not just the document.
     *
     * A read-only share must advertise `canWrite=false` on every entry even when the underlying
     * document is writable, because the main end reads this field to decide whether to offer a write
     * at all. Advertising true and refusing later is the corrupted-half-copy failure DEVELOPMENT.md
     * 13.4 calls out.
     */
    private fun SafDocument.toStat(path: String): Zft2FileStat = Zft2FileStat(
        name = if (path == ROOT) "" else VirtualPath.basename(path),
        path = path,
        isDir = isDirectory,
        size = if (isDirectory) 0L else size,
        mtime = lastModified,
        canRead = canRead,
        canWrite = canWrite && !readOnly,
    )

    companion object {
        const val MODE_READ = "read"
        const val MODE_WRITE = "write"
        const val MODE_WRITE_TRUNCATE = "writeTruncate"

        /** Matches Zft2ProviderConfig's defaults; both bound the same peer-driven resources. */
        const val DEFAULT_MAX_OPEN_HANDLES = 64
        const val DEFAULT_MAX_LIST_ENTRIES = 2000

        private const val ROOT = "/"
        private const val HANDLE_BYTES = 16
        private val HEX = "0123456789abcdef".toCharArray()
    }
}
