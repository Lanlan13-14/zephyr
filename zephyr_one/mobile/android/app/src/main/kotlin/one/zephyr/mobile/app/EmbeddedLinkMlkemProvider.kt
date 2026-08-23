package one.zephyr.mobile.app

import kotlinx.coroutines.runBlocking
import one.zephyr.mobile.model.Base64Codec
import one.zephyr.mobile.security.MlKem
import one.zephyr.mobile.security.MlKemEncapsulation
import one.zephyr.mobile.security.MlKemKeyPair
import one.zephyr.mobile.security.MlKemProvider

/**
 * ML-KEM-768 provider backed by the embedded Go Link core's loopback routes.
 *
 * The Kotlin side never implements the primitive; it only shuttles base64 blobs
 * between [MlKem] and the Go core's `/link/mlkem/{generate,encapsulate,decapsulate}`
 * endpoints.
 */
class EmbeddedLinkMlkemProvider(
    private val api: EmbeddedLinkApi,
) : MlKemProvider {

    override val providerName: String = "zephyr-link-go-loopback"

    /** The Go core is in-process; it is not hardware-backed in the Android Keystore sense. */
    override val isHardwareBacked: Boolean = false

    override fun generateKeyPair(): MlKemKeyPair {
        val keypair = runBlocking { api.mlkemGenerate() }
        val publicKey = Base64Codec.decodeUrlNoPad(keypair.publicKey)
        val privateKey = Base64Codec.decodeUrlNoPad(keypair.seed)
        MlKem.requirePublicKeyLength(publicKey)
        return MlKemKeyPair(publicKey = publicKey, privateKey = privateKey)
    }

    override fun decapsulate(privateKey: ByteArray, ciphertext: ByteArray): ByteArray {
        MlKem.requireCiphertextLength(ciphertext)
        val seedB64 = Base64Codec.encodeUrlNoPad(privateKey)
        val ctB64 = Base64Codec.encodeUrlNoPad(ciphertext)
        val sharedB64 = runBlocking { api.mlkemDecapsulate(seed = seedB64, ciphertext = ctB64) }
        return Base64Codec.decodeUrlNoPad(sharedB64)
    }

    override fun encapsulate(publicKey: ByteArray): MlKemEncapsulation {
        MlKem.requirePublicKeyLength(publicKey)
        val pubB64 = Base64Codec.encodeUrlNoPad(publicKey)
        val encapsulation = runBlocking { api.mlkemEncapsulate(publicKey = pubB64) }
        val ciphertext = Base64Codec.decodeUrlNoPad(encapsulation.ciphertext)
        val shared = Base64Codec.decodeUrlNoPad(encapsulation.shared)
        MlKem.requireCiphertextLength(ciphertext)
        return MlKemEncapsulation(ciphertext = ciphertext, sharedSecret = shared)
    }
}

/** Install the loopback-backed ML-KEM provider. Call once at process start. */
fun installEmbeddedLinkMlkem(api: EmbeddedLinkApi) {
    MlKem.install(EmbeddedLinkMlkemProvider(api))
}
