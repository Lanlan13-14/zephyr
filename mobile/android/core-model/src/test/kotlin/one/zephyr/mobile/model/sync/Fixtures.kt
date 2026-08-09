package one.zephyr.mobile.model.sync

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.model.PendingOperation

/**
 * Loads the cross-platform fixtures produced by mobile/tools/generate.mjs.
 *
 * The Kotlin, Swift and Node implementations of the sync algebra are all verified against the same
 * JSON so a divergence is a test failure rather than a field bug.
 */
object Fixtures {

    private val json = Json { ignoreUnknownKeys = true }

    /** Walks up from the Gradle module dir to mobile/, which holds contracts/generated. */
    private fun mobileRoot(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            if (File(dir, "contracts/generated/sync-cases.json").isFile) return dir
            dir = dir.parentFile
        }
        throw IllegalStateException("could not locate mobile/contracts/generated from " + System.getProperty("user.dir"))
    }

    fun load(name: String): JsonObject =
        json.parseToJsonElement(File(mobileRoot(), "contracts/generated/" + name).readText()).jsonObject

    val syncCases: JsonObject by lazy { load("sync-cases.json") }
    val aadVectors: JsonObject by lazy { load("aad-vectors.json") }
    val zft2Frames: JsonObject by lazy { load("zft2-frames.json") }

    fun array(root: JsonObject, key: String): List<JsonObject> =
        root[key]!!.jsonArray.map { it.jsonObject }

    fun strings(element: JsonElement?): List<String> =
        (element as? JsonArray)?.map { it.jsonPrimitive.content } ?: emptyList()

    fun operation(node: JsonObject): PendingOperation = PendingOperation(
        opId = node["opId"]!!.jsonPrimitive.content,
        entityType = node["entityType"]!!.jsonPrimitive.content,
        entityId = node["entityId"]!!.jsonPrimitive.content,
        action = SyncAction.valueOf(node["action"]!!.jsonPrimitive.content.uppercase()),
        baseRevision = node["baseRevision"]?.jsonPrimitive?.long ?: 0L,
        fieldMask = strings(node["fieldMask"]),
        payload = node["payload"]?.jsonObject ?: JsonObject(emptyMap()),
        createdAt = 0L,
        createdLocally = (node["createdLocally"] as? JsonPrimitive)?.boolean ?: false,
    )
}
