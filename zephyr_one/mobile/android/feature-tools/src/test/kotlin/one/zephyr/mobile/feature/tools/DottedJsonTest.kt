package one.zephyr.mobile.feature.tools

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DottedJsonTest {

    @Test
    fun `reads nested and dotted keys`() {
        val nested = JsonObject(
            mapOf(
                "ai" to JsonObject(
                    mapOf("enabled" to JsonPrimitive(true), "memory" to JsonObject(mapOf("enabled" to JsonPrimitive(false)))),
                ),
            ),
        )
        assertTrue(dottedBool(nested, "ai.enabled", false))
        assertFalse(dottedBool(nested, "ai.memory.enabled", true))
        assertEquals("missing", dottedText(nested, "appearance.theme", "missing"))

        val flat = JsonObject(mapOf("ai.enabled" to JsonPrimitive(false)))
        assertFalse(dottedBool(flat, "ai.enabled", true))
    }
}
