package one.zephyr.mobile.app

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerAiEnabledTest {

    @Test
    fun `missing settings hide the button`() {
        assertFalse(serverAiEnabled(JsonObject(emptyMap())))
    }

    @Test
    fun `nested server payload decides the button`() {
        assertFalse(serverAiEnabled(buildJsonObject { put("ai", buildJsonObject { put("enabled", false) }) }))
        assertTrue(serverAiEnabled(buildJsonObject { put("ai", buildJsonObject { put("enabled", true) }) }))
    }

    @Test
    fun `flat key from older rows still counts`() {
        assertFalse(serverAiEnabled(JsonObject(mapOf("ai.enabled" to JsonPrimitive(false)))))
        assertTrue(serverAiEnabled(JsonObject(mapOf("ai.enabled" to JsonPrimitive(true)))))
    }
}
