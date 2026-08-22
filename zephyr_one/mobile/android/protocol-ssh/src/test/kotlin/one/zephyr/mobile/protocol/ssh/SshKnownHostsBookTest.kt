package one.zephyr.mobile.protocol.ssh

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SshKnownHostsBookTest {

    @get:Rule
    val tempDir = TemporaryFolder()

    @Test
    fun `memory book records and removes keys`() {
        val book = MemorySshKnownHostsBook()
        assertNull(book.find("10.0.0.5", 22))

        book.put("10.0.0.5", 22, KEY_A)
        assertEquals(KEY_A, book.find("10.0.0.5", 22))
        assertEquals(KEY_A, book.find("10.0.0.5", 22))
        assertNull(book.find("10.0.0.5", 2222))
        assertNull(book.find("10.0.0.6", 22))

        book.remove("10.0.0.5", 22)
        assertNull(book.find("10.0.0.5", 22))
    }

    @Test
    fun `file book persists across distinct instances`() {
        val file = File(tempDir.newFolder(), "ssh_known_hosts")
        val book1 = FileSshKnownHostsBook(file)
        assertNull(book1.find("192.168.1.10", 22))

        book1.put("192.168.1.10", 22, KEY_ED25519)
        book1.put("srv.example.com", 2222, KEY_A)

        val book2 = FileSshKnownHostsBook(file)
        assertEquals(KEY_ED25519, book2.find("192.168.1.10", 22))
        assertEquals(KEY_A, book2.find("srv.example.com", 2222))
        assertEquals(KEY_A, book2.find("SRV.EXAMPLE.COM", 2222))
        assertNull(book2.find("srv.example.com", 22))

        book2.remove("192.168.1.10", 22)

        val book3 = FileSshKnownHostsBook(file)
        assertNull(book3.find("192.168.1.10", 22))
        assertEquals(KEY_A, book3.find("srv.example.com", 2222))
    }

    @Test
    fun `replacing a key updates the stored key value`() {
        val file = File(tempDir.newFolder(), "ssh_known_hosts")
        val book = FileSshKnownHostsBook(file)

        book.put("host-1", 22, KEY_A)
        assertEquals(KEY_A, book.find("host-1", 22))

        book.put("host-1", 22, KEY_B)
        assertEquals(KEY_B, book.find("host-1", 22))

        val reloaded = FileSshKnownHostsBook(file)
        assertEquals(KEY_B, reloaded.find("host-1", 22))
    }

    @Test
    fun `base64 roundtrip handles all alignment lengths`() {
        for (len in 0..128) {
            val original = ByteArray(len) { i -> ((i * 7 + 13) and 0xFF).toByte() }
            val encoded = FileSshKnownHostsBook.encodeBase64(original)
            val decoded = FileSshKnownHostsBook.decodeBase64(encoded)
            assertNotNull(decoded)
            assertTrue("Length $len mismatch", original.contentEquals(decoded))
        }
    }

    @Test
    fun `parseHostKey rejects malformed serialized entries`() {
        assertNull(FileSshKnownHostsBook.parseHostKey(""))
        assertNull(FileSshKnownHostsBook.parseHostKey("   "))
        assertNull(FileSshKnownHostsBook.parseHostKey("ssh-rsa"))
        assertNull(FileSshKnownHostsBook.parseHostKey("ssh-rsa invalid!base64"))
        assertNull(FileSshKnownHostsBook.parseHostKey("  AAAAB3NzaC1yc2EA"))

        val valid = FileSshKnownHostsBook.serializeHostKey(KEY_A)
        val parsed = FileSshKnownHostsBook.parseHostKey(valid)
        assertEquals(KEY_A, parsed)
    }

    @Test
    fun `file book keeps host port together instead of splitting on colon`() {
        val file = File(tempDir.newFolder(), "ssh_known_hosts")
        FileSshKnownHostsBook(file).put("103.240.198.233", 22, KEY_ED25519)
        val text = file.readText()
        assertTrue(text.contains("103.240.198.233:22 "))
        assertTrue(text.contains("ssh-ed25519 "))
        assertEquals(KEY_ED25519, FileSshKnownHostsBook(file).find("103.240.198.233", 22))
        assertNull(FileSshKnownHostsBook(file).find("103.240.198.233", 0))
    }

    @Test
    fun `java properties splits an unescaped host port line on colon`() {
        val file = File(tempDir.newFolder(), "legacy.properties")
        file.writeText("103.240.198.233:22=" + FileSshKnownHostsBook.serializeHostKey(KEY_ED25519) + "\n")
        val loaded = java.util.Properties()
        file.inputStream().use { loaded.load(it) }
        assertNull(loaded.getProperty("103.240.198.233:22"))
        assertTrue(loaded.stringPropertyNames().none { it.contains(":22") })
        assertTrue(
            loaded.stringPropertyNames().any { it == "103.240.198.233" || it.startsWith("103.240.198.233") },
        )
    }

    @Test
    fun `properties colon split would lose the port and is rejected`() {
        val parsed = FileSshKnownHostsBook.parseLine("103.240.198.233=ssh-ed25519 AAAA")
        assertNull(parsed)
        val ok = FileSshKnownHostsBook.parseLine(
            "103.240.198.233:22 " + FileSshKnownHostsBook.serializeHostKey(KEY_A),
        )
        assertEquals("103.240.198.233:22", ok?.first)
        assertEquals(KEY_A, ok?.second)
    }
}
