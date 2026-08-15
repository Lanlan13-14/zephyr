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

    @Test
    fun `locale manager tags map back to stored languages`() {
        assertEquals(AppLanguage.SYSTEM, AppLanguage.fromLocaleTags(""))
        assertEquals(AppLanguage.SYSTEM, AppLanguage.fromLocaleTags(null))
        assertEquals(AppLanguage.ZH_HANS, AppLanguage.fromLocaleTags("zh-CN"))
        assertEquals(AppLanguage.ZH_HANT, AppLanguage.fromLocaleTags("zh-TW,en"))
        assertEquals(AppLanguage.EN, AppLanguage.fromLocaleTags("en"))
    }

    @Test
    fun `locale apply is skipped when already applied or not yet loaded`() {
        assertEquals(null, LocaleApplyPolicy.pending(null, AppLanguage.SYSTEM))
        assertEquals(null, LocaleApplyPolicy.pending("system", AppLanguage.SYSTEM))
        assertEquals(null, LocaleApplyPolicy.pending("en", AppLanguage.EN))
        assertEquals(AppLanguage.EN, LocaleApplyPolicy.pending("en", AppLanguage.SYSTEM))
        assertEquals(AppLanguage.SYSTEM, LocaleApplyPolicy.pending("system", AppLanguage.ZH_HANS))
        assertEquals(AppLanguage.ZH_HANS, LocaleApplyPolicy.pending("zh-Hans", AppLanguage.EN))
    }
}
