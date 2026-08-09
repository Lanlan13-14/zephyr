package one.zephyr.mobile.feature.filesync

/**
 * One document as the platform reports it.
 *
 * [canRead] and [canWrite] are the provider's real answers, never constants. DEVELOPMENT.md 13.4
 * forbids a fixed `canWrite=true` -- and the Dart agent does exactly that in
 * `zephyr_agent/lib/fs/file_provider.dart`), because a share advertised as writable that then fails
 * every write leaves a half-copied file on the Windows side instead of a clean refusal.
 *
 * [documentId] is opaque and provider-specific. It never crosses the wire: the peer addresses files
 * by virtual path only, and ids are resolved by walking the tree from its root. That is what makes
 * the jail structural rather than a string comparison.
 */
data class SafDocument(
    val documentId: String,
    val name: String,
    val isDirectory: Boolean,
    val size: Long,
    val lastModified: Long,
    val canRead: Boolean,
    val canWrite: Boolean,
)

/**
 * Random access to one open document.
 *
 * Every operation carries its own absolute offset rather than relying on a stream position. Reads
 * and writes on the same handle can be in flight concurrently (DEVELOPMENT.md 13.3 keeps reads
 * parallel), and on Android both directions share a single file descriptor obtained from
 * `ContentResolver.openFileDescriptor`, so an implicit cursor would be raced between them.
 */
interface SafRandomAccess {

    /** Reads at most [length] bytes from [offset]. A short read means end of file. */
    suspend fun readAt(offset: Long, length: Int): ByteArray

    /** Writes [data] at [offset] and returns the number of bytes accepted. */
    suspend fun writeAt(offset: Long, data: ByteArray): Int

    suspend fun truncate(size: Long)

    suspend fun close()
}

/**
 * The narrow platform seam the ZFT2 file provider is written against.
 *
 * Android implements it over SAF `DocumentFile`/`ContentResolver`; the pure provider logic above it
 * -- path resolution, the read-only jail, handle binding, listing limits -- is then unit-testable on
 * the JVM with no device and no emulator. That split matters here more than usual: there is no
 * Gradle wrapper in this repository and the Android tree is compiled only in CI, so logic that can
 * only be exercised on a device is logic nobody exercises.
 *
 * Implementations must not interpret virtual paths. They receive document ids that the provider
 * obtained by walking from [rootId], which is why a hostile path cannot reach a document outside the
 * granted tree even if an implementation is careless.
 */
interface SafDocumentTree {

    /** The granted tree root. Every resolution starts here and can only descend. */
    val rootId: String

    /** Metadata for one document, or null when it no longer exists. */
    suspend fun document(documentId: String): SafDocument?

    /**
     * Direct children of [documentId].
     *
     * Ordering is the platform's. The provider filters names it cannot address safely, so an
     * implementation must report children verbatim rather than sanitising them: a name the provider
     * would refuse must be visible to it, not silently repaired into a different name.
     */
    suspend fun children(documentId: String): List<SafDocument>

    suspend fun createFile(parentId: String, name: String): SafDocument

    suspend fun createDirectory(parentId: String, name: String): SafDocument

    /** Deletes [documentId], recursively when it is a directory. False when the platform refused. */
    suspend fun delete(documentId: String): Boolean

    /** Renames within the same parent. */
    suspend fun rename(documentId: String, newName: String): SafDocument?

    /**
     * Moves [documentId] between parents.
     *
     * Separate from [rename] because SAF models them separately: `renameTo` cannot change the parent,
     * and moving needs `DocumentsContract.moveDocument`, which a provider may not support. Returning
     * null means "this provider cannot", which the caller reports as a refusal rather than silently
     * copying or dropping the file.
     */
    suspend fun move(documentId: String, fromParentId: String, toParentId: String): SafDocument?

    /** Opens [documentId]; [write] selects a read-write descriptor. */
    suspend fun openAccess(documentId: String, write: Boolean): SafRandomAccess
}
