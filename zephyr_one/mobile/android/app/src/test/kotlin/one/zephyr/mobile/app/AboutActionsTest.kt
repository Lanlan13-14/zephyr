package one.zephyr.mobile.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AboutActionsTest {

    @Test
    fun `about destinations are distinct HTTPS project URLs`() {
        val urls = AboutDestination.entries.map(AboutDestination::url)

        assertEquals(urls.size, urls.toSet().size)
        assertTrue(urls.all { it.startsWith("https://github.com/Lanlan13-14/zephyr") })
        assertTrue(AboutDestination.CHECK_UPDATE.url.endsWith("/releases/latest"))
        assertTrue(AboutDestination.OPEN_SOURCE_LICENSES.url.endsWith("/THIRD_PARTY_NOTICES.md"))
    }
}
