package one.zephyr.mobile.data.mapper

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.data.EntityCodec
import one.zephyr.mobile.data.db.MirrorEntityRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AiProviderMapperTest {

    @Test
    fun `projects nested max_tokens and presence_penalty without treating them as secrets`() {
        val payload = JsonObject(
            mapOf(
                "ownerUserId" to JsonPrimitive("user-1"),
                "name" to JsonPrimitive("openai"),
                "type" to JsonPrimitive("openai-compatible"),
                "baseUrl" to JsonPrimitive("https://api.openai.com/v1"),
                "defaultModel" to JsonPrimitive("gpt-4o"),
                "hasApiKey" to JsonPrimitive(true),
                "enabled" to JsonPrimitive(true),
                "config" to JsonObject(
                    mapOf(
                        "apiMode" to JsonPrimitive("chat"),
                        "options" to JsonObject(
                            mapOf(
                                "max_tokens" to JsonPrimitive(4096),
                                "presence_penalty" to JsonPrimitive(0.2),
                                "frequency_penalty" to JsonPrimitive(0.1),
                                "vision" to JsonPrimitive(true),
                            ),
                        ),
                    ),
                ),
                "models" to JsonArray(
                    listOf(
                        JsonObject(
                            mapOf(
                                "id" to JsonPrimitive("gpt-4o"),
                                "label" to JsonPrimitive("GPT-4o"),
                                "contextWindowTokens" to JsonPrimitive(128000),
                                "maxOutputTokens" to JsonPrimitive(16384),
                                "input" to JsonObject(mapOf("image" to JsonPrimitive(true))),
                            ),
                        ),
                    ),
                ),
            ),
        )
        val row = MirrorEntityRow(
            entityType = "aiProvider",
            entityId = "prov-1",
            ownerUserId = "user-1",
            revision = 3,
            payloadJson = EntityCodec.encode(payload),
            secretPresenceJson = EntityCodec.encode(JsonObject(mapOf("hasApiKey" to JsonPrimitive(true)))),
            deletedAt = null,
            serverUpdatedAt = 10L,
            localUpdatedAt = 10L,
        )

        val provider = ResourceMappers.aiProvider(row)

        assertEquals("openai", provider.name)
        assertEquals(4096, provider.config.maxTokens)
        assertEquals(0.2, provider.config.presencePenalty!!, 0.0)
        assertEquals(0.1, provider.config.frequencyPenalty!!, 0.0)
        assertTrue(provider.apiKey.hasValue)
        assertEquals("gpt-4o", provider.models.single().id)
        assertEquals(128000, provider.models.single().contextWindowTokens)
        assertTrue(provider.models.single().inputImage)

        val values = ResourceMappers.aiProviderValues(provider)
        val options = ((values["config"] as JsonObject)["options"] as JsonObject)
        assertEquals(JsonPrimitive(4096), options["max_tokens"])
        assertEquals(JsonPrimitive(0.2), options["presence_penalty"])
    }

    @Test
    fun `ai memory and env projections keep presence-only secrets`() {
        val memory = ResourceMappers.aiMemory(
            row(
                "aiMemory",
                JsonObject(
                    mapOf(
                        "title" to JsonPrimitive("prod"),
                        "content" to JsonPrimitive("deploy as root"),
                        "scope" to JsonPrimitive("global"),
                    ),
                ),
            ),
        )
        val env = ResourceMappers.aiEnv(
            row(
                "aiEnv",
                JsonObject(
                    mapOf(
                        "name" to JsonPrimitive("OPENAI_BASE"),
                        "enabled" to JsonPrimitive(true),
                        "visibleToAi" to JsonPrimitive(true),
                        "hasValue" to JsonPrimitive(true),
                    ),
                ),
                presence = JsonObject(mapOf("hasValue" to JsonPrimitive(true))),
            ),
        )

        assertEquals("prod", memory.title)
        assertEquals("deploy as root", memory.content)
        assertEquals("OPENAI_BASE", env.name)
        assertTrue(env.value.hasValue)
    }

    private fun row(
        type: String,
        payload: JsonObject,
        presence: JsonObject = JsonObject(emptyMap()),
    ): MirrorEntityRow = MirrorEntityRow(
        entityType = type,
        entityId = "$type-1",
        ownerUserId = "user-1",
        revision = 1,
        payloadJson = EntityCodec.encode(payload),
        secretPresenceJson = EntityCodec.encode(presence),
        deletedAt = null,
        serverUpdatedAt = 1L,
        localUpdatedAt = 1L,
    )
}
