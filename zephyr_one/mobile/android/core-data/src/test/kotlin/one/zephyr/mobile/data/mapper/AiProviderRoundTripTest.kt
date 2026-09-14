package one.zephyr.mobile.data.mapper

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.data.EntityCodec
import one.zephyr.mobile.data.db.MirrorEntityRow
import one.zephyr.mobile.model.AiProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The provider sync round-trip contract.
 *
 * Every case is a server projection the main end considers legal (projectAiProvider output).
 * Each case runs the real production chain -- aiProvider() -> AiProviderSyncMappers.toLocal()
 * -> toModel() -> aiProviderValues() -- and the pushed payload must stay canonical:
 * legal apiMode, finite numbers, non-blank model ids, and the exact field set the main end's
 * safePatch accepts. A field that drifts in any of the five mapping segments fails here with
 * the case name instead of surfacing as invalid_ai_provider on a device.
 */
class AiProviderRoundTripTest {

    private fun row(payload: JsonObject, entityId: String = "prov-1", revision: Long = 3): MirrorEntityRow =
        MirrorEntityRow(
            entityType = "aiProvider",
            entityId = entityId,
            ownerUserId = "user-1",
            revision = revision,
            payloadJson = EntityCodec.encode(payload),
            secretPresenceJson = EntityCodec.encode(JsonObject(mapOf("hasApiKey" to JsonPrimitive(true)))),
            deletedAt = null,
            serverUpdatedAt = 100L,
            localUpdatedAt = 100L,
        )

    private fun config(apiMode: String, options: JsonObject) =
        JsonObject(mapOf("apiMode" to JsonPrimitive(apiMode), "options" to options))

    /** Runs the full production chain and returns the payload One would push. */
    private fun roundTrip(payload: JsonObject): JsonObject {
        val mirrored: AiProvider = ResourceMappers.aiProvider(row(payload))
        val local = AiProviderSyncMappers.toLocal(mirrored, "main")
        val model = AiProviderSyncMappers.toModel(local, "user-1")
        return ResourceMappers.aiProviderValues(model)
    }

    @Test
    fun `every apiMode the main end accepts survives the round trip`() {
        for (mode in listOf("auto", "chat", "responses")) {
            val out = roundTrip(
                JsonObject(
                    mapOf(
                        "name" to JsonPrimitive("p-$mode"),
                        "type" to JsonPrimitive("openai-compatible"),
                        "baseUrl" to JsonPrimitive("https://api.openai.com/v1"),
                        "config" to config(mode, JsonObject(emptyMap())),
                    ),
                ),
            )
            val cfg = EntityCodec.obj(out, "config")
            assertNotNull("case $mode: config missing", cfg)
            assertEquals("case $mode: apiMode drifted", mode, EntityCodec.text(cfg!!, "apiMode"))
        }
    }

    @Test
    fun `flattened and nested context windows both survive`() {
        for (options in listOf(
            JsonObject(mapOf("context" to JsonObject(mapOf("windowTokens" to JsonPrimitive(128000))))),
            JsonObject(mapOf("windowTokens" to JsonPrimitive(64000))),
        )) {
            val out = roundTrip(
                JsonObject(
                    mapOf(
                        "name" to JsonPrimitive("ctx"),
                        "type" to JsonPrimitive("openai-compatible"),
                        "baseUrl" to JsonPrimitive("https://api.openai.com/v1"),
                        "config" to config("auto", options),
                    ),
                ),
            )
            val cfg = EntityCodec.obj(out, "config")!!
            val opts = EntityCodec.obj(cfg, "options")!!
            val ctx = EntityCodec.obj(opts, "context")
            assertNotNull("context window lost in round trip", ctx)
            val tokens = EntityCodec.intOrNull(ctx!!, "windowTokens")
            assertTrue("windowTokens invalid: $tokens", tokens != null && tokens > 0)
        }
    }

