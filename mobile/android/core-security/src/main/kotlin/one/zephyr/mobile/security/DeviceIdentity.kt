package one.zephyr.mobile.security

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import one.zephyr.mobile.model.Base64Codec
import one.zephyr.mobile.model.SecretRef

/**
 * The two device keys from DATA_AND_MIGRATION.md 5.3 / 5.6.
 *
 *  - encryption: ML-KEM-768. Android has no Keystore slot for it, so the private key is generated
 *    by the installed [MlKemProvider] and immediately sealed with a non-exportable Keystore
 *    AES-GCM wrapping key. It is unwrapped only for the duration of a decapsulation.
 *  - signing: ES256, generated directly inside AndroidKeyStore and never exportable. It proves
 *    request origin for the data plane.
 *
 * Neither key is portable. A backup restore or a rebind to a different account must mint new keys,
 * which is why [wipe] exists and why the wrapped blob is scoped to the binding.
 */
class DeviceIdentity(
    private val blobs: SecretBlobStore,
    private val scope: Scope,
    private val wrapAlias: String = KeystoreMasterKey.ALIAS_DEVICE_KEY_WRAP,
    private val signingAlias: String = ALIAS_SIGNING,
) {

    data class Scope(val serverId: String, val deviceId: String)

    /** What the bind request sends. Public material only. */
    data class PublicKeys(
        val encryptionAlg: String,
        val encryptionPublicKeyBase64: String,
        val signingAlg: String,
        val signingJwk: Map<String, String>,
    )

    /** Surfaced on the security page so a software-key device is honest about it. */
    data class Attestation(
        val mlKemProvider: String?,
        val mlKemHardwareBacked: Boolean,
        val signingHardwareBacked: Boolean,
    )

    /**
     * Generates both keys if absent and returns the public half.
     *
     * Idempotent: an interrupted bind can call this again without rotating a key that the server
     * may already have recorded.
     */
    fun ensureKeys(): PublicKeys {
        val kem = MlKem.require()
        if (blobs.read(refPrivate) == null || blobs.read(refPublic) == null) {
            val pair = kem.generateKeyPair()
            MlKem.requirePublicKeyLength(pair.publicKey)
            val wrapKey = KeystoreMasterKey.getOrCreate(wrapAlias)
            try {
                blobs.write(refPrivate, KeystoreMasterKey.seal(wrapKey, pair.privateKey, aad("mlkem-private")))
                blobs.write(refPublic, pair.publicKey)
            } finally {
                pair.privateKey.fill(0)
            }
        }
        return PublicKeys(
            encryptionAlg = MlKem.ALG,
            encryptionPublicKeyBase64 = Base64Codec.encode(encryptionPublicKey()),
            signingAlg = SIGNING_ALG,
            signingJwk = signingJwk(),
        )
    }

    fun hasKeys(): Boolean = blobs.read(refPublic) != null && keyStore().containsAlias(signingAlias)

    fun encryptionPublicKey(): ByteArray =
        blobs.read(refPublic) ?: error("device encryption key is missing; rebind is required")

    /**
     * Runs [block] with the unwrapped ML-KEM private key and zeroes it afterwards, so the key is
     * never left in a long-lived field.
     */
    fun <T> withPrivateKey(block: (ByteArray) -> T): T {
        val blob = blobs.read(refPrivate) ?: error("device encryption key is missing; rebind is required")
        val wrapKey = KeystoreMasterKey.getOrCreate(wrapAlias)
        val privateKey = KeystoreMasterKey.open(wrapKey, blob, aad("mlkem-private"))
        return try {
            block(privateKey)
        } finally {
            privateKey.fill(0)
        }
    }

    /**
     * ES256 device proof over method, path, body hash, timestamp and server nonce
     * (openapi-mobile-v1.json security scheme DeviceProof).
     *
     * The signed string is NUL-joined for the same reason the envelope AAD is: no field can be
     * shifted into its neighbour to forge a different request.
     */
    fun signRequestProof(
        method: String,
        path: String,
        body: ByteArray,
        timestampSeconds: Long,
        serverNonce: String,
    ): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(body)
        val signed = buildString {
            append(PROOF_PREFIX).append('\u0000')
            append(scope.deviceId).append('\u0000')
            append(method.uppercase()).append('\u0000')
            append(path).append('\u0000')
            append(Base64Codec.encode(digest)).append('\u0000')
            append(timestampSeconds).append('\u0000')
            append(serverNonce)
        }.toByteArray(Charsets.UTF_8)

        val entry = keyStore().getEntry(signingAlias, null) as? KeyStore.PrivateKeyEntry
            ?: error("device signing key is missing; rebind is required")
        val signature = Signature.getInstance("SHA256withECDSA").apply {
            initSign(entry.privateKey)
            update(signed)
        }.sign()
        return Base64Codec.encode(signature)
    }

    fun attestation(): Attestation {
        val provider = MlKem.installed()
        return Attestation(
            mlKemProvider = provider?.providerName,
            mlKemHardwareBacked = provider?.isHardwareBacked ?: false,
            signingHardwareBacked = isSigningHardwareBacked(),
        )
    }

    /** Unbind, device revoke or instance epoch change: identity must not survive. */
    fun wipe() {
        blobs.delete(refPrivate)
        blobs.delete(refPublic)
        val store = keyStore()
        if (store.containsAlias(signingAlias)) store.deleteEntry(signingAlias)
        KeystoreMasterKey.delete(wrapAlias)
    }

    private fun signingJwk(): Map<String, String> {
        ensureSigningKey()
        val certificate = keyStore().getCertificate(signingAlias)
            ?: error("device signing key is missing; rebind is required")
        val publicKey = certificate.publicKey as ECPublicKey
        val fieldBytes = (publicKey.params.curve.field.fieldSize + 7) / 8
        return mapOf(
            "kty" to "EC",
            "crv" to "P-256",
            "x" to base64Url(publicKey.w.affineX.toByteArray(), fieldBytes),
            "y" to base64Url(publicKey.w.affineY.toByteArray(), fieldBytes),
        )
    }

    private fun ensureSigningKey() {
        val store = keyStore()
        if (store.containsAlias(signingAlias)) return
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER)
        val builder = KeyGenParameterSpec.Builder(signingAlias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // Background sync must still be able to prove requests, so this key is not
            // user-authentication bound; the device-locked constraint is the protection.
            builder.setUnlockedDeviceRequired(true)
            builder.setIsStrongBoxBacked(true)
        }
        try {
            generator.initialize(builder.build())
            generator.generateKeyPair()
        } catch (strongBoxUnavailable: java.security.ProviderException) {
            val fallback = KeyGenParameterSpec.Builder(signingAlias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .apply {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setUnlockedDeviceRequired(true)
                }
                .build()
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER).run {
                initialize(fallback)
                generateKeyPair()
            }
        }
    }

    private fun isSigningHardwareBacked(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        val entry = keyStore().getEntry(signingAlias, null) as? KeyStore.PrivateKeyEntry ?: return false
        return runCatching {
            val factory = java.security.KeyFactory.getInstance(entry.privateKey.algorithm, PROVIDER)
            val info = factory.getKeySpec(entry.privateKey, android.security.keystore.KeyInfo::class.java)
            info.securityLevel != android.security.keystore.KeyProperties.SECURITY_LEVEL_SOFTWARE
        }.getOrDefault(false)
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

    private fun aad(purpose: String): ByteArray =
        (AAD_PREFIX + "\u0000" + scope.serverId + "\u0000" + scope.deviceId + "\u0000" + purpose)
            .toByteArray(Charsets.UTF_8)

    /**
     * JWK coordinates are fixed-width and unsigned; BigInteger.toByteArray may add a sign byte or
     * drop leading zeros, either of which produces a key the server cannot verify.
     */
    private fun base64Url(raw: ByteArray, width: Int): String {
        val trimmed = if (raw.size > width) raw.copyOfRange(raw.size - width, raw.size) else raw
        val padded = ByteArray(width)
        trimmed.copyInto(padded, width - trimmed.size)
        return Base64Codec.encodeUrlNoPad(padded)
    }

    private val refPrivate: SecretRef get() = SecretRef.of(RESERVED_ENTITY, scope.deviceId, "mlkemPrivateKey")
    private val refPublic: SecretRef get() = SecretRef.of(RESERVED_ENTITY, scope.deviceId, "mlkemPublicKey")

    companion object {
        const val ALIAS_SIGNING: String = "zephyr.one.device.es256.v1"
        const val SIGNING_ALG: String = "ES256"
        private const val PROVIDER = "AndroidKeyStore"
        private const val RESERVED_ENTITY = "__deviceIdentity"
        private const val AAD_PREFIX = "zephyr-one-device-identity-v1"
        private const val PROOF_PREFIX = "zephyr-one-device-proof-v1"
    }
}
