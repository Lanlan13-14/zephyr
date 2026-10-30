package one.zephyr.mobile.data

import one.zephyr.mobile.data.repository.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class LocalImportCatalogTest {
    @Test fun `device only ai catalog is projected without requiring mirror or mutating owner`() {
        val catalog = LocalAiCatalog(
            providers = listOf(LocalAiProvider(id = "p", name = "P", baseUrl = "https://example.invalid", shareWithUsers = true)),
            environment = listOf(LocalAiEnvironment(id = "e", name = "E")),
            memories = listOf(LocalAiMemory(id = "m", title = "M", connectionIds = listOf("c"))),
            skills = listOf(LocalAiSkill(id = "s", name = "S")),
            todos = listOf(LocalAiTodo(id = "t", title = "T"), LocalAiTodo(id = "deleted", title = "D", deletedAt = 1L)),
        )
        val sources = LocalImportCatalog.sources(catalog, "local")
        assertEquals(setOf("aiProvider", "aiEnv", "aiMemory", "aiSkill", "aiTodo"), sources.map { it.type }.toSet())
        assertFalse(sources.any { it.id == "deleted" })
        val copy = LocalImportPlanner.plan(sources + LocalImportSource("connection", "c", buildJsonObject { put("name", "C") }),
            sources.map { it.type }.toSet() + "connection") { type, id -> "new-$type-$id" }
        val memory = copy.single { it.type == "aiMemory" }
        assertEquals(JsonPrimitive("new-connection-c"), memory.values.getValue("connectionIds").jsonArray.single())
        assertEquals(JsonPrimitive(false), copy.single { it.type == "aiProvider" }.values["shareWithUsers"])
        assertTrue(catalog.providers.single().shareWithUsers)
        assertFalse(sources.toString().contains("ownerUserId"))
    }

    @Test fun `malformed catalog fails rather than pretending source is empty`() {
        assertThrows(Exception::class.java) { LocalImportCatalog.decode("not-json") }
    }
}
