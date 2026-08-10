package one.zephyr.mobile.security

import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import one.zephyr.mobile.contracts.SecretEnvelopeContract
import one.zephyr.mobile.model.Base64Codec
import one.zephyr.mobile.model.SecretEnvelope
import one.zephyr.mobile.model.SharedUseEnvelope

/**
 * Opens device envelopes produced by the main end.
 *
 * Suite is fixed by DATA_AND_MIGRATION.md 5.2: ML-KEM-768 encapsulation, HKDF-SHA256 with
 * salt = SHA-256("zephyr-mobile-envelope-v1") and info = the AAD bytes, then AES-256-GCM with a
 * 12-byte IV and a detached 16-byte tag.
 *
 * The AAD is rebuilt locally and compared in constant time *before* any key material is touched,
 * so a ciphertext bound to another device, entity, field or revision is rejected without ever
 * reaching a cipher (see [EnvelopeGuard]).
 */
object DeviceEnvelopeCrypto {

    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val TAG_BITS = 128

    /**
     * @param privateKey unwrapped ML-KEM private key; the caller is responsible for zeroing it.
     * @return plaintext bytes the caller owns and should zero after use.
     */
    fun openSecretEnvelope(
        envelope: SecretEnvelope,
        expected: MobileAad.SecretInput,
        knownKeyVersions: Set<Int>,
        privateKey: ByteArray,
    ): ByteArray {
        EnvelopeGuard.verifySecretEnvelope(envelope, expected, knownKeyVersions)
        return open(
            kemCiphertext = EnvelopeGuard.decodeBase64(envelope.ct),
            iv = EnvelopeGuard.decodeBase64(envelope.iv),
            body = EnvelopeGuard.decodeBase64(envelope.data),
            tag = EnvelopeGuard.decodeBase64(envelope.tag),
            aad = MobileAad.secretAad(expected),
            privateKey = privateKey,
        )
    }

    fun openSharedEnvelope(
        envelope: SharedUseEnvelope,
        expected: MobileAad.SharedInput,
        allowedPurposes: Set<String>,
        nowMillis: Long,
        privateKey: ByteArray,
    ): ByteArray {
        EnvelopeGuard.verifySharedEnvelope(envelope, expected, allowedPurposes, nowMillis)
        return open(
            kemCiphertext = EnvelopeGuard.decodeBase64(envelope.ct),
            iv = EnvelopeGuard.decodeBase64(envelope.iv),
            body = EnvelopeGuard.decodeBase64(envelope.data),
            tag = EnvelopeGuard.decodeBase64(envelope.tag),
            aad = MobileAad.sharedAad(expected),
            privateKey = privateKey,
        )
    }

    /**
     * Seals a value for the bound device's own public key.
     *
     * Used by the local re-envelope path and by tests that need a round trip; production writes
     * are enveloped for the server-held public key by the main end.
     */
    fun sealForPublicKey(
        plaintext: ByteArray,
        publicKey: ByteArray,
        aad: ByteArray,
        keyVersion: Int,
        entityRevision: Long,
    ): SecretEnvelope {
        MlKem.requirePublicKeyLength(publicKey)
        val encapsulation = MlKem.require().encapsulate(publicKey)
        val key = derive(encapsulation.sharedSecret, aad)
        try {
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"))
            cipher.updateAAD(aad)
            val iv = cipher.iv
            require(iv.size == SecretEnvelopeContract.IV_BYTES) { "unexpected GCM IV length" }
            val combined = cipher.doFinal(plaintext)
            val split = combined.size - SecretEnvelopeContract.TAG_BYTES
            return SecretEnvelope(
                v = SecretEnvelopeContract.VERSION,
                alg = SecretEnvelopeContract.ALG,
                kem = SecretEnvelopeContract.KEM,
                aead = SecretEnvelopeContract.AEAD,
                ct = base64(encapsulation.ciphertext),
                iv = base64(iv),
                tag = base64(combined.copyOfRange(split, combined.size)),
                data = base64(combined.copyOfRange(0, split)),
                aad = base64(aad),
                keyVersion = keyVersion,
                entityRevision = entityRevision,
            )
        } finally {
            key.fill(0)
            encapsulation.sharedSecret.fill(0)
        }
    }

    private fun open(
        kemCiphertext: ByteArray,
        iv: ByteArray,
        body: ByteArray,
        tag: ByteArray,
        aad: ByteArray,
        privateKey: ByteArray,
    ): ByteArray {
        MlKem.requireCiphertextLength(kemCiphertext)
        val sharedSecret = MlKem.require().decapsulate(privateKey, kemCiphertext)
        val key = derive(sharedSecret, aad)
        try {
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
            cipher.updateAAD(aad)
            // GCM in the JCE expects the tag appended; the wire format keeps it detached.
            val combined = ByteArray(body.size + tag.size)
            body.copyInto(combined, 0)
            tag.copyInto(combined, body.size)
            return cipher.doFinal(combined)
        } finally {
            key.fill(0)
            sharedSecret.fill(0)
        }
    }

    private fun derive(sharedSecret: ByteArray, aad: ByteArray): ByteArray =
        Hkdf.derive(
            salt = MobileAad.hkdfSalt(),
            ikm = sharedSecret,
            info = aad,
            length = SecretEnvelopeContract.DERIVED_KEY_BYTES,
        )

    private fun base64(bytes: ByteArray): String = Base64Codec.encode(bytes)
}
