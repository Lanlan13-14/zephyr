package one.zephyr.mobile.data

import java.util.UUID
import kotlinx.serialization.json.*
import one.zephyr.mobile.contracts.EntityRegistry

/** Pure D1 planner. Never moves rows or reuses ids from the device-local workspace. */
data class LocalImportSource(val type: String, val id: String, val payload: JsonObject)
data class LocalImportCopy(val type: String, val sourceId: String, val newId: String, val values: JsonObject)

object LocalImportPlanner {
    fun eligible(type: String): Boolean = type in copyableTypes

    val copyableTypes = setOf("connection", "proxy", "sshKey", "jumpHost", "note", "snippet", "aiProvider", "aiMemory", "aiSkill", "aiEnv", "aiTodo", "aiConversation", "aiMessage")
    val excludedTypes = EntityRegistry.byType.keys - copyableTypes

    private val referenceFields = mapOf(
        "connection" to mapOf("proxyId" to "proxy", "sshKeyId" to "sshKey", "jumpHostId" to "jumpHost", "jumpHostIds" to "jumpHost"),
        "jumpHost" to mapOf("connectionId" to "connection"),
        "note" to mapOf("linkedConnectionIds" to "connection"),
        "aiMemory" to mapOf("connectionIds" to "connection"),
        "aiConversation" to mapOf("providerId" to "aiProvider"),
        "aiMessage" to mapOf("conversationId" to "aiConversation"),
    )

    fun plan(source: List<LocalImportSource>, selectedTypes: Set<String>, idFor: (String, String) -> String = { _, _ -> UUID.randomUUID().toString() }): List<LocalImportCopy> {
        require(selectedTypes.all(::eligible)) { "Singleton settings and paired device identities cannot be copied as new" }
        val keys = source.map { it.type to it.id }
        require(keys.size == keys.toSet().size) { "Duplicate source identity" }
        require(keys.all { (type, id) -> EntityRegistry.byType.containsKey(type) && id.isNotBlank() }) { "Invalid source identity" }
        val chosen = source.filter { it.type in selectedTypes }
        require(chosen.isNotEmpty()) { "Select at least one nonempty type" }
        val ids = chosen.associate { (it.type to it.id) to idFor(it.type, it.id) }
        require(ids.values.all { it.isNotBlank() } && ids.values.toSet().size == ids.size) { "New identities must be nonempty and unique" }
        require(ids.values.none { id -> source.any { it.id == id } }) { "Source ids must never be reused" }
        val known = keys.toSet()
        fun target(ownerType: String, key: String): String? = referenceFields[ownerType]?.get(key)
        fun reference(type: String, value: JsonElement): JsonElement = when (value) {
            JsonNull -> JsonNull
            is JsonPrimitive -> {
                require(value.isString) { "Reference ids must be strings" }
                val old = value.content
                if (old.isBlank()) value else {
                    require((type to old) in known) { "Unresolved $type reference; copy its dependency first" }
                    val new = ids[type to old] ?: error("Referenced $type was not selected")
                    JsonPrimitive(new)
                }
            }
            else -> throw IllegalArgumentException("Invalid reference shape")
        }
        fun at(payload: JsonObject, path: String): JsonElement? = path.split('.').fold(payload as JsonElement?) { node, key -> (node as? JsonObject)?.get(key) }
        fun put(map: MutableMap<String, JsonElement>, parts: List<String>, value: JsonElement) {
            if (parts.size == 1) map[parts.first()] = value
            else {
                val child = ((map[parts.first()] as? JsonObject)?.toMutableMap() ?: mutableMapOf())
                put(child, parts.drop(1), value)
                map[parts.first()] = JsonObject(child)
            }
        }
        return chosen.sortedWith(compareBy<LocalImportSource> { EntityRegistry.byType.getValue(it.type).dependencyOrder }.thenBy { it.type }.thenBy { it.id }).map { row ->
            val spec = EntityRegistry.byType.getValue(row.type)
            val values = linkedMapOf<String, JsonElement>()
            val safeSource = SecretPayloadSanitizer.sanitizeForStorage(row.type, row.payload)
            for (field in spec.editableFields) at(safeSource, field)?.let { value ->
                val type = target(row.type, field)
                val rewritten = if (type == null) value else if (field.endsWith("Ids")) {
                    require(value is JsonArray) { "Reference list must be an array" }
                    JsonArray(value.map { reference(type, it) })
                } else reference(type, value)
                put(values, field.split('.'), rewritten)
            }
            // A copy belongs only to its destination owner. Never clone sharing grants or a public
            // visibility flag from another workspace/account.
            if ("sharedUserIds" in spec.editableFields) values["sharedUserIds"] = JsonArray(emptyList())
            for (field in listOf("shareWithUsers", "shareWithAdmins")) if (field in spec.editableFields) values[field] = JsonPrimitive(false)
            if ("visibility" in spec.editableFields) values["visibility"] = JsonPrimitive("private")
            LocalImportCopy(row.type, row.id, ids.getValue(row.type to row.id), JsonObject(values))
        }
    }
}
