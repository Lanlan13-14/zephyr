package one.zephyr.mobile.protocol.rdp

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class RdpFingerprintBookTest {

    @get:Rule
    val folder = TemporaryFolder()

    @Test
    fun `normalize strips sha256 prefix and colonates hex`() {
        assertEquals(
            "AA:BB:CC:DD",
            RdpFingerprintBook.normalize("sha256:aabbccdd"),
        )
        assertEquals(
            "AA:BB:CC:DD",
            RdpFingerprintBook.normalize("AA:bb:CC:dd"),
        )
        assertEquals("AA:BB:CC:DD", RdpFingerprintBook.normalize("aabb-ccdd"))
        assertEquals("", RdpFingerprintBook.normalize("not-hex"))
        assertEquals("", RdpFingerprintBook.normalize("aa:bb:c"))
        assertEquals("", RdpFingerprintBook.normalize(""))
    }

    @Test
    fun `file book survives a process restart`() {
        val file = File(folder.root, "rdp-trust.properties")
        FileRdpFingerprintBook(file).put("WIN-LAB", 3389, "sha256:aabbccdd")

        val reloaded = FileRdpFingerprintBook(file)
        assertEquals("AA:BB:CC:DD", reloaded.find("win-lab", 3389))
        assertNull(reloaded.find("win-lab", 3390))
    }
}
