package one.zephyr.mobile.ui.icon

import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.Protocol
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A card must pick the same glyph the web app picks for the same connection.
 */
class OsIconKeyTest {

    @Test
    fun aStoredKeyWinsOverTheName() {
        val connection = connection(name = "ubuntu box", icon = "debian")

        assertEquals("debian", OsIcons.cardIconKey(connection))
    }

    @Test
    fun autoFallsBackToTheNameTheWayTheWebAppDoes() {
        assertEquals("debian", OsIcons.cardIconKey(connection(name = "home", remark = "debian 12")))
        assertEquals("ubuntu", OsIcons.cardIconKey(connection(name = "Ubuntu 24.04")))
        assertEquals("arch", OsIcons.cardIconKey(connection(name = "manjaro laptop")))
        assertEquals("redhat", OsIcons.cardIconKey(connection(name = "rocky-9")))
        assertEquals("alpine", OsIcons.cardIconKey(connection(name = "edge", tags = listOf("alpine"))))
        assertEquals("raspberry", OsIcons.cardIconKey(connection(name = "pi 5")))
        assertEquals("macos", OsIcons.cardIconKey(connection(name = "MacBook")))
        assertEquals("windows", OsIcons.cardIconKey(connection(name = "win11")))
        assertEquals("linux", OsIcons.cardIconKey(connection(name = "kali")))
    }

    @Test
    fun theGuessReadsTheHostAndTagsAsWellAsTheName() {
        assertEquals("debian", OsIcons.cardIconKey(connection(name = "home", host = "debian.lan")))
        assertEquals("ubuntu", OsIcons.cardIconKey(connection(name = "home", tags = listOf("ubuntu"))))
    }

    @Test
    fun rdpWithNothingElseToGoOnIsWindows() {
        assertEquals("windows", OsIcons.cardIconKey(connection(name = "home", protocol = Protocol.RDP)))
    }

    @Test
    fun sshWithNothingToGoOnStaysUnresolved() {
        assertNull(OsIcons.cardIconKey(connection(name = "home", host = "192.168.21.10")))
    }

    @Test
    fun aKeyWithNoGlyphIsNotInvented() {
        assertNull(OsIcons.cardIconKey(connection(name = "home", icon = "freebsd")))
    }

    @Test
    fun everyResolvedKeyHasAGlyph() {
        listOf("windows", "macos", "ubuntu", "debian", "arch", "alpine", "raspberry", "redhat", "linux")
            .forEach { key ->
                assertNotNull(key, OsIcons.glyphFor(key))
                assertEquals(key, OsIcons.cardIconKey(connection(name = "x", icon = key)))
            }
    }

    private fun connection(
        name: String,
        icon: String = "auto",
        remark: String = "",
        host: String = "10.0.0.1",
        tags: List<String> = emptyList(),
        protocol: Protocol = Protocol.SSH,
    ): Connection = Connection(
        id = "c-1",
        ownerUserId = "user-1",
        protocol = protocol,
        name = name,
        host = host,
        port = protocol.defaultPort,
        remark = remark,
        tags = tags,
        icon = icon,
    )
}
