package one.zephyr.mobile.feature.filesync

import android.content.ContentResolver
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.system.Os
import android.system.OsConstants
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import one.zephyr.mobile.protocol.zft2.Zft2Exception
import java.io.FileDescriptor

/**
 * [SafDocumentTree] over a granted SAF tree.
 *
 * Everything here is the platform call and nothing else: resolution, the jail, handle binding and
 * the read-only refusals all live in [SafZft2FileProvider], which is why they can be unit-tested on
 * the JVM. This file is the part that genuinely needs a device.
 *
 * `DocumentsContract` is used directly rather than `DocumentFile`. `DocumentFile.listFiles()` issues
 * one query per child to read each display name, so a directory of 2000 files costs 2000 queries;
 * projecting the columns in a single cursor is one. That difference is the whole cost of a LIST, and
 * LIST is what a Windows Explorer window issues on every navigation.
 *
 * Every call hops to [io] because all of them cross a Binder transaction into the document provider.
 * The ZFT2 session runs them from its dispatch coroutines, and blocking those would stall the
 * heartbeat the main end uses to decide the share is alive.
 */
class ContentResolverDocumentTree(
    private val resolver: ContentResolver,
    /** The tree URI the user granted, as returned by ACTION_OPEN_DOCUMENT_TREE. */
    private val treeUri: Uri,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : SafDocumentTree {

    override val rootId: String =
        DocumentsContract.getTreeDocumentId(treeUri)
            ?: throw Zft2Exception("invalid_argument", "Not a tree URI")

    override suspend fun document(documentId: String): SafDocument? = withContext(io) {
        queryOne(documentId)
    }

    override suspend fun children(documentId: String): List<SafDocument> = withContext(io) {
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, documentId)
        val out = ArrayList<SafDocument>()
        /* A provider that throws mid-enumeration must not fail the whole listing: one unreadable or
         * revoked entry in a large directory would otherwise take the directory with it, which is the
         * behaviour the Dart provider had to fix for protected Windows entries. */
        runCatching {
            resolver.query(childrenUri, PROJECTION, null, null, null)?.use { cursor ->
                while (cursor.moveToNext()) {
                    out += cursor.readDocument() ?: continue
                }
            }
        }
        out
    }

    override suspend fun createFile(parentId: String, name: String): SafDocument = withContext(io) {
        /* MIME type matters: a provider derives the stored extension from it, and
         * `application/octet-stream` is what keeps the name the peer asked for from acquiring a
         * second extension. The peer addresses files by exact name, so a renamed file is a lost
         * file. */
        val created = DocumentsContract.createDocument(
            resolver,
            DocumentsContract.buildDocumentUriUsingTree(treeUri, parentId),
            MIME_BINARY,
            name,
        ) ?: throw Zft2Exception("io_error", "Could not create " + name)
        requireDocument(DocumentsContract.getDocumentId(created))
    }

    override suspend fun createDirectory(parentId: String, name: String): SafDocument = withContext(io) {
        val created = DocumentsContract.createDocument(
            resolver,
            DocumentsContract.buildDocumentUriUsingTree(treeUri, parentId),
            DocumentsContract.Document.MIME_TYPE_DIR,
            name,
        ) ?: throw Zft2Exception("io_error", "Could not create directory " + name)
        requireDocument(DocumentsContract.getDocumentId(created))
    }

    override suspend fun delete(documentId: String): Boolean = withContext(io) {
        runCatching {
            DocumentsContract.deleteDocument(
                resolver,
                DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId),
            )
        }.getOrDefault(false)
    }

    override suspend fun rename(documentId: String, newName: String): SafDocument? = withContext(io) {
        val renamed = runCatching {
            DocumentsContract.renameDocument(
                resolver,
                DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId),
                newName,
            )
        }.getOrNull() ?: return@withContext null
        /* The returned id may differ from the original: a provider is allowed to mint a new one, and
         * some do. Re-reading it is what keeps an open handle's id from going stale silently. */
        queryOne(DocumentsContract.getDocumentId(renamed))
    }

    override suspend fun move(
        documentId: String,
        fromParentId: String,
        toParentId: String,
    ): SafDocument? = withContext(io) {
        /* Not every provider implements moveDocument, and the ones that do not throw rather than
         * return null. Null here means "cannot", which the provider reports as `unsupported` instead
         * of emulating with copy-then-delete. */
        val moved = runCatching {
            DocumentsContract.moveDocument(
                resolver,
                DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId),
                DocumentsContract.buildDocumentUriUsingTree(treeUri, fromParentId),
                DocumentsContract.buildDocumentUriUsingTree(treeUri, toParentId),
            )
        }.getOrNull() ?: return@withContext null
        queryOne(DocumentsContract.getDocumentId(moved))
    }

    override suspend fun openAccess(documentId: String, write: Boolean): SafRandomAccess =
        withContext(io) {
            val uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId)
            /* "rw", never "rwt". "rwt" truncates on open, and a WRITE at a non-zero offset -- which
             * is how RDPDR delivers a large file -- would then discard everything already written.
             * Truncation is an explicit operation here. */
            val mode = if (write) "rw" else "r"
            val descriptor = runCatching { resolver.openFileDescriptor(uri, mode) }.getOrNull()
                ?: throw Zft2Exception("permission_denied", "Could not open the document")
            ParcelFileDescriptorAccess(descriptor)
        }

    private fun requireDocument(documentId: String): SafDocument =
        queryOne(documentId) ?: throw Zft2Exception("io_error", "Created document is not readable")

    private fun queryOne(documentId: String): SafDocument? {
        val uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId)
        return runCatching {
            resolver.query(uri, PROJECTION, null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.readDocument() else null
            }
        }.getOrNull()
    }

    /**
     * Reads one row into a [SafDocument].
     *
     * `canWrite` is derived from the provider's own flags, not assumed. DEVELOPMENT.md 13.4 requires
     * the real platform answer, and this is where it comes from: a directory is writable when it
     * supports creating children, a file when it supports writing.
     */
    private fun Cursor.readDocument(): SafDocument? {
        val id = getStringOrNull(DocumentsContract.Document.COLUMN_DOCUMENT_ID) ?: return null
        val mime = getStringOrNull(DocumentsContract.Document.COLUMN_MIME_TYPE) ?: ""
        val isDirectory = mime == DocumentsContract.Document.MIME_TYPE_DIR
        val flags = getLongOrNull(DocumentsContract.Document.COLUMN_FLAGS) ?: 0L
        val supportsWrite = flags and DocumentsContract.Document.FLAG_SUPPORTS_WRITE.toLong() != 0L
        val supportsCreate = flags and DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE.toLong() != 0L

        return SafDocument(
            documentId = id,
            /* Falling back to the id would invent a name the peer cannot address. A row with no
             * display name is skipped instead, exactly like an unreadable child. */
            name = getStringOrNull(DocumentsContract.Document.COLUMN_DISPLAY_NAME) ?: return null,
            isDirectory = isDirectory,
            size = getLongOrNull(DocumentsContract.Document.COLUMN_SIZE) ?: 0L,
            lastModified = getLongOrNull(DocumentsContract.Document.COLUMN_LAST_MODIFIED) ?: 0L,
            canRead = true,
            canWrite = if (isDirectory) supportsCreate else supportsWrite,
        )
    }

    private fun Cursor.getStringOrNull(column: String): String? {
        val index = getColumnIndex(column)
        return if (index < 0 || isNull(index)) null else getString(index)
    }

    private fun Cursor.getLongOrNull(column: String): Long? {
        val index = getColumnIndex(column)
        return if (index < 0 || isNull(index)) null else getLong(index)
    }

    companion object {
        private const val MIME_BINARY = "application/octet-stream"

        /**
         * Exactly the columns a [SafDocument] needs.
         *
         * Projected explicitly so a listing is one cursor rather than one query per child.
         */
        private val PROJECTION = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
            DocumentsContract.Document.COLUMN_FLAGS,
        )
    }
}

