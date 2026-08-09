package one.zephyr.mobile.protocol.zft2

import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import one.zephyr.mobile.contracts.Zft2Op

/**
 * In-memory [Zft2FileProvider].
 *
 * It records every call so a test can prove an operation reached the platform layer - or, for the
 * read-only jail, prove that it did not. The gates let a test hold an operation in flight, which is
 * the only way to exercise the in-flight window and CANCEL deterministically.
 */
class FakeFileProvider(canWriteDefault: Boolean = true) : Zft2FileProvider {

    val calls = mutableListOf<String>()
    val openHandles = LinkedHashMap<String, String>()
    var listResult: List<Zft2FileStat>? = null
    var readBytes: ByteArray = "hello".toByteArray(Charsets.UTF_8)
    var readGate: CompletableDeferred<Unit>? = null
    var writeGate: CompletableDeferred<Unit>? = null
    var closeAllCount = 0
    var canWrite = canWriteDefault
    var failWith: Zft2Exception? = null
    private var handleSeq = 0

    override suspend fun list(path: String): List<Zft2FileStat> {
        calls += "list:" + path
        failWith?.let { throw it }
        return listResult ?: listOf(stat(path + "/a.txt"))
    }

    override suspend fun stat(path: String): Zft2FileStat {
        calls += "stat:" + path
        failWith?.let { throw it }
        return Zft2FileStat(
            name = VirtualPath.basename(path),
            path = path,
            isDir = false,
            size = readBytes.size.toLong(),
            mtime = 1_700_000_000_000L,
            canRead = true,
            canWrite = canWrite,
        )
    }

    override suspend fun open(path: String, mode: String): String {
        calls += "open:" + path + ":" + mode
        failWith?.let { throw it }
        val handle = "h" + (++handleSeq)
        openHandles[handle] = path
        return handle
    }

    override suspend fun read(handle: String, offset: Long, length: Int): ByteArray {
        calls += "read:" + handle + ":" + offset + ":" + length
        readGate?.await()
        failWith?.let { throw it }
        return readBytes.copyOf(minOf(length, readBytes.size))
    }

    override suspend fun write(handle: String, offset: Long, data: ByteArray): Int {
        calls += "write:" + handle + ":" + offset + ":" + data.size
        writeGate?.await()
        failWith?.let { throw it }
        return data.size
    }

    override suspend fun close(handle: String) {
        calls += "close:" + handle
        openHandles.remove(handle)
    }

    override suspend fun mkdir(path: String) {
        calls += "mkdir:" + path
        failWith?.let { throw it }
    }

    override suspend fun delete(path: String, recursive: Boolean) {
        calls += "delete:" + path + ":" + recursive
        failWith?.let { throw it }
    }

    override suspend fun rename(oldPath: String, newPath: String) {
        calls += "rename:" + oldPath + ":" + newPath
        failWith?.let { throw it }
    }

    override suspend fun truncate(path: String, size: Long) {
        calls += "truncate:" + path + ":" + size
        failWith?.let { throw it }
    }

    override suspend fun closeAll() {
        closeAllCount++
        openHandles.clear()
    }

    fun didWrite(): Boolean = calls.any { it.startsWith("write:") }
}

/** Captures what the session put on the socket. */
class FakeWire : Zft2Wire {

    val binary = mutableListOf<ByteArray>()
    val text = mutableListOf<String>()
    var closed: Pair<Int, String>? = null

    override suspend fun sendBinary(bytes: ByteArray) {
        binary += bytes
    }

    override suspend fun sendText(text: String) {
        this.text += text
    }

    override fun close(code: Int, reason: String) {
        closed = code to reason
    }

    fun lastFrame(): Zft2Frame = Zft2Codec.decode(binary.last())

    fun frames(): List<Zft2Frame> = binary.filter { it.size >= 4 && it[0] == 0x5A.toByte() && it[1] == 0x46.toByte() && it[2] == 0x54.toByte() && it[3] == 0x32.toByte() }
        .map { Zft2Codec.decode(it) }

    fun lastJson(): JsonObject = Json.parseToJsonElement(text.last()).jsonObject

    fun jsonMessages(): List<JsonObject> = text.map { Json.parseToJsonElement(it).jsonObject }
}

/** Builds a decoded request frame the way the peer would send it. */
internal fun requestFrame(
    op: Zft2Op,
    requestId: Long,
    meta: JsonObject = JsonObject(emptyMap()),
    payload: ByteArray? = null,
): Zft2Frame = Zft2Codec.decode(Zft2Codec.encode(op = op.code, requestId = requestId, meta = meta, payload = payload))

internal fun metaOf(vararg pairs: Pair<String, Any?>): JsonObject = buildJsonObject {
    for ((key, value) in pairs) {
        when (value) {
            null -> put(key, JsonNull)
            is String -> put(key, JsonPrimitive(value))
            is Int -> put(key, JsonPrimitive(value))
            is Long -> put(key, JsonPrimitive(value))
            is Boolean -> put(key, JsonPrimitive(value))
            else -> put(key, JsonPrimitive(value.toString()))
        }
    }
}

internal fun helloAck(ok: Boolean, agentId: String = "agent_abc", heartbeatMs: Long = 15_000L, code: String = "unauthorized"): String =
    Json.encodeToString(
        JsonObject.serializer(),
        buildJsonObject {
            put("type", JsonPrimitive("hello_ack"))
            put("ok", JsonPrimitive(ok))
            if (ok) {
                put("agentId", JsonPrimitive(agentId))
                put("serverTime", JsonPrimitive(1_700_000_000_000L))
                put("heartbeatIntervalMs", JsonPrimitive(heartbeatMs))
            } else {
                put(
                    "error",
                    buildJsonObject {
                        put("code", JsonPrimitive(code))
                        put("message", JsonPrimitive("Invalid token"))
                    },
                )
            }
        },
    )

internal fun rpcRequest(id: String, method: String, params: JsonObject = JsonObject(emptyMap())): String =
    Json.encodeToString(
        JsonObject.serializer(),
        buildJsonObject {
            put("id", JsonPrimitive(id))
            put("type", JsonPrimitive("request"))
            put("method", JsonPrimitive(method))
            put("params", params)
        },
    )