    @Test
    fun `all numeric options stay finite and non-negative in the pushed payload`() {
        val out = roundTrip(
            JsonObject(
                mapOf(
                    "name" to JsonPrimitive("numbers"),
                    "type" to JsonPrimitive("openai-compatible"),
                    "baseUrl" to JsonPrimitive("https://api.openai.com/v1"),
                    "config" to config(
                        "chat",
                        JsonObject(
                            mapOf(
                                "temperature" to JsonPrimitive(0.7),
                                "top_p" to JsonPrimitive(0.9),
                                "max_tokens" to JsonPrimitive(4096),
                                "max_output_tokens" to JsonPrimitive(16384),
                                "presence_penalty" to JsonPrimitive(0.2),
                                "frequency_penalty" to JsonPrimitive(0.1),
                                "vision" to JsonPrimitive(true),
                                "use_previous_response_id" to JsonPrimitive(false),
                                "reasoning_effort" to JsonPrimitive("high"),
                            ),
                        ),
                    ),
                ),
            ),
        )
        val opts = EntityCodec.obj(EntityCodec.obj(out, "config")!!, "options")!!
        for (field in listOf("temperature", "top_p", "max_tokens", "max_output_tokens", "presence_penalty", "frequency_penalty")) {
            val value = (opts[field] as? JsonPrimitive)?.content?.toDoubleOrNull()
            assertTrue("$field not finite: $value", value != null && value.isFinite())
        }
        assertEquals("high", EntityCodec.text(opts, "reasoning_effort"))
        assertEquals(true, EntityCodec.bool(opts, "vision", false))
    }

    @Test
    fun `every reasoning effort the main end accepts survives`() {
        for (effort in listOf("none", "minimal", "low", "medium", "high", "xhigh", "max")) {
            val out = roundTrip(
                JsonObject(
                    mapOf(
                        "name" to JsonPrimitive("effort-$effort"),
                        "type" to JsonPrimitive("openai-compatible"),
                        "baseUrl" to JsonPrimitive("https://api.openai.com/v1"),
                        "config" to config("auto", JsonObject(mapOf("reasoning_effort" to JsonPrimitive(effort)))),
                    ),
                ),
            )
            val opts = EntityCodec.obj(EntityCodec.obj(out, "config")!!, "options")!!
            assertEquals("effort $effort drifted", effort, EntityCodec.text(opts, "reasoning_effort"))
        }
    }

    @Test
    fun `model capabilities survive and invalid model ids are dropped`() {
        val out = roundTrip(
            JsonObject(
                mapOf(
                    "name" to JsonPrimitive("models"),
                    "type" to JsonPrimitive("openai-compatible"),
                    "baseUrl" to JsonPrimitive("https://api.openai.com/v1"),
                    "defaultModel" to JsonPrimitive("gpt-4o"),
                    "config" to config("responses", JsonObject(emptyMap())),
                    "models" to JsonArray(
                        listOf(
                            JsonObject(
                                mapOf(
                                    "id" to JsonPrimitive("gpt-4o"),
                                    "label" to JsonPrimitive("GPT-4o"),
                                    "reasoning" to JsonPrimitive(true),
                                    "reasoningEffort" to JsonPrimitive("medium"),
                                    "contextWindowTokens" to JsonPrimitive(128000),
                                    "maxOutputTokens" to JsonPrimitive(16384),
                                    "input" to JsonObject(mapOf("image" to JsonPrimitive(true), "pdf" to JsonPrimitive(true))),
                                    "output" to JsonObject(mapOf("image" to JsonPrimitive(false), "audio" to JsonPrimitive(true))),
                                    "promptCache" to JsonPrimitive("explicit"),
                                ),
                            ),
                            // A blank id is never a legal model; it must not survive the chain.
                            JsonObject(mapOf("id" to JsonPrimitive("  "), "label" to JsonPrimitive("blank"))),
                        ),
                    ),
                ),
            ),
        )
        val models = EntityCodec.objectList(out, "models")
        assertEquals(1, models.size)
        val model = models[0]
        assertEquals("gpt-4o", EntityCodec.text(model, "id"))
        assertEquals(true, EntityCodec.bool(model, "reasoning", false))
        assertEquals("medium", EntityCodec.text(model, "reasoningEffort"))
        assertEquals(128000, EntityCodec.intOrNull(model, "contextWindowTokens"))
        assertEquals("explicit", EntityCodec.text(model, "promptCache"))
        val input = EntityCodec.obj(model, "input")!!
        assertEquals(true, EntityCodec.bool(input, "image", false))
        assertEquals(true, EntityCodec.bool(input, "pdf", false))
    }

