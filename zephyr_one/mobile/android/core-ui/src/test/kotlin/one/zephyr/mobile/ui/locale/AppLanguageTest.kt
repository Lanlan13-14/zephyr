package one.zephyr.mobile.ui.locale

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class AppLanguageTest {

    @Test
    fun `only system chinese and english are stored`() {
        assertEquals(
            listOf("system", "zh-Hans", "en"),
            AppLanguage.stored.map { it.code },
        )
        assertFalse(AppLanguage.stored.any { it.code == "ja" })
        assertFalse(AppLanguage.stored.any { it.code == "zh-Hant" })
    }

    @Test
    fun `legacy packs fall back to system`() {
        assertEquals(AppLanguage.SYSTEM, AppLanguage.fromStored("ja"))
        assertEquals(AppLanguage.SYSTEM, AppLanguage.fromStored("zh-Hant"))
        assertEquals(AppLanguage.SYSTEM, AppLanguage.fromStored("zh-tw"))
        assertEquals(AppLanguage.ZH_HANS, AppLanguage.fromStored("zh"))
        assertEquals(AppLanguage.ZH_HANS, AppLanguage.fromStored("zh-CN"))
        assertEquals(AppLanguage.EN, AppLanguage.fromStored("en-US"))
        assertEquals(AppLanguage.SYSTEM, AppLanguage.fromStored(null))
    }
}
