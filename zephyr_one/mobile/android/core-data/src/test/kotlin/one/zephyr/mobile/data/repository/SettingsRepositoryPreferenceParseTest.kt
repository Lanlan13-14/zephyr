package one.zephyr.mobile.data.repository

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.data.EntityCodec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SettingsRepositoryPreferenceParseTest {

    @Test
    fun `JSON objects survive and bare strings are skipped`() {
        val objectRow = EntityCodec.encode(JsonObject(mapOf("value" to JsonPrimitive("zh"))))
        assertEquals("zh", EntityCodec.string(SettingsRepository.parsePreferenceValue(objectRow)!!, "value"))
        assertNull(SettingsRepository.parsePreferenceValue("srv-published"))
        assertNull(SettingsRepository.parsePreferenceValue("deadbeef"))
        assertNull(SettingsRepository.parsePreferenceValue("{"))
    }
}
