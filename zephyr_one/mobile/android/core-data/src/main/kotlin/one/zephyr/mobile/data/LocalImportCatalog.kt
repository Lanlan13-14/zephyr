package one.zephyr.mobile.data

import kotlinx.serialization.json.*
import one.zephyr.mobile.data.mapper.AiProviderSyncMappers
import one.zephyr.mobile.data.mapper.ResourceMappers
import one.zephyr.mobile.data.repository.LocalAiCatalog

/** Local AI is a device catalog, not necessarily a sync mirror. Never write it just to preview. */
object LocalImportCatalog {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    fun decode(raw: String): LocalAiCatalog = json.decodeFromString<LocalAiCatalog>(raw)

    fun sources(catalog: LocalAiCatalog, owner: String): List<LocalImportSource> = buildList {
        for (provider in catalog.providers) add(LocalImportSource("aiProvider", provider.id,
            ResourceMappers.aiProviderValues(AiProviderSyncMappers.toModel(provider, owner))))
        for (memory in catalog.memories) add(LocalImportSource("aiMemory", memory.id, buildJsonObject {
            put("title", memory.title); put("content", memory.content); put("scope", memory.scope); put("project", memory.project)
            put("tags", JsonArray(memory.tags.map { JsonPrimitive(it) }))
            put("connectionIds", JsonArray(memory.connectionIds.map { JsonPrimitive(it) }))
        }))
        for (skill in catalog.skills) add(LocalImportSource("aiSkill", skill.id, buildJsonObject {
            put("name", skill.name); put("description", skill.description); put("prompt", skill.prompt); put("enabled", skill.enabled)
        }))
        for (environment in catalog.environment) add(LocalImportSource("aiEnv", environment.id, buildJsonObject {
            put("name", environment.name); put("enabled", environment.enabled); put("visibleToAi", environment.visibleToAi)
        }))
        for (todo in catalog.todos.filter { it.deletedAt == null }) add(LocalImportSource("aiTodo", todo.id, buildJsonObject {
            put("title", todo.title); put("description", todo.description); put("status", todo.status); put("priority", todo.priority)
            put("dueAt", todo.dueAt?.let { JsonPrimitive(it) } ?: JsonNull)
            put("note", todo.note); put("source", todo.source)
            putJsonArray("steps") { for (step in todo.steps) add(buildJsonObject {
                put("id", step.id); put("title", step.title); put("done", step.done)
            }) }
        }))
    }
}
