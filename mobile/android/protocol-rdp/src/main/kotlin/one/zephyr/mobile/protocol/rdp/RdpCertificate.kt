package one.zephyr.mobile.protocol.rdp

import java.security.MessageDigest

/**
 * A server certificate as presented during TLS/NLA.
 *
 * Held as the DER bytes plus the parsed display fields: the fingerprint must be computed from the
 * bytes rather than trusted from the server, and the display fields exist only so the user has
 * something meaningful to decide on.
 */
data class RdpCertificate(
    val subject: String,
    val issuer: String,
    val notBefore: Long,
    val notAfter: Long,
    val der: ByteArray,
) {
    /** Uppercase colon-separated SHA-256, the form every other tool shows. */
    val sha256Fingerprint: String by lazy {
        MessageDigest.getInstance("SHA-256").digest(der)
            .joinToString(":") { byte -> "%02X".format(byte.toInt() and 0xFF) }
    }

    fun isExpiredAt(now: Long): Boolean = notAfter in 1 until now

    fun isNotYetValidAt(now: Long): Boolean = notBefore > 0L && now < notBefore

    override fun equals(other: Any?): Boolean = other is RdpCertificate && der.contentEquals(other.der)

    override fun hashCode(): Int = der.contentHashCode()
}

/**
 * Where trusted RDP certificates live.
 *
 * ADR-004 and DEVELOPMENT.md 14.3 require a store *separate* from the system CA set and from the
 * SSH host-key store: an RDP server is usually self-signed, so accepting one must not widen trust
 * for HTTPS, and an operator revoking an RDP certificate must not have to touch SSH trust.
 */
interface RdpTrustStore {
    suspend fun find(host: String, port: Int): RdpCertificate?
    suspend fun trust(host: String, port: Int, certificate: RdpCertificate)
    suspend fun forget(host: String, port: Int)
}

/** What the UI must do about a presented certificate. */
sealed interface RdpCertificateVerdict {

    /** Byte-identical to the stored one: connect silently. */
    data object Trusted : RdpCertificateVerdict

    /** Never seen before. The user sees subject, issuer, validity and fingerprint. */
    data class FirstContact(val review: RdpCertificateReview) : RdpCertificateVerdict

    /**
     * Changed since it was trusted.
     *
     * DEVELOPMENT.md 14.3 requires this to block by default. Both fingerprints are surfaced so the
     * user can compare, and accepting is an explicit replace rather than an implicit overwrite.
     */
    data class Changed(val review: RdpCertificateReview, val storedFingerprint: String) : RdpCertificateVerdict

    /** Structurally unusable regardless of trust: expired or not yet valid. */
    data class Invalid(val review: RdpCertificateReview, val reason: String) : RdpCertificateVerdict
}

/** Everything the user needs to decide, and nothing else. */
data class RdpCertificateReview(
    val host: String,
    val port: Int,
    val subject: String,
    val issuer: String,
    val notBefore: Long,
    val notAfter: Long,
    val sha256Fingerprint: String,
)

class RdpCertificateTrust(private val store: RdpTrustStore) {

    /**
     * Classifies a presented certificate.
     *
     * Validity is checked before stored trust so an expired certificate is reported as expired even
     * if it was trusted earlier: silently accepting a stale certificate because it was once approved
     * defeats the expiry date.
     */
    suspend fun evaluate(host: String, port: Int, presented: RdpCertificate, now: Long): RdpCertificateVerdict {
        val review = review(host, port, presented)
        if (presented.isExpiredAt(now)) return RdpCertificateVerdict.Invalid(review, "expired")
        if (presented.isNotYetValidAt(now)) return RdpCertificateVerdict.Invalid(review, "not_yet_valid")

        val stored = store.find(host, port) ?: return RdpCertificateVerdict.FirstContact(review)
        if (stored == presented) return RdpCertificateVerdict.Trusted
        return RdpCertificateVerdict.Changed(review, stored.sha256Fingerprint)
    }

    suspend fun accept(host: String, port: Int, certificate: RdpCertificate) = store.trust(host, port, certificate)

    /** Replaces a changed certificate. Separate from [accept] so the UI cannot conflate the two. */
    suspend fun replace(host: String, port: Int, certificate: RdpCertificate) {
        store.forget(host, port)
        store.trust(host, port, certificate)
    }

    private fun review(host: String, port: Int, certificate: RdpCertificate) = RdpCertificateReview(
        host = host,
        port = port,
        subject = certificate.subject,
        issuer = certificate.issuer,
        notBefore = certificate.notBefore,
        notAfter = certificate.notAfter,
        sha256Fingerprint = certificate.sha256Fingerprint,
    )
}
