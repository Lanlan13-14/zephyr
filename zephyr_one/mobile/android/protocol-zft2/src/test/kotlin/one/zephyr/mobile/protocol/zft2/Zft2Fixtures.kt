package one.zephyr.mobile.protocol.zft2

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

/**
 * Loads contracts/generated/zft2-frames.json.
 *
 * The same file drives the Node and Swift suites, so a byte that differs between platforms fails a
 * test here instead of corrupting a transfer in the field. Duplicated rather than shared with
 * core-model's Fixtures because a pure-JVM protocol module must not depend on the data layer.
 */
object Zft2Fixtures {

    private val json = Json { ignoreUnknownKeys = true }

    private fun mobileRoot(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            if (File(dir, "contracts/generated/zft2-frames.json").isFile) return dir
            dir = dir.parentFile
        }
        throw IllegalStateException("could not locate mobile/contracts/generated from " + System.getProperty("user.dir"))
    }

    val root: JsonObject by lazy {
        json.parseToJsonElement(File(mobileRoot(), "contracts/generated/zft2-frames.json").readText()).jsonObject
    }

    fun frames(): List<JsonObject> = root["frames"]!!.jsonArray.map { it.jsonObject }

    fun rejects(): List<JsonObject> = root["rejects"]!!.jsonArray.map { it.jsonObject }

    fun ints(key: String): List<Int> = (root[key] as JsonArray).map { it.jsonPrimitive.int }

    /** Table-driven cases such as `inflight` and `chunkNegotiation`. */
    fun cases(key: String): List<JsonObject> = (root[key] as JsonArray).map { it.jsonObject }

    fun hex(bytes: ByteArray): String {
        val builder = StringBuilder(bytes.size * 2)
        for (byte in bytes) {
            val value = byte.toInt() and 0xFF
            builder.append("0123456789abcdef"[value shr 4])
            builder.append("0123456789abcdef"[value and 0x0F])
        }
        return builder.toString()
    }

    fun unhex(text: String): ByteArray {
        val out = ByteArray(text.length / 2)
        for (index in out.indices) {
            out[index] = text.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
        return out
    }

    fun meta(node: JsonObject): JsonObject = node["meta"]?.jsonObject ?: JsonObject(emptyMap())

    fun payload(node: JsonObject): ByteArray? =
        (node["payloadUtf8"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.toByteArray(Charsets.UTF_8)

    fun requestId(node: JsonObject): Long = node["requestId"]!!.jsonPrimitive.long

    fun op(node: JsonObject): Int = node["type"]!!.jsonPrimitive.int

    fun flags(node: JsonObject): Int = node["flags"]!!.jsonPrimitive.int
}
