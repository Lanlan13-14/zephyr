package one.zephyr.mobile.feature.filesync

/**
 * An in-memory [SafDocumentTree].
 *
 * Models the parts of SAF that the provider has to cope with, rather than a friendly filesystem:
 * documents are addressed by opaque id, children are found only by asking a parent, and a display
 * name is whatever the provider stored -- including names the virtual-path layer must refuse.
 *
 * It deliberately allows things a real filesystem would not, because SAF allows them too: two
 * children with the same display name, and a directory that reports it cannot accept children. Those
 * are the cases where a provider that trusts its own path arithmetic goes wrong.
 */
class FakeDocumentTree(
    override val rootId: String = "root",
) : SafDocumentTree {

    class Node(
        val id: String,
        var name: String,
        val isDirectory: Boolean,
        var canRead: Boolean = true,
        var canWrite: Boolean = true,
        var bytes: ByteArray = ByteArray(0),
        var lastModified: Long = 1_700_000_000_000L,
    )

    val nodes = LinkedHashMap<String, Node>()
    private val childIds = LinkedHashMap<String, MutableList<String>>()
    private val parentOf = HashMap<String, String>()

    /** Set to refuse cross-directory moves, which many document providers genuinely do. */
    var supportsMove: Boolean = true

    /** Every openAccess call, so a test can prove a descriptor was requested read-only. */
    val opened = mutableListOf<String>()

    /** Descriptors handed out and not yet closed. Proves closeAll and truncate release theirs. */
    val liveAccess = mutableListOf<String>()

    init {
        nodes[rootId] = Node(rootId, "", isDirectory = true)
        childIds[rootId] = mutableListOf()
    }

    fun addDirectory(parentId: String, name: String, canWrite: Boolean = true): String =
        insert(parentId, Node(nextId(), name, isDirectory = true, canWrite = canWrite))

    fun addFile(
        parentId: String,
        name: String,
        content: String = "",
        canRead: Boolean = true,
        canWrite: Boolean = true,
    ): String = insert(
        parentId,
        Node(
            nextId(),
            name,
            isDirectory = false,
            canRead = canRead,
            canWrite = canWrite,
            bytes = content.toByteArray(Charsets.UTF_8),
        ),
    )

    fun contentOf(documentId: String): String = String(nodes.getValue(documentId).bytes, Charsets.UTF_8)

    private var sequence = 0
    private fun nextId(): String = "doc" + (++sequence)

    private fun insert(parentId: String, node: Node): String {
        nodes[node.id] = node
        childIds.getOrPut(node.id) { mutableListOf() }
        childIds.getOrPut(parentId) { mutableListOf() }.add(node.id)
        parentOf[node.id] = parentId
        return node.id
    }

    private fun Node.toDocument(): SafDocument = SafDocument(
        documentId = id,
        name = name,
        isDirectory = isDirectory,
        size = bytes.size.toLong(),
        lastModified = lastModified,
        canRead = canRead,
        canWrite = canWrite,
    )

    override suspend fun document(documentId: String): SafDocument? = nodes[documentId]?.toDocument()

    override suspend fun children(documentId: String): List<SafDocument> =
        (childIds[documentId] ?: emptyList()).mapNotNull { nodes[it]?.toDocument() }

    override suspend fun createFile(parentId: String, name: String): SafDocument =
        nodes.getValue(insert(parentId, Node(nextId(), name, isDirectory = false))).toDocument()

    override suspend fun createDirectory(parentId: String, name: String): SafDocument =
        nodes.getValue(insert(parentId, Node(nextId(), name, isDirectory = true))).toDocument()

    override suspend fun delete(documentId: String): Boolean {
        val parent = parentOf[documentId] ?: return false
        // Recursive, like DocumentsContract.deleteDocument.
        val stack = ArrayDeque(listOf(documentId))
        while (stack.isNotEmpty()) {
            val id = stack.removeLast()
            childIds[id]?.let { stack.addAll(it) }
            nodes.remove(id)
            childIds.remove(id)
            parentOf.remove(id)
        }
        childIds[parent]?.remove(documentId)
        return true
    }

    override suspend fun rename(documentId: String, newName: String): SafDocument? {
        val node = nodes[documentId] ?: return null
        node.name = newName
        return node.toDocument()
    }

    override suspend fun move(
        documentId: String,
        fromParentId: String,
        toParentId: String,
    ): SafDocument? {
        if (!supportsMove) return null
        val node = nodes[documentId] ?: return null
        childIds[fromParentId]?.remove(documentId)
        childIds.getOrPut(toParentId) { mutableListOf() }.add(documentId)
        parentOf[documentId] = toParentId
        return node.toDocument()
    }

    override suspend fun openAccess(documentId: String, write: Boolean): SafRandomAccess {
        opened += documentId + ":" + (if (write) "rw" else "r")
        val node = nodes.getValue(documentId)
        liveAccess += documentId
        return object : SafRandomAccess {
            override suspend fun readAt(offset: Long, length: Int): ByteArray {
                if (offset >= node.bytes.size) return ByteArray(0)
                val end = minOf(node.bytes.size.toLong(), offset + length).toInt()
                return node.bytes.copyOfRange(offset.toInt(), end)
            }

            override suspend fun writeAt(offset: Long, data: ByteArray): Int {
                val end = (offset + data.size).toInt()
                if (end > node.bytes.size) node.bytes = node.bytes.copyOf(end)
                data.copyInto(node.bytes, offset.toInt())
                return data.size
            }

            override suspend fun truncate(size: Long) {
                node.bytes = node.bytes.copyOf(size.toInt())
            }

            override suspend fun close() {
                liveAccess.remove(documentId)
            }
        }
    }
}

/** In-memory [UriPermissionStore]. Refuses whatever a test tells it to refuse. */
class FakeUriPermissions : UriPermissionStore {

    private val grants = LinkedHashMap<String, UriGrant>()

    /** URIs the system will refuse to persist, e.g. one not produced by a picker. */
    val refuse = mutableSetOf<String>()

    /** Grant read but not write, which is what a read-only volume produces. */
    val readOnlyUris = mutableSetOf<String>()

    val released = mutableListOf<String>()

    override fun persisted(): List<UriGrant> = grants.values.toList()

    override fun takePersistable(uri: String, allowWrite: Boolean): Boolean {
        if (uri in refuse) return false
        grants[uri] = UriGrant(
            uri = uri,
            canRead = true,
            canWrite = allowWrite && uri !in readOnlyUris,
        )
        return true
    }

    override fun releasePersistable(uri: String) {
        released += uri
        grants.remove(uri)
    }

    /** Simulates the user revoking the grant in system settings. */
    fun revokeOutsideTheApp(uri: String) {
        grants.remove(uri)
    }
}
