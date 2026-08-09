package one.zephyr.mobile.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Wire form of a device secret envelope (contracts/schemas/secret-envelope.schema.json).
 *
 * The DTO lives in core-model rather than core-security so sync records can carry envelopes
 * without the data layer depending on the crypto layer. Nothing here can decrypt: opening an
 * envelope requires [one.zephyr.mobile.security.DeviceEnvelopeCrypto], which additionally
 * verifies the AAD binding first.
 */
@Serializable
data class SecretEnvelope(
    val v: Int,
    val alg: String,
    val kem: String,
    val aead: String,
    /** ML-KEM-768 encapsulation ciphertext. */
    val ct: String,
    val iv: String,
    /** Detached 16-byte GCM tag; the frozen wire format does not append it to [data]. */
    val tag: String,
    /** AES-256-GCM ciphertext of the secret value. */
    val data: String,
    val aad: String,
    val keyVersion: Int,
    val entityRevision: Long,
)

/** Wire form of a shared single-use envelope (contracts/schemas/shared-use-envelope.schema.json). */
@Serializable
data class SharedUseEnvelope(
    val v: Int,
    val alg: String,
    val kem: String,
    val aead: String,
    val ct: String,
    val iv: String,
    val tag: String,
    val data: String,
    val aad: String,
    val keyVersion: Int,
    val resourceRevision: Long,
    val sessionId: String,
    val resourceId: String,
    val purpose: String,
    val expiresAt: Long,
    val clientNonce: String,
    /**
     * Declared only so a server that wrongly included a client token is rejected structurally.
     * SHARED_RESOURCE_RESIDENCY.md 5 forbids control-plane keys in a shared payload, and a
     * silently-ignored unknown key would let one slip through unnoticed.
     */
    @SerialName("clientToken") val forbiddenClientToken: String? = null,
)
