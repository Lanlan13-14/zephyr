package one.zephyr.mobile.app

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.data.repository.SettingsRepository
import one.zephyr.mobile.security.LockDelay
import one.zephyr.mobile.ui.theme.ZephyrThemeId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppearancePrefsTest {

    @Test
    fun `defaults when the preference table is empty`() {
        val prefs = appearanceFromPrefs(emptyMap())
        assertEquals(ZephyrThemeId.FROST, prefs.themeId)
        assertEquals(AppearanceMode.AUTO, prefs.mode)
        assertFalse(prefs.lockEnabled)
        assertFalse(prefs.lockRecorded)
        assertEquals(LockDelay.IMMEDIATE, prefs.lockTimeout)
        assertFalse(prefs.screenshotGuard)
    }

    @Test
    fun `reads stored theme lock and screenshot values`() {
        val prefs = appearanceFromPrefs(
            mapOf(
                SettingsRepository.PREF_THEME to JsonObject(mapOf("value" to JsonPrimitive("lava"))),
                SettingsRepository.PREF_AUTO_THEME to JsonObject(mapOf("value" to JsonPrimitive("dark"))),
                SettingsRepository.PREF_APP_LOCK_ENABLED to JsonObject(mapOf("value" to JsonPrimitive(true))),
                SettingsRepository.PREF_APP_LOCK_TIMEOUT to JsonObject(mapOf("value" to JsonPrimitive("5m"))),
                SettingsRepository.PREF_SCREENSHOT_GUARD to JsonObject(mapOf("value" to JsonPrimitive(true))),
            ),
        )
        assertEquals(ZephyrThemeId.LAVA, prefs.themeId)
        assertEquals(AppearanceMode.DARK, prefs.mode)
        assertTrue(prefs.lockEnabled)
        assertTrue(prefs.lockRecorded)
        assertEquals(LockDelay.FIVE_MINUTES, prefs.lockTimeout)
        assertTrue(prefs.screenshotGuard)
    }
}
