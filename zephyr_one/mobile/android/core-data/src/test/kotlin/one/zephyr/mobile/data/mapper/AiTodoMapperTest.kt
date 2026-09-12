package one.zephyr.mobile.data.mapper

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.data.EntityCodec
import one.zephyr.mobile.data.db.MirrorEntityRow
import one.zephyr.mobile.model.AiTodo
import one.zephyr.mobile.model.AiTodoStep
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AiTodoMapperTest {

    private fun row(payload: JsonObject, revision: Long = 4): MirrorEntityRow = MirrorEntityRow(
        entityType = AiTodo.ENTITY_TYPE,
        entityId = "todo-1",
        ownerUserId = "user-1",
        revision = revision,
        payloadJson = EntityCodec.encode(payload),
        secretPresenceJson = "null",
        deletedAt = null,
        serverUpdatedAt = 10L,
        localUpdatedAt = 10L,
    )

    @Test
    fun `projects the canonical aiTodo payload`() {
        val payload = JsonObject(
            mapOf(
                "title" to JsonPrimitive("检查生产服务器磁盘"),
                "description" to JsonPrimitive("df -h 并汇报"),
                "status" to JsonPrimitive("in_progress"),
                "priority" to JsonPrimitive("high"),
                "dueAt" to JsonPrimitive(1770000000000),
                "steps" to kotlinx.serialization.json.JsonArray(
                    listOf(
                        JsonObject(mapOf("id" to JsonPrimitive("step-1"), "title" to JsonPrimitive("登录"), "done" to JsonPrimitive(true))),
                        JsonObject(mapOf("id" to JsonPrimitive("step-2"), "title" to JsonPrimitive("执行"), "done" to JsonPrimitive(false))),
                    ),
                ),
                "note" to JsonPrimitive("AI 已开始"),
                "source" to JsonPrimitive("ai"),
            ),
        )
        val todo = ResourceMappers.aiTodo(row(payload))

        assertEquals("todo-1", todo.id)
        assertEquals("user-1", todo.ownerUserId)
        assertEquals("检查生产服务器磁盘", todo.title)
        assertEquals("in_progress", todo.status)
        assertEquals("high", todo.priority)
        assertEquals(1770000000000L, todo.dueAt)
        assertEquals(listOf(AiTodoStep("step-1", "登录", true), AiTodoStep("step-2", "执行", false)), todo.steps)
        assertEquals("ai", todo.source)
        assertEquals(4L, todo.revision)
    }

    @Test
    fun `null dueAt and missing steps survive the round trip`() {
        val payload = JsonObject(
            mapOf(
                "title" to JsonPrimitive("无截止时间"),
                "dueAt" to JsonNull,
            ),
        )
        val todo = ResourceMappers.aiTodo(row(payload))
        assertNull(todo.dueAt)
        assertEquals(emptyList<AiTodoStep>(), todo.steps)
        assertEquals("pending", todo.status)
        assertEquals("medium", todo.priority)
    }

    @Test
    fun `values projection is field-mask compatible with the main side`() {
        val todo = AiTodo(
            id = "todo-9",
            ownerUserId = "user-1",
            title = "往返",
            status = "completed",
            priority = "urgent",
            dueAt = 42L,
            steps = listOf(AiTodoStep("s1", "第一步", true)),
            note = "n",
            source = "web",
        )
        val values = ResourceMappers.aiTodoValues(todo)
        assertEquals("往返", (values["title"] as JsonPrimitive).content)
        assertEquals("completed", (values["status"] as JsonPrimitive).content)
        assertEquals("urgent", (values["priority"] as JsonPrimitive).content)
        assertEquals(42L, ((values["dueAt"] as JsonPrimitive).content).toLong())
        assertEquals("web", (values["source"] as JsonPrimitive).content)
        // round trip through the row mapper preserves the editable surface
        val back = ResourceMappers.aiTodo(row(values))
        assertEquals(todo.title, back.title)
        assertEquals(todo.status, back.status)
        assertEquals(todo.steps, back.steps)
    }
}
