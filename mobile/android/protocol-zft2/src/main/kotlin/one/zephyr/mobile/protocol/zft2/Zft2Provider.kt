package one.zephyr.mobile.protocol.zft2

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import one.zephyr.mobile.contracts.Zft2Contract
import one.zephyr.mobile.contracts.Zft2Op

/**
 * One filesystem entry as the peer sees it.
 *
 * [canRead]/[canWrite] are real platform answers, not constants. The Dart agent hardcodes both to
 * true (`zephyr_agent/lib/fs/file_provider.dart`); DEVELOPMENT.md 13.4 explicitly forbids that
 * ("不能固定返回 canWrite=true"), because a share advertised as writable that then fails every write
 * turns into a corrupted half-copied file on the Windows side rather than a clean refusal. This is a
 * deliberate divergence from the Dart implementation, and it is safe because the main end only reads
 * these fields to render a file list and to decide whether to offer a write.
 */
data class Zft2FileStat(
    val name: String,
    val path: String,
    val isDir: Boolean,
    val size: Long,
    val mtime: Long,
    val canRead: Boolean,
    val canWrite: Boolean,
) {
    /** Key order matches the Dart agent so captured traces stay diffable. */
    fun toJson(): JsonObject = buildJsonObject {
        put("name", JsonPrimitive(name))
        put("path", JsonPrimitive(path))
        put("isDir", JsonPrimitive(isDir))
        put("size", JsonPrimitive(size))
        put("mtime", JsonPrimitive(mtime))
        put("canRead", JsonPrimitive(canRead))
        put("canWrite", JsonPrimitive(canWrite))
    }
}

/**
 * The platform half of the ZFT2 provider.
 *
 * Android implements this over SAF `DocumentFile`/`ContentResolver` and iOS over a
 * security-scoped URL, per DEVELOPMENT.md 13.4. Everything above this interface is pure logic so the
 * dispatch rules, the read-only jail and the path validation are unit-testable without a device.
 *
 * Implementations must throw [Zft2Exception] with a wire code. `internal_error` is the fallback the
 * dispatcher applies to anything else, so an unexpected platform exception never leaks a host path
 * or a stack trace to the peer.
 */
interface Zft2FileProvider {

    /** Directory listing. Must reject a path that escapes the authorised root. */
    suspend fun list(path: String): List<Zft2FileStat>

    suspend fun stat(path: String): Zft2FileStat

    /**
     * Opens [path] and returns an opaque handle.
     *
     * The handle must be unpredictable and bound to the canonical path plus the access mode
     * (DEVELOPMENT.md 13.4): a guessable sequential handle would let a peer read a file it never
     * opened, and a handle not bound to its mode would let a read-mode handle be written through.
     */
    suspend fun open(path: String, mode: String): String

    suspend fun read(handle: String, offset: Long, length: Int): ByteArray

    suspend fun write(handle: String, offset: Long, data: ByteArray): Int

    suspend fun close(handle: String)

    suspend fun mkdir(path: String)

    suspend fun delete(path: String, recursive: Boolean)

    suspend fun rename(oldPath: String, newPath: String)

    suspend fun truncate(path: String, size: Long)

    /** Releases every open handle. Called on disconnect so a dropped socket cannot leak fds. */
    suspend fun closeAll()
}

/**
 * Negotiated limits for one provider session.
 *
 * @param readOnly the effective value after taking the strictest of profile, connection and server
 *   (DEVELOPMENT.md 13.2). This layer never widens it.
 * @param maxChunkBytes 256 KiB on Android because SAF reads and writes cross a Binder transaction
 *   and a larger payload throws `TransactionTooLargeException`; iOS can negotiate up to 1 MiB.
 * @param maxOpenHandles guards against handle exhaustion from a peer that opens and never closes.
 * @param maxListEntries bounds one `LIST` response so a directory with 100k files cannot exhaust
 *   memory or exceed the 256 KiB metadata ceiling.
 */
