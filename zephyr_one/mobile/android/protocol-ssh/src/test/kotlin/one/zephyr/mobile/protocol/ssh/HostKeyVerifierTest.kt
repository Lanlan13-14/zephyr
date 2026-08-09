package one.zephyr.mobile.protocol.ssh

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Host-key trust, which is the check that stands between a session and a man in the middle.
 *
 * Asserted through a recording store rather than only on return values, because the dangerous bug is
 * not a wrong verdict but a right verdict with a side effect: a verify() that quietly remembers the
 * key it just saw turns every prompt into a rubber stamp.
 */
class HostKeyVerifierTest {

    private val scope = HostKeyScope(serverProfileId = "profile-1", host = "10.0.0.5", port = 22)

    @Test
    fun `an unseen key asks the user and stores nothing`() = runTest {
        val store = RecordingHostKeyStore()
        val verdict = HostKeyVerifier(store).verify(scope, KEY_A, HostKeyPolicy.PROMPT_UNKNOWN_BLOCK_CHANGED)

        val unknown = verdict as HostKeyVerdict.UnknownNeedsConfirmation
        assertEquals(KEY_A, unknown.presented)
        assertEquals("SHA256:iDWpTXEhiqEJqkOpGjNCweV7ECfbgHSa4OLMIzPUBMc", unknown.presented.sha256Fingerprint)
        // Only a lookup happened. Trust is written by an explicit user action, never by checking.
        assertEquals(listOf("find:profile-1|10.0.0.5|22"), store.calls)
        assertEquals(0, store.storedCount)
    }

    @Test
    fun `a key that matches the stored one is trusted silently`() = runTest {
        val store = RecordingHostKeyStore()
        store.seed(scope, KEY_A)

        // A fresh instance with the same bytes: trust must be by value, not by reference.
        val presented = HostKey(KEY_A.algorithm, KEY_A.blob.copyOf())
        val verdict = HostKeyVerifier(store).verify(scope, presented, HostKeyPolicy.PROMPT_UNKNOWN_BLOCK_CHANGED)

        assertEquals(HostKeyVerdict.Trusted, verdict)
    }

    @Test
    fun `a changed key is blocked and both fingerprints are surfaced`() = runTest {
        val store = RecordingHostKeyStore()
        store.seed(scope, KEY_A)

        val verdict = HostKeyVerifier(store).verify(scope, KEY_B, HostKeyPolicy.PROMPT_UNKNOWN_BLOCK_CHANGED)

        // DEVELOPMENT.md 14.1: blocked by default, not dismissible with a toast.
        val changed = verdict as HostKeyVerdict.ChangedBlocked
        assertEquals(KEY_B, changed.presented)
        assertEquals(KEY_A, changed.known)
        assertEquals("SHA256:hRTKciqyjbodMLx8ZT6GtJwIOv1QBT7PgX6V+0KPfS0", changed.presented.sha256Fingerprint)
        assertEquals("SHA256:iDWpTXEhiqEJqkOpGjNCweV7ECfbgHSa4OLMIzPUBMc", changed.known.sha256Fingerprint)
        // The old key is still the trusted one: being shown a new key does not replace anything.
        assertEquals(KEY_A, store.find(scope))
    }

    @Test
    fun `a changed algorithm for the same host is still a change`() = runTest {
        val store = RecordingHostKeyStore()
        store.seed(scope, KEY_A)

        val verdict = HostKeyVerifier(store).verify(scope, KEY_ED25519, HostKeyPolicy.PROMPT_UNKNOWN_BLOCK_CHANGED)

        assertTrue(verdict is HostKeyVerdict.ChangedBlocked)
    }

    @Test
    fun `the insecure policy short circuits without consulting the store`() = runTest {
        val store = RecordingHostKeyStore()
        val verdict = HostKeyVerifier(store).verify(scope, KEY_A, HostKeyPolicy.INSECURE_ACCEPT_ANY)

        assertEquals(HostKeyVerdict.Trusted, verdict)
        // Not selectable from the UI; it exists so an integration test can dial a throwaway
        // container. It must not leave a trusted key behind that a later real check would accept.
        assertTrue(store.calls.isEmpty())
        assertEquals(0, store.storedCount)
    }

