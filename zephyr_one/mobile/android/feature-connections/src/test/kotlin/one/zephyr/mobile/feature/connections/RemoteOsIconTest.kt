package one.zephyr.mobile.feature.connections

import one.zephyr.mobile.model.Protocol
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The probe text is what `cat /etc/os-release; uname -s` actually prints, and the decision is the
 * one the main end makes before it writes an icon back.
 */
class RemoteOsIconTest {

    @Test
    fun debianIsRecognisedFromTheOsReleaseId() {
        val text = """
            NAME="Debian GNU/Linux"
            VERSION_ID="12"
            ID=debian
            ID_LIKE=debian
            PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"

            Linux
        """.trimIndent()

        assertEquals("debian", RemoteOsIcon.iconKeyFromProbe(text))
    }

    @Test
    fun ubuntuIsRecognisedAheadOfItsDebianBase() {
        val text = """
            NAME="Ubuntu"
            ID=ubuntu
            ID_LIKE=debian
            PRETTY_NAME="Ubuntu 24.04 LTS"

            Linux
        """.trimIndent()

        assertEquals("ubuntu", RemoteOsIcon.iconKeyFromProbe(text))
    }

    @Test
    fun archIsRecognisedFromItsId() {
        val text = """
            NAME="Arch Linux"
            ID=arch
            PRETTY_NAME="Arch Linux"

            Linux
        """.trimIndent()

        assertEquals("arch", RemoteOsIcon.iconKeyFromProbe(text))
    }

    @Test
    fun aDerivativeFallsBackToTheGenericLinuxGlyph() {
        val text = """
            NAME="Kali GNU/Linux"
            ID=kali
            ID_LIKE=debian

            Linux
        """.trimIndent()

        assertEquals("linux", RemoteOsIcon.iconKeyFromProbe(text))
    }

    @Test
    fun unameAloneIsEnoughWhenOsReleaseIsMissing() {
        assertEquals("linux", RemoteOsIcon.iconKeyFromProbe("\nLinux\n"))
    }

    @Test
    fun anEmptyProbeIdentifiesNothing() {
        assertNull(RemoteOsIcon.iconKeyFromProbe(""))
        assertNull(RemoteOsIcon.iconKeyFromProbe("no such file"))
    }

    @Test
    fun anAutoConnectionTakesTheDetectedSystem() {
        val connection = Fixtures.connection(icon = "auto")

        val update = RemoteOsIcon.updateFor(connection, "debian", manual = false)

        assertEquals("debian", update?.icon)
        assertEquals(listOf("icon"), update?.mask)
        assertEquals("debian", update?.connection?.icon)
    }

    @Test
    fun aManualChoiceIsNeverOverwritten() {
        val connection = Fixtures.connection(icon = "ubuntu")

        assertNull(RemoteOsIcon.updateFor(connection, "debian", manual = true))
    }

    @Test
    fun aPreviouslyProbedIconIsReplacedWhenTheSystemChanged() {
        val connection = Fixtures.connection(icon = "debian")

        val update = RemoteOsIcon.updateFor(connection, "ubuntu", manual = false)

        assertEquals("ubuntu", update?.icon)
    }

    @Test
    fun anUnchangedIconIsNotWrittenAgain() {
        val connection = Fixtures.connection(icon = "debian")

        assertNull(RemoteOsIcon.updateFor(connection, "debian", manual = false))
    }

    @Test
    fun anUnidentifiedProbeWritesNothing() {
        val connection = Fixtures.connection(icon = "auto", protocol = Protocol.SSH)

        assertNull(RemoteOsIcon.updateFor(connection, null, manual = false))
        assertNull(RemoteOsIcon.updateFor(connection, "  ", manual = false))
    }
}
