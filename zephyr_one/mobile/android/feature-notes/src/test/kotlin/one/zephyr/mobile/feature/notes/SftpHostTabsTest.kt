package one.zephyr.mobile.feature.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SftpHostTabsTest {

    @Test
    fun firstPickOpensAndFocuses() {
        val tabs = SftpHostTabs().open("a")
        assertEquals(listOf("a"), tabs.openIds)
        assertEquals("a", tabs.focusedId)
    }

    @Test
    fun plusAddsAnotherWithoutDroppingTheFirst() {
        val tabs = SftpHostTabs().open("a").open("b")
        assertEquals(listOf("a", "b"), tabs.openIds)
        assertEquals("b", tabs.focusedId)
        assertEquals(listOf("a", "b"), tabs.focus("a").openIds)
        assertEquals("a", tabs.focus("a").focusedId)
    }

    @Test
    fun openingTheSameHostJustFocuses() {
        val tabs = SftpHostTabs().open("a").open("b").open("a")
        assertEquals(listOf("a", "b"), tabs.openIds)
        assertEquals("a", tabs.focusedId)
    }

    @Test
    fun closeLastReturnsToThePicker() {
        val closed = SftpHostTabs().open("a").open("b").close("b").close("a")
        assertTrue(closed.isEmpty)
        assertEquals(null, closed.focusedId)
    }
}
