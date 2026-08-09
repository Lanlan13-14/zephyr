package one.zephyr.mobile.protocol.rdp

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** An in-memory trust store that records the order of what it was asked to do. */
private class RecordingTrustStore : RdpTrustStore {

    private val certificates = mutableMapOf<String, RdpCertificate>()
    val calls = mutableListOf<String>()

    override suspend fun find(host: String, port: Int): RdpCertificate? {
        calls += "find"
        return certificates[key(host, port)]
    }

    override suspend fun trust(host: String, port: Int, certificate: RdpCertificate) {
        calls += "trust"
        certificates[key(host, port)] = certificate
    }

    override suspend fun forget(host: String, port: Int) {
        calls += "forget"
        certificates.remove(key(host, port))
    }

    fun seed(host: String, port: Int, certificate: RdpCertificate) {
        certificates[key(host, port)] = certificate
    }

    val size: Int get() = certificates.size

    private fun key(host: String, port: Int) = host + ":" + port
}

class RdpCertificateTest {

    private val now = 1_700_000_000_000

    private fun certificate(
        subject: String = "CN=win-lab",
        issuer: String = "CN=win-lab",
        notBefore: Long = 1_600_000_000_000,
        notAfter: Long = 1_800_000_000_000,
        der: ByteArray = byteArrayOf(48, -126, 1, 10, -34, -83, -66, -17),
    ) = RdpCertificate(subject, issuer, notBefore, notAfter, der)

    private val otherDer = byteArrayOf(48, -126, 1, 10, -2, -19, -6, -50)

    @Test
    fun `the fingerprint is uppercase colon separated SHA-256 of the DER bytes`() {
        assertEquals(
            "F1:56:E9:85:E8:EA:B5:6C:A7:CF:88:29:DF:36:38:BA:17:68:32:BF:82:94:E5:F3:9D:A9:CB:D0:35:65:58:01",
            certificate().sha256Fingerprint,
        )
        assertEquals(
            "7C:29:DA:59:0F:CB:A2:91:44:9D:9C:F3:04:4C:C0:07:B1:AC:75:F6:25:FC:40:9F:C9:9C:5C:69:98:3B:9D:8B",
            certificate(der = otherDer).sha256Fingerprint,
        )
    }

    @Test
    fun `identity is the DER bytes and not the display fields`() {
        // A server that re-issues the same key with a prettier subject has not changed identity, and
        // prompting again would train the user to accept blindly.
        assertEquals(certificate(subject = "CN=a"), certificate(subject = "CN=b"))
        assertEquals(certificate(subject = "CN=a").hashCode(), certificate(subject = "CN=b").hashCode())
        assertFalse(certificate() == certificate(der = otherDer))
    }

    @Test
    fun `validity windows are read from the certificate`() {
        assertFalse(certificate().isExpiredAt(now))
        assertTrue(certificate(notAfter = now - 1).isExpiredAt(now))
        assertFalse(certificate(notBefore = now - 1).isNotYetValidAt(now))
        assertTrue(certificate(notBefore = now + 1).isNotYetValidAt(now))
    }

    @Test
    fun `an absent validity field is not treated as expired`() {
        // Zero means the field was unavailable, and reporting that as expired would block every
        // connection to a server whose certificate could not be fully parsed.
        assertFalse(certificate(notAfter = 0).isExpiredAt(now))
        assertFalse(certificate(notBefore = 0).isNotYetValidAt(now))
    }

    @Test
    fun `a certificate never seen before needs a first contact decision`() = runTest {
        val store = RecordingTrustStore()
        val trust = RdpCertificateTrust(store)

        val verdict = trust.evaluate("win-lab", 3389, certificate(), now)

        val first = verdict as RdpCertificateVerdict.FirstContact
        assertEquals("win-lab", first.review.host)
        assertEquals(3389, first.review.port)
        assertEquals("CN=win-lab", first.review.subject)
        assertEquals(certificate().sha256Fingerprint, first.review.sha256Fingerprint)
        // Evaluating must never write trust as a side effect.
        assertEquals(0, store.size)
    }

    @Test
    fun `a byte identical certificate is trusted silently`() = runTest {
        val store = RecordingTrustStore()
        store.seed("win-lab", 3389, certificate())

        val verdict = RdpCertificateTrust(store).evaluate("win-lab", 3389, certificate(), now)

        assertTrue(verdict is RdpCertificateVerdict.Trusted)
    }

    @Test
    fun `a changed certificate blocks and surfaces both fingerprints`() = runTest {
        val store = RecordingTrustStore()
        store.seed("win-lab", 3389, certificate())

        val verdict = RdpCertificateTrust(store)
            .evaluate("win-lab", 3389, certificate(der = otherDer), now)

        val changed = verdict as RdpCertificateVerdict.Changed
        assertEquals(certificate(der = otherDer).sha256Fingerprint, changed.review.sha256Fingerprint)
        assertEquals(certificate().sha256Fingerprint, changed.storedFingerprint)
    }

    @Test
    fun `an expired certificate is invalid even when it was trusted earlier`() = runTest {
        val expired = certificate(notAfter = now - 1)
        val store = RecordingTrustStore()
        store.seed("win-lab", 3389, expired)

        val verdict = RdpCertificateTrust(store).evaluate("win-lab", 3389, expired, now)

        // Validity is checked before stored trust: accepting a stale certificate because it was
        // once approved defeats the expiry date.
        assertEquals("expired", (verdict as RdpCertificateVerdict.Invalid).reason)
    }

    @Test
    fun `a not yet valid certificate is invalid`() = runTest {
        val verdict = RdpCertificateTrust(RecordingTrustStore())
            .evaluate("win-lab", 3389, certificate(notBefore = now + 60_000), now)

        assertEquals("not_yet_valid", (verdict as RdpCertificateVerdict.Invalid).reason)
    }

    @Test
    fun `trust is scoped to host and port`() = runTest {
        val store = RecordingTrustStore()
        store.seed("win-lab", 3389, certificate())
        val trust = RdpCertificateTrust(store)

        assertTrue(trust.evaluate("win-lab", 3389, certificate(), now) is RdpCertificateVerdict.Trusted)
        // A different port is a different service and must be decided on its own.
        assertTrue(
            trust.evaluate("win-lab", 3390, certificate(), now) is RdpCertificateVerdict.FirstContact,
        )
        assertTrue(
            trust.evaluate("other-host", 3389, certificate(), now) is RdpCertificateVerdict.FirstContact,
        )
    }

    @Test
    fun `accepting stores the certificate`() = runTest {
        val store = RecordingTrustStore()
        val trust = RdpCertificateTrust(store)

        trust.accept("win-lab", 3389, certificate())

        assertEquals(listOf("trust"), store.calls)
        assertTrue(trust.evaluate("win-lab", 3389, certificate(), now) is RdpCertificateVerdict.Trusted)
    }

    @Test
    fun `replacing forgets the old certificate before storing the new one`() = runTest {
        val store = RecordingTrustStore()
        store.seed("win-lab", 3389, certificate())
        val trust = RdpCertificateTrust(store)

        trust.replace("win-lab", 3389, certificate(der = otherDer))

        // Order matters: a store keyed on more than host/port could otherwise keep both.
        assertEquals(listOf("forget", "trust"), store.calls)
        assertEquals(1, store.size)
        val verdict = trust.evaluate("win-lab", 3389, certificate(der = otherDer), now)
        assertTrue(verdict is RdpCertificateVerdict.Trusted)
    }
}
