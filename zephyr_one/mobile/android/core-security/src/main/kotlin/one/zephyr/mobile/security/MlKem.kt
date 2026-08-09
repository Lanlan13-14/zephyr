package one.zephyr.mobile.security

/**
 * ML-KEM-768 boundary.
 *
 * The JDK shipped with Android has no ML-KEM implementation, and NATIVE_ENGINE_DECISIONS.md 9
 * routes the primitive through an audited PQ implementation behind the NDK rather than a
 * hand-rolled Kotlin one. This interface is that boundary: the symmetric half of the envelope
 * (HKDF + AES-GCM) is implemented and unit tested here, while key encapsulation is supplied by a
 * provider registered at startup.
 *
 * Nothing in this module fabricates a fallback KEM. A missing provider fails loudly with
 * [MlKemUnavailableException] so a build without the native library cannot silently downgrade to
 * weaker cryptography.
 */
interface MlKemProvider {

    /** Provider name for the security page and diagnostics. */
    val providerName: String

    /** False when the private key is a software key because the device lacks hardware support. */
    val isHardwareBacked: Boolean

    fun generateKeyPair(): MlKemKeyPair

    /** @return the shared secret for [ciphertext], or throws when decapsulation fails. */
    fun decapsulate(privateKey: ByteArray, ciphertext: ByteArray): ByteArray

    /**
     * Only used by tests and by the local re-envelope path; the main end performs encapsulation in
     * production.
     */
    fun encapsulate(publicKey: ByteArray): MlKemEncapsulation
}

/** Raw ML-KEM-768 key pair. The private key is never persisted unwrapped. */
class MlKemKeyPair(val publicKey: ByteArray, val privateKey: ByteArray)

class MlKemEncapsulation(val ciphertext: ByteArray, val sharedSecret: ByteArray)

class MlKemUnavailableException :
    IllegalStateException(
        "ML-KEM-768 provider is not installed; device envelopes cannot be opened without it",
    )

/**
 * Process-wide provider registry.
 *
 * Deliberately not a lazily-constructed default: an unset provider must surface as a blocked
 * capability on the security page, not as a silently different algorithm.
 */
object MlKem {

    const val ALG: String = "ML-KEM-768"
    const val PUBLIC_KEY_BYTES: Int = 1184
    const val PRIVATE_KEY_BYTES: Int = 2400
    const val CIPHERTEXT_BYTES: Int = 1088
    const val SHARED_SECRET_BYTES: Int = 32

    @Volatile
    private var provider: MlKemProvider? = null

    fun install(provider: MlKemProvider) {
        this.provider = provider
    }

    fun installed(): MlKemProvider? = provider

    val isAvailable: Boolean get() = provider != null

    fun require(): MlKemProvider = provider ?: throw MlKemUnavailableException()

    /** Length checks are cheap and catch a mismatched provider before any cipher runs. */
    fun requireCiphertextLength(ciphertext: ByteArray) {
        require(ciphertext.size == CIPHERTEXT_BYTES) {
            "ML-KEM-768 ciphertext must be " + CIPHERTEXT_BYTES + " bytes, got " + ciphertext.size
        }
    }

    fun requirePublicKeyLength(publicKey: ByteArray) {
        require(publicKey.size == PUBLIC_KEY_BYTES) {
            "ML-KEM-768 public key must be " + PUBLIC_KEY_BYTES + " bytes, got " + publicKey.size
        }
    }
}
