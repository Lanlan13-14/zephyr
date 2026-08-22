package one.zephyr.mobile.protocol.ssh

import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Trust must survive the UI host being thrown away. The engine keeps the
 * presented key (and the host/port it was seen on) so "信任并继续" still
 * writes the book when [SshEngine.acceptHostKey] is called with blanks.
 */
class SshjEngineHostKeyTest {

    @get:Rule
    val tempDir = TemporaryFolder()

    @Test
    fun acceptHostKeyUsesThePendingAddressWhenTheCallerForgotIt() {
        val book = MemorySshKnownHostsBook()
        val engine = SshjEngine(Dispatchers.Unconfined, book)
        engine.rememberPendingForTest("s1", "103.240.198.233", 22, KEY_ED25519)

        engine.acceptHostKey("s1", "", 0)

        assertEquals(KEY_ED25519, book.find("103.240.198.233", 22))
        assertNull(book.find("103.240.198.233", 2222))
    }

    @Test
    fun disconnectDoesNotDropAPendingTrustDecision() {
        val book = MemorySshKnownHostsBook()
        val engine = SshjEngine(Dispatchers.Unconfined, book)
        engine.rememberPendingForTest("s1", "10.0.0.5", 22, KEY_A)
        runBlocking { engine.disconnect("s1") }

        engine.acceptHostKey("s1", "", 0)

        assertEquals(KEY_A, book.find("10.0.0.5", 22))
    }

    @Test
    fun acceptHostKeyIsANoOpWithoutAPendingKey() {
        val book = MemorySshKnownHostsBook()
        val engine = SshjEngine(Dispatchers.Unconfined, book)

        engine.acceptHostKey("missing", "10.0.0.5", 22)

        assertNull(book.find("10.0.0.5", 22))
    }

    @Test
    fun acceptedKeySurvivesANewEngineReadingTheSameFile() {
        val file = File(tempDir.newFolder(), SshjEngine.TRUST_FILE_NAME)
        val engine = SshjEngine(Dispatchers.Unconfined, FileSshKnownHostsBook(file))
        engine.rememberPendingForTest("s1", "192.168.1.10", 22, KEY_A)

        engine.acceptHostKey("s1", "192.168.1.10", 22)

        val reloaded = FileSshKnownHostsBook(file)
        assertEquals(KEY_A, reloaded.find("192.168.1.10", 22))
        assertTrue(file.readText().contains("192.168.1.10:22 "))
    }

    @Test
    fun replacingAChangedKeyOverwritesTheFile() {
        val file = File(tempDir.newFolder(), SshjEngine.TRUST_FILE_NAME)
        val engine = SshjEngine(Dispatchers.Unconfined, FileSshKnownHostsBook(file))
        engine.rememberPendingForTest("s1", "host-1", 22, KEY_A)
        engine.acceptHostKey("s1", "host-1", 22)
        engine.rememberPendingForTest("s1", "host-1", 22, KEY_B)
        engine.acceptHostKey("s1", "host-1", 22)

        assertEquals(KEY_B, FileSshKnownHostsBook(file).find("host-1", 22))
    }

    @Test
    fun acceptHostKeyWritesTheExplicitKeyWhenPendingIsGone() {
        val book = MemorySshKnownHostsBook()
        val engine = SshjEngine(Dispatchers.Unconfined, book)

        engine.acceptHostKey("s1", "103.240.198.233", 22, KEY_ED25519)

        assertEquals(KEY_ED25519, book.find("103.240.198.233", 22))
    }
}