/**
 * Positional reads and writes on one descriptor.
 *
 * `Os.pread`/`Os.pwrite` rather than seek-then-read: they take the offset as an argument and do not
 * move the shared file position. Reads on one handle run concurrently (DEVELOPMENT.md 13.3), and two
 * seeking readers on one descriptor would interleave into each other's data -- corruption that looks
 * like a network fault and only appears under parallel readahead.
 */
private class ParcelFileDescriptorAccess(
    private val descriptor: ParcelFileDescriptor,
) : SafRandomAccess {

    private val fd: FileDescriptor = descriptor.fileDescriptor

    override suspend fun readAt(offset: Long, length: Int): ByteArray {
        if (length <= 0) return ByteArray(0)
        val buffer = ByteArray(length)
        var filled = 0
        while (filled < length) {
            /* pread returns a short count at end of file and may return a short count for any other
             * reason too, so the loop continues until EOF rather than trusting one call. A short
             * READ response is legal in ZFT2 and the remote re-requests, but a spuriously short one
             * makes a large transfer take many more round trips. */
            val read = try {
                Os.pread(fd, buffer, filled, length - filled, offset + filled)
            } catch (failure: Throwable) {
                throw failure.toZft2("Read failed")
            }
            if (read <= 0) break
            filled += read
        }
        return if (filled == length) buffer else buffer.copyOf(filled)
    }

    override suspend fun writeAt(offset: Long, data: ByteArray): Int {
        var written = 0
        while (written < data.size) {
            val count = try {
                Os.pwrite(fd, data, written, data.size - written, offset + written)
            } catch (failure: Throwable) {
                throw failure.toZft2("Write failed")
            }
            /* A zero-byte write is not progress. Returning the partial count would tell the peer the
             * bytes landed, and the file would be silently short. */
            if (count <= 0) throw Zft2Exception("io_error", "Write made no progress")
            written += count
        }
        return written
    }

    override suspend fun truncate(size: Long) {
        try {
            Os.ftruncate(fd, size)
        } catch (failure: Throwable) {
            throw failure.toZft2("Truncate failed")
        }
    }

    override suspend fun close() {
        runCatching { descriptor.close() }
    }

    /**
     * Maps a platform failure onto a wire code.
     *
     * The message never carries the platform text. `ErrnoException.getMessage()` includes the host
     * path, and SHARED_RESOURCE_RESIDENCY.md keeps device paths off the wire; the peer gets a code it
     * can act on instead.
     */
    private fun Throwable.toZft2(what: String): Zft2Exception {
        if (this is Zft2Exception) return this
        val errno = (this as? android.system.ErrnoException)?.errno
        val code = when (errno) {
            OsConstants.EACCES, OsConstants.EPERM, OsConstants.EROFS -> "permission_denied"
            OsConstants.ENOENT -> "not_found"
            OsConstants.ENOSPC, OsConstants.EDQUOT -> "no_space"
            OsConstants.EISDIR -> "is_a_directory"
            else -> "io_error"
        }
        return Zft2Exception(code, what)
    }
}
