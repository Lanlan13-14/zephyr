package one.zephyr.mobile.ui.chrome

import org.junit.Assert.assertEquals
import org.junit.Test

class PageChromeTest {

    @Test
    fun `head top padding is status bar plus frozen 14dp`() {
        assertEquals(14f, pageHeadTopPaddingDp(statusBarDp = 0f))
        assertEquals(50f, pageHeadTopPaddingDp(statusBarDp = 36f))
        assertEquals(14f, PageChrome.extraTop.value)
        assertEquals(16f, PageChrome.horizontal.value)
        assertEquals(38f, PageChrome.actionSize.value)
    }
}
