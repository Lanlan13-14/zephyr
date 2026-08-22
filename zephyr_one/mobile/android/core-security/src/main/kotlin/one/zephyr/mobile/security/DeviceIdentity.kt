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
    private val wrapAlias: String = deviceIdentityAlias(KeystoreMasterKey.ALIAS_DEVICE_KEY_WRAP, scope),
    private val signingAlias: String = deviceIdentityAlias(ALIAS_SIGNING, scope),
) {

    data class Scope(val serverId: String, val userId: String, val deviceId: String)

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
        if (blobs.readMigratingLegacyRef(refPrivate) == null || blobs.readMigratingLegacyRef(refPublic) == null) {
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

    fun hasKeys(): Boolean =
        blobs.readMigratingLegacyRef(refPrivate) != null &&
            blobs.readMigratingLegacyRef(refPublic) != null &&
            signingEntry() != null

    fun encryptionPublicKey(): ByteArray =
        blobs.readMigratingLegacyRef(refPublic)
            ?: error("device encryption key is missing; rebind is required")

    /**
     * Runs [block] with the unwrapped ML-KEM private key and zeroes it afterwards, so the key is
     * never left in a long-lived field.
     */
    fun <T> withPrivateKey(block: (ByteArray) -> T): T {
        val blob = blobs.readMigratingLegacyRef(refPrivate)
            ?: error("device encryption key is missing; rebind is required")
        val privateKey = openPrivateKey(blob)
        return try {
            block(privateKey)
        } finally {
            privateKey.fill(0)
        }
    }

    /**
     * Signs arbitrary enrollment/bind proof bytes with the device ES256 key.
     * Returns standard Base64 P1363, matching `mobile-v1-proof.js`.
     */
    fun signPayload(payload: ByteArray): String {
        val entry = signingEntry()
            ?: error("device signing key is missing; rebind is required")
        val der = Signature.getInstance("SHA256withECDSA").apply {
            initSign(entry.privateKey)
            update(payload)
        }.sign()
        return Base64Codec.encode(derEcdsaToP1363(der))
    }

    /**
     * Signs the challenge-bound v2 proof used by data-plane transports such as sync wake SSE.
     *
     * AndroidKeyStore emits ASN.1 DER ECDSA signatures. The mobile-v1 contract deliberately uses
     * fixed-width IEEE P1363, so conversion happens before the signature crosses the wire.
     */
    fun signChallengeProof(
        method: String,
        canonicalPath: String,
        bodySha256: String,
        usage: String,
        timestampSeconds: Long,
        serverNonce: String,
    ): String {
        val signed = buildString {
            append(PROOF_V2_PREFIX).append('\u0000')
            append(scope.deviceId).append('\u0000')
            append(method.uppercase()).append('\u0000')
            append(canonicalPath).append('\u0000')
            append(bodySha256).append('\u0000')
            append(usage).append('\u0000')
            append(timestampSeconds).append('\u0000')
            append(serverNonce)
        }.toByteArray(Charsets.UTF_8)

        val entry = signingEntry()
            ?: error("device signing key is missing; rebind is required")
        val der = Signature.getInstance("SHA256withECDSA").apply {
            initSign(entry.privateKey)
            update(signed)
        }.sign()
        return Base64Codec.encode(derEcdsaToP1363(der))
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
        blobs.deleteCurrentAndLegacyRef(refPrivate)
        blobs.deleteCurrentAndLegacyRef(refPublic)
        val store = keyStore()
        if (store.containsAlias(signingAlias)) store.deleteEntry(signingAlias)
        val legacySigning = deviceIdentityLegacyAlias(ALIAS_SIGNING, scope)
        if (store.containsAlias(legacySigning)) store.deleteEntry(legacySigning)
        KeystoreMasterKey.delete(wrapAlias)
        KeystoreMasterKey.delete(deviceIdentityLegacyAlias(KeystoreMasterKey.ALIAS_DEVICE_KEY_WRAP, scope))
    }

    private fun signingJwk(): Map<String, String> {
        ensureSigningKey()
        val certificate = keyStore().getCertificate(signingAlias)
            ?: keyStore().getCertificate(deviceIdentityLegacyAlias(ALIAS_SIGNING, scope))
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
        if (store.containsAlias(signingAlias)
            || store.containsAlias(deviceIdentityLegacyAlias(ALIAS_SIGNING, scope))
        ) return
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

    private fun signingEntry(): KeyStore.PrivateKeyEntry? {
        val store = keyStore()
        (store.getEntry(signingAlias, null) as? KeyStore.PrivateKeyEntry)?.let { return it }
        return store.getEntry(deviceIdentityLegacyAlias(ALIAS_SIGNING, scope), null)
            as? KeyStore.PrivateKeyEntry
    }

    private fun openPrivateKey(blob: ByteArray): ByteArray {
        val attempts = listOf(
            wrapAlias to aad("mlkem-private"),
            wrapAlias to legacyAad("mlkem-private"),
            deviceIdentityLegacyAlias(KeystoreMasterKey.ALIAS_DEVICE_KEY_WRAP, scope)
                to legacyAad("mlkem-private"),
        )
        var last: Exception? = null
        for ((alias, boundAad) in attempts) {
            val key = wrapKeyIfPresent(alias) ?: continue
            try {
                return KeystoreMasterKey.open(key, blob, boundAad)
            } catch (failure: Exception) {
                last = failure
            }
        }
        throw last ?: error("device encryption key is missing; rebind is required")
    }

    private fun wrapKeyIfPresent(alias: String): javax.crypto.SecretKey? {
        val store = keyStore()
        return (store.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.secretKey
    }

    private fun isSigningHardwareBacked(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        val entry = signingEntry() ?: return false
        return runCatching {
            val factory = java.security.KeyFactory.getInstance(entry.privateKey.algorithm, PROVIDER)
            val info = factory.getKeySpec(entry.privateKey, android.security.keystore.KeyInfo::class.java)
            info.securityLevel != android.security.keystore.KeyProperties.SECURITY_LEVEL_SOFTWARE
        }.getOrDefault(false)
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

    private fun aad(purpose: String): ByteArray =
        (
            AAD_PREFIX + "\u0000" + scope.serverId +
                "\u0000" + scope.deviceId + "\u0000" + purpose
            )
            .toByteArray(Charsets.UTF_8)

    private fun legacyAad(purpose: String): ByteArray =
        (
            AAD_PREFIX + "\u0000" + scope.serverId + "\u0000" + scope.userId +
                "\u0000" + scope.deviceId + "\u0000" + purpose
            )
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

    private val refPrivate: SecretRef
        get() = SecretRef.of(RESERVED_ENTITY, deviceIdentityScopeDigest(scope), "mlkemPrivateKey")
    private val refPublic: SecretRef
        get() = SecretRef.of(RESERVED_ENTITY, deviceIdentityScopeDigest(scope), "mlkemPublicKey")

    companion object {
        const val ALIAS_SIGNING: String = "zephyr.one.device.es256.v1"
        const val SIGNING_ALG: String = "ES256"
        private const val PROVIDER = "AndroidKeyStore"
        private const val RESERVED_ENTITY = "__deviceIdentity"
        private const val AAD_PREFIX = "zephyr-one-device-identity-v1"
        private const val PROOF_V2_PREFIX = "zephyr-one-device-proof-v2"
    }
}

/** Device identity ciphertext has ref-independent AAD, so its historical key can migrate as-is. */
internal fun SecretBlobStore.readMigratingLegacyRef(ref: SecretRef): ByteArray? {
    read(ref)?.let { return it }
    val legacy = ref.legacyValueOrNull()?.takeIf { it != ref.value }?.let(::SecretRef) ?: return null
    val blob = read(legacy) ?: return null
    write(ref, blob)
    delete(legacy)
    return blob
}

internal fun SecretBlobStore.deleteCurrentAndLegacyRef(ref: SecretRef) {
    delete(ref)
    ref.legacyValueOrNull()
        ?.takeIf { it != ref.value }
        ?.let { delete(SecretRef(it)) }
}

internal fun deviceIdentityAlias(base: String, scope: DeviceIdentity.Scope): String =
    base + "." + deviceIdentityScopeDigest(scope)

internal fun deviceIdentityLegacyAlias(base: String, scope: DeviceIdentity.Scope): String =
    base + "." + deviceIdentityLegacyScopeDigest(scope)

/**
 * Link v2 enrollment mints the device key before the account userId is known,
 * so the alias is `serverId + deviceId`. A previous digest that also mixed in
 * userId is still tried as a read fallback so a still-bound pre device can
 * keep proving until the next rebind.
 */
private fun deviceIdentityScopeDigest(scope: DeviceIdentity.Scope): String =
    digest16(scope.serverId + "\u0000" + scope.deviceId)

private fun deviceIdentityLegacyScopeDigest(scope: DeviceIdentity.Scope): String =
    digest16(scope.serverId + "\u0000" + scope.userId + "\u0000" + scope.deviceId)

private fun digest16(material: String): String =
    MessageDigest.getInstance("SHA-256")
        .digest(material.toByteArray(Charsets.UTF_8))
        .take(16)
        .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }

/** Converts the two positive DER INTEGERs into fixed-width r || s. */
internal fun derEcdsaToP1363(der: ByteArray, fieldBytes: Int = 32): ByteArray {
    var offset = 0

    fun readByte(): Int {
        require(offset < der.size) { "truncated ECDSA signature" }
        return der[offset++].toInt() and 0xff
    }

    fun readLength(): Int {
        val first = readByte()
        if (first < 0x80) return first
        val count = first and 0x7f
        require(count in 1..2) { "unsupported ECDSA DER length" }
        var value = 0
        repeat(count) { value = (value shl 8) or readByte() }
        return value
    }

    fun readInteger(): ByteArray {
        require(readByte() == 0x02) { "invalid ECDSA DER integer" }
        val length = readLength()
        require(length > 0 && offset + length <= der.size) { "invalid ECDSA DER integer length" }
        var start = offset
        val end = offset + length
        offset = end
        require(der[start].toInt() and 0x80 == 0) { "negative ECDSA DER integer" }
        if (end - start > 1 && der[start] == 0.toByte()) {
            require(der[start + 1].toInt() and 0x80 != 0) { "non-canonical ECDSA DER integer" }
            start += 1
        }
        val valueLength = end - start
        require(valueLength <= fieldBytes) { "ECDSA integer exceeds field width" }
        return ByteArray(fieldBytes).also { output ->
            der.copyInto(output, fieldBytes - valueLength, start, end)
        }
    }

    require(readByte() == 0x30) { "invalid ECDSA DER sequence" }
    val sequenceLength = readLength()
    require(sequenceLength == der.size - offset) { "invalid ECDSA DER sequence length" }
    val r = readInteger()
    val s = readInteger()
    require(offset == der.size) { "trailing ECDSA DER bytes" }
    return r + s
}