data class Zft2ProviderConfig(
    val shareName: String,
    val readOnly: Boolean,
    val maxChunkBytes: Int = ANDROID_CHUNK_BYTES,
    val maxInflight: Int = Zft2Contract.MAX_INFLIGHT_DEFAULT,
    val maxOpenHandles: Int = 64,
    val maxListEntries: Int = 2000,
) {
    companion object {
        /** DEVELOPMENT.md 13.3: unified 256 KiB first release to remove a platform difference. */
        const val ANDROID_CHUNK_BYTES = 256 * 1024
        const val IOS_CHUNK_BYTES = 1024 * 1024
    }
}

/**
 * Turns an inbound request frame into a response frame.
 *
 * Mobile is the *provider* in ZFT2: the main end drives `/agent/files` and this side answers, the
 * same role `zephyr_agent`'s `AgentController` plays. Ported from `agent_controller.dart`
 * `_dispatchZft2`, with the per-op metadata keys and response shapes kept identical because the
 * main end's `file-agent-manager.js` reads them positionally by name.
 */
class Zft2Dispatcher(
    private val provider: Zft2FileProvider,
    private val config: Zft2ProviderConfig,
) {

    /**
     * handle -> canonical path, used only to pick a serialisation queue key. It is a cache of what
     * the provider already knows; the provider remains the authority on which handle is valid.
     */
    private val handlePaths = LinkedHashMap<String, String>()

    val openHandleCount: Int get() = synchronized(handlePaths) { handlePaths.size }

    /**
     * Ops that must not race on the same path get a queue key; read/stat/list/ping return null and
     * stay concurrent (DEVELOPMENT.md 13.3: "同一路径的 open/write/truncate/close/rename/delete
     * 串行，不同路径与 read 可并行").
     */
    fun queueKey(frame: Zft2Frame): String? {
        val meta = frame.meta
        return when (frame.operation) {
            Zft2Op.WRITE, Zft2Op.CLOSE -> {
                val handle = meta.stringOrNull("handle") ?: return null
                synchronized(handlePaths) { handlePaths[handle] } ?: ("handle:" + handle)
            }
            Zft2Op.OPEN, Zft2Op.TRUNCATE, Zft2Op.MKDIR, Zft2Op.DELETE -> queuePath(meta, "path")
            // Queued on the source path: the destination only exists after the move completes.
            Zft2Op.RENAME -> queuePath(meta, "oldPath")
            else -> null
        }
    }

    /**
     * Queue keys use the same normalisation as [dispatch].
     *
     * Keying on the raw string would let "/a/b" and "//a/b" - the same file - take different queues
     * and run concurrently, which is exactly the race the serialisation rule exists to prevent. A
     * path that fails validation falls back to the raw spelling: dispatch is about to reject it, and
     * a rejected frame still has to be ordered behind whatever is already queued for that key.
     */
    private fun queuePath(meta: JsonObject, key: String): String? {
        val raw = meta.stringOrNull(key)?.takeIf { it.isNotEmpty() } ?: return null
        return try {
            VirtualPath.normalize(raw)
        } catch (rejected: Zft2Exception) {
            raw
        }
    }

    /**
     * Executes [frame] and returns the encoded response.
     *
     * @throws Zft2Exception for any refusal. The session converts it into an error frame; throwing
     *   rather than returning an error frame here keeps the read-only and path checks impossible to
     *   forget at a call site.
     */
    suspend fun dispatch(frame: Zft2Frame): ByteArray {
        val op = frame.operation
            ?: throw Zft2Exception("unsupported", "Unsupported ZFT2 operation " + frame.op)

        // The read-only jail lives here, at the provider layer, not in the UI and not only in the
        // hello capability map: DEVELOPMENT.md 13.2 takes the strictest of three layers, and a peer
        // that ignores the advertised capabilities must still be refused.
        if (config.readOnly && op.isWrite) {
            throw Zft2Exception("read_only", "Share is read-only")
        }

        val meta = frame.meta
        var responseMeta: JsonObject = JsonObject(emptyMap())
        var payload = ByteArray(0)

        when (op) {
            Zft2Op.OPEN -> {
                val path = VirtualPath.normalize(meta.stringOrNull("path"))
                val mode = meta.stringOrNull("mode") ?: "read"
                if (mode != "read" && config.readOnly) {
                    throw Zft2Exception("read_only", "Share is read-only")
                }
                // Checked before the platform call so a handle-exhaustion attempt costs nothing.
                synchronized(handlePaths) {
                    if (handlePaths.size >= config.maxOpenHandles) {
                        throw Zft2Exception("too_many_handles", "Too many open handles")
                    }
                }
                val handle = provider.open(path, mode)
                synchronized(handlePaths) { handlePaths[handle] = path }
                responseMeta = buildJsonObject { put("handle", JsonPrimitive(handle)) }
            }

            Zft2Op.READ -> {
                val handle = meta.requireString("handle")
                val offset = meta.longOr("offset", 0L)
                // A short read is legal in RDPDR and the remote re-requests the remainder, so
                // clamping is safe and is the last line of defence for a peer that ignored
                // hello.maxChunkSize.
                val requested = meta.intOr("length", DEFAULT_READ_BYTES)
                val length = requested.coerceIn(0, config.maxChunkBytes)
                payload = provider.read(handle, offset, length)
                responseMeta = buildJsonObject {
                    put("bytesRead", JsonPrimitive(payload.size))
                    put("eof", JsonPrimitive(payload.isEmpty()))
                }
            }

            Zft2Op.WRITE -> {
                if (frame.payload.size > config.maxChunkBytes) {
                    throw Zft2Exception("payload_too_large", "Write chunk exceeds negotiated limit")
                }
                val handle = meta.requireString("handle")
                val offset = meta.longOr("offset", 0L)
                val written = provider.write(handle, offset, frame.payload)
                responseMeta = buildJsonObject { put("bytesWritten", JsonPrimitive(written)) }
            }

            Zft2Op.CLOSE -> {
                val handle = meta.requireString("handle")
                try {
                    provider.close(handle)
                } finally {
                    // Dropped even when close fails: keeping a dead handle in the map would pin a
                    // queue key forever and block every later op on that path.
                    synchronized(handlePaths) { handlePaths.remove(handle) }
                }
            }

            Zft2Op.STAT -> {
                val path = VirtualPath.normalize(meta.stringOrNull("path") ?: "/")
                responseMeta = provider.stat(path).toJson()
            }

            Zft2Op.LIST -> {
                val path = VirtualPath.normalize(meta.stringOrNull("path") ?: "/")
                val entries = provider.list(path)
                if (entries.size > config.maxListEntries) {
                    throw Zft2Exception("too_many_entries", "Directory listing exceeds limit")
                }
                responseMeta = buildJsonObject {
                    put("entries", JsonArray(entries.map { it.toJson() }))
                }
            }

            Zft2Op.MKDIR -> provider.mkdir(VirtualPath.normalize(meta.stringOrNull("path")))

            Zft2Op.DELETE -> provider.delete(
                VirtualPath.normalize(meta.stringOrNull("path")),
                meta.booleanOr("recursive", false),
            )

            Zft2Op.RENAME -> {
                val from = VirtualPath.normalize(meta.stringOrNull("oldPath"))
                val to = VirtualPath.normalize(meta.stringOrNull("newPath"))
                if (from == to) throw Zft2Exception("invalid_path", "Rename source equals destination")
                provider.rename(from, to)
            }

            Zft2Op.TRUNCATE -> {
                val size = meta.longOr("size", 0L)
                if (size < 0L) throw Zft2Exception("invalid_argument", "Negative truncate size")
                provider.truncate(VirtualPath.normalize(meta.stringOrNull("path")), size)
            }

            // Liveness probe. Answered locally so a stalled filesystem cannot make the session look
            // dead to the main end's heartbeat monitor.
            Zft2Op.PING -> responseMeta = buildJsonObject {
                put("agentTime", JsonPrimitive(System.currentTimeMillis()))
            }

            // CANCEL never reaches dispatch: the session intercepts it, because by the time a
            // cancel is dispatched in order behind its target the target has already finished.
            Zft2Op.CANCEL -> throw Zft2Exception("unsupported", "CANCEL is handled by the session")
        }

        return Zft2Codec.encodeResponse(frame, responseMeta, payload.takeIf { it.isNotEmpty() })
    }

    /**
     * The JSON-RPC half of the provider, used by the main end's `callAgent` path.
     *
     * `ai-agent-device-tools.js` still drives `list`/`stat`/`open`/`close` and friends over text
     * frames even against a protocol-v2 agent, so this is a live surface rather than legacy. Base64
     * `read`/`write` stay refused exactly as the Dart agent refuses them: moving file bytes through
     * JSON inflates them by a third and has no cancellation, which is why ZFT2 exists.
     */
    suspend fun dispatchRpc(method: String, params: JsonObject): JsonObject {
        if (config.readOnly && method in MUTATING_RPC_METHODS) {
            throw Zft2Exception("read_only", "Share is read-only")
        }
        return when (method) {
            "list" -> {
                val path = VirtualPath.normalize(params.stringOrNull("path") ?: "/")
                val entries = provider.list(path)
                if (entries.size > config.maxListEntries) {
                    throw Zft2Exception("too_many_entries", "Directory listing exceeds limit")
                }
                buildJsonObject { put("entries", JsonArray(entries.map { it.toJson() })) }
            }
            "stat" -> provider.stat(VirtualPath.normalize(params.stringOrNull("path") ?: "/")).toJson()
            "open" -> {
                val path = VirtualPath.normalize(params.stringOrNull("path"))
                val mode = params.stringOrNull("mode") ?: "read"
                if (mode != "read" && config.readOnly) throw Zft2Exception("read_only", "Share is read-only")
                synchronized(handlePaths) {
                    if (handlePaths.size >= config.maxOpenHandles) {
                        throw Zft2Exception("too_many_handles", "Too many open handles")
                    }
                }
                val handle = provider.open(path, mode)
                synchronized(handlePaths) { handlePaths[handle] = path }
                buildJsonObject { put("handle", JsonPrimitive(handle)) }
            }
            "close" -> {
                val handle = params.requireString("handle")
                try {
                    provider.close(handle)
                } finally {
                    synchronized(handlePaths) { handlePaths.remove(handle) }
                }
                JsonObject(emptyMap())
            }
            "mkdir" -> {
                provider.mkdir(VirtualPath.normalize(params.stringOrNull("path")))
                JsonObject(emptyMap())
            }
            "delete" -> {
                provider.delete(
                    VirtualPath.normalize(params.stringOrNull("path")),
                    params.booleanOr("recursive", false),
                )
                JsonObject(emptyMap())
            }
            "rename" -> {
                val from = VirtualPath.normalize(params.stringOrNull("oldPath"))
                val to = VirtualPath.normalize(params.stringOrNull("newPath"))
                if (from == to) throw Zft2Exception("invalid_path", "Rename source equals destination")
                provider.rename(from, to)
                JsonObject(emptyMap())
            }
            "truncate" -> {
                val size = params.longOr("size", 0L)
                if (size < 0L) throw Zft2Exception("invalid_argument", "Negative truncate size")
                provider.truncate(VirtualPath.normalize(params.stringOrNull("path")), size)
                JsonObject(emptyMap())
            }
            "read", "write" -> throw Zft2Exception("unsupported", "Base64 transfers are disabled in protocol v2")
            else -> throw Zft2Exception("unsupported", "Unsupported method: " + method)
        }
    }

    /**
     * Backs the `readBinary` RPC, whose reply is a `ZFB1` binary frame rather than JSON.
     *
     * Clamping happens here as well as in the session so the chunk ceiling cannot be bypassed by
     * reaching the provider through a different entry point.
     */
    suspend fun readForRpc(handle: String, offset: Long, length: Int): ByteArray =
        provider.read(handle, offset, length.coerceIn(0, config.maxChunkBytes))

    /** Forgets every handle after the provider released them. */
    suspend fun releaseAll() {
        provider.closeAll()
        synchronized(handlePaths) { handlePaths.clear() }
    }

    private companion object {
        /** Matches the Dart agent's default when the peer omits `length`. */
        const val DEFAULT_READ_BYTES = 256 * 1024

        /** JSON-RPC method names that mutate; `write` is the base64 one, already refused. */
        val MUTATING_RPC_METHODS = setOf("write", "mkdir", "delete", "rename", "truncate")
    }
}
