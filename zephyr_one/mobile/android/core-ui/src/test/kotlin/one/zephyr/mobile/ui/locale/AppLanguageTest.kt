package one.zephyr.mobile.ui.locale

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class AppLanguageTest {

    @Test
    fun `demo languages are stored in order`() {
        assertEquals(
            listOf("system", "zh-Hans", "zh-Hant", "en"),
            AppLanguage.stored.map { it.code },
        )
        assertFalse(AppLanguage.stored.any { it.code == "ja" })
    }

    @Test
    fun `stored and legacy tags resolve safely`() {
        assertEquals(AppLanguage.SYSTEM, AppLanguage.fromStored("ja"))
        assertEquals(AppLanguage.ZH_HANT, AppLanguage.fromStored("zh-Hant"))
        assertEquals(AppLanguage.ZH_HANT, AppLanguage.fromStored("zh-tw"))
        assertEquals(AppLanguage.ZH_HANS, AppLanguage.fromStored("zh"))
        assertEquals(AppLanguage.ZH_HANS, AppLanguage.fromStored("zh-CN"))
        assertEquals(AppLanguage.EN, AppLanguage.fromStored("en-US"))
        assertEquals(AppLanguage.SYSTEM, AppLanguage.fromStored(null))
    }
}