    @Test
    fun `anthropic providers round trip without apiMode rewriting`() {
        val out = roundTrip(
            JsonObject(
                mapOf(
                    "name" to JsonPrimitive("claude"),
                    "type" to JsonPrimitive("anthropic"),
                    "baseUrl" to JsonPrimitive("https://api.anthropic.com/v1"),
                    "defaultModel" to JsonPrimitive("claude-sonnet-4-5"),
                    "config" to config("auto", JsonObject(emptyMap())),
                ),
            ),
        )
        assertEquals("anthropic", EntityCodec.text(out, "type"))
        assertEquals("auto", EntityCodec.text(EntityCodec.obj(out, "config")!!, "apiMode"))
    }

    @Test
    fun `visibility and sharing survive untouched`() {
        val out = roundTrip(
            JsonObject(
                mapOf(
                    "name" to JsonPrimitive("shared"),
                    "type" to JsonPrimitive("openai-compatible"),
                    "baseUrl" to JsonPrimitive("https://api.openai.com/v1"),
                    "config" to config("auto", JsonObject(emptyMap())),
                    "visibility" to JsonPrimitive("shared"),
                    "shareWithUsers" to JsonPrimitive(true),
                    "shareWithAdmins" to JsonPrimitive(true),
                    "sharedUserIds" to JsonArray(listOf(JsonPrimitive("u2"), JsonPrimitive("u3"))),
                    "enabled" to JsonPrimitive(false),
                ),
            ),
        )
        assertEquals("shared", EntityCodec.text(out, "visibility"))
        assertEquals(true, EntityCodec.bool(out, "shareWithUsers", false))
        assertEquals(true, EntityCodec.bool(out, "shareWithAdmins", false))
        assertEquals(listOf("u2", "u3"), EntityCodec.stringList(out, "sharedUserIds"))
        assertEquals(false, EntityCodec.bool(out, "enabled", true))
    }

    @Test
    fun `pushed payloads are exported for the Node wire contract`() {
        val cases = linkedMapOf<String, JsonObject>()
        for (mode in listOf("auto", "chat", "responses")) {
            cases["apiMode-$mode"] = JsonObject(
                mapOf(
                    "name" to JsonPrimitive("p-$mode"),
                    "type" to JsonPrimitive("openai-compatible"),
                    "baseUrl" to JsonPrimitive("https://api.openai.com/v1"),
                    "config" to JsonObject(mapOf("apiMode" to JsonPrimitive(mode), "options" to JsonObject(emptyMap()))),
                ),
            )
        }
        cases["numeric-options"] = JsonObject(
            mapOf(
                "name" to JsonPrimitive("numbers"),
                "type" to JsonPrimitive("openai-compatible"),
                "baseUrl" to JsonPrimitive("https://api.openai.com/v1"),
                "config" to JsonObject(
                    mapOf(
                        "apiMode" to JsonPrimitive("chat"),
                        "options" to JsonObject(
                            mapOf(
                                "temperature" to JsonPrimitive(0.7),
                                "top_p" to JsonPrimitive(0.9),
                                "max_tokens" to JsonPrimitive(4096),
                                "max_output_tokens" to JsonPrimitive(16384),
                                "presence_penalty" to JsonPrimitive(0.2),
                                "frequency_penalty" to JsonPrimitive(0.1),
                                "reasoning_effort" to JsonPrimitive("high"),
                                "context" to JsonObject(mapOf("windowTokens" to JsonPrimitive(128000))),
                            ),
                        ),
                    ),
                ),
            ),
        )
        cases["anthropic"] = JsonObject(
            mapOf(
                "name" to JsonPrimitive("claude"),
                "type" to JsonPrimitive("anthropic"),
                "baseUrl" to JsonPrimitive("https://api.anthropic.com/v1"),
                "defaultModel" to JsonPrimitive("claude-sonnet-4-5"),
                "config" to JsonObject(mapOf("apiMode" to JsonPrimitive("auto"), "options" to JsonObject(emptyMap()))),
            ),
        )
        val exported = JsonObject(
            mapOf(
                "cases" to JsonObject(cases.mapValues { (_, payload) -> roundTrip(payload) }),
            ),
        )
        val dir = File(System.getProperty("user.dir"), "src/test/resources/roundtrip")
        dir.mkdirs()
        File(dir, "ai-provider-pushes.json").writeText(exported.toString())
        assertTrue(exported.toString().contains("apiMode"))
    }
}