    @Test
    fun `accepting a key is a separate explicit step`() = runTest {
        val store = RecordingHostKeyStore()
        val verifier = HostKeyVerifier(store)

        verifier.verify(scope, KEY_A, HostKeyPolicy.PROMPT_UNKNOWN_BLOCK_CHANGED)
        verifier.acceptAndRemember(scope, KEY_A)

        assertEquals(HostKeyVerdict.Trusted, verifier.verify(scope, KEY_A, HostKeyPolicy.PROMPT_UNKNOWN_BLOCK_CHANGED))
        assertEquals(listOf("find:profile-1|10.0.0.5|22", "trust:profile-1|10.0.0.5|22", "find:profile-1|10.0.0.5|22"), store.calls)
    }

    @Test
    fun `re-trusting a changed key drops the old one first`() = runTest {
        val store = RecordingHostKeyStore()
        store.seed(scope, KEY_A)

        HostKeyVerifier(store).replaceTrust(scope, KEY_B)

        // forget-then-trust, so a store keyed by algorithm cannot end up holding both keys and
        // silently accepting the old one again.
        assertEquals(listOf("forget:profile-1|10.0.0.5|22", "trust:profile-1|10.0.0.5|22"), store.calls)
        assertEquals(KEY_B, store.find(scope))
        assertEquals(1, store.storedCount)
    }

    @Test
    fun `trust is scoped to server profile host and port`() {
        assertEquals("profile-1|10.0.0.5|22", scope.storageKey)
        // Case-insensitive host: SSH.Example.COM and ssh.example.com are the same host, and asking
        // twice would train the user to accept prompts.
        assertEquals(
            "profile-1|ssh.example.com|22",
            HostKeyScope("profile-1", "SSH.Example.COM", 22).storageKey,
        )
        assertNotEquals(scope.storageKey, HostKeyScope("profile-1", "10.0.0.5", 2222).storageKey)
        assertNotEquals(scope.storageKey, HostKeyScope("profile-2", "10.0.0.5", 22).storageKey)
    }

    @Test
    fun `a key trusted on one port is unknown on another`() = runTest {
        val store = RecordingHostKeyStore()
        store.seed(scope, KEY_A)
        val other = HostKeyScope("profile-1", "10.0.0.5", 2222)

        val verdict = HostKeyVerifier(store).verify(other, KEY_A, HostKeyPolicy.PROMPT_UNKNOWN_BLOCK_CHANGED)

        assertTrue(verdict is HostKeyVerdict.UnknownNeedsConfirmation)
    }

    @Test
    fun `the fingerprint is the OpenSSH sha256 form`() {
        // Matches what ssh-keygen -l prints, which is the only reason a user can compare it.
        val fingerprint = KEY_A.sha256Fingerprint
        assertTrue(fingerprint.startsWith("SHA256:"))
        // Unpadded base64 of a 32-byte digest.
        assertEquals(43, fingerprint.removePrefix("SHA256:").length)
        assertFalse(fingerprint.contains("="))
        assertEquals("SHA256:MJREf965RrbJMSMrBnIvJ4+4axoyxOCHMI5qaJE7vDY", KEY_ED25519.sha256Fingerprint)
    }

    @Test
    fun `host keys compare by content and never print key material`() {
        assertEquals(KEY_A, HostKey("ssh-rsa", KEY_A.blob.copyOf()))
        assertEquals(KEY_A.hashCode(), HostKey("ssh-rsa", KEY_A.blob.copyOf()).hashCode())
        assertNotEquals(KEY_A, KEY_B)
        // Same bytes under a different algorithm name is a different key.
        assertNotEquals(KEY_A, HostKey("ssh-dss", KEY_A.blob.copyOf()))

        val printed = KEY_A.toString()
        assertEquals("ssh-rsa SHA256:iDWpTXEhiqEJqkOpGjNCweV7ECfbgHSa4OLMIzPUBMc", printed)
        assertFalse("a log line must not carry the blob", printed.contains("[B@"))
    }
}
