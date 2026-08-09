package one.zephyr.mobile.security

import one.zephyr.mobile.contracts.SecretEnvelopeContract
import one.zephyr.mobile.model.Base64Codec
import one.zephyr.mobile.model.SecretEnvelope
import one.zephyr.mobile.model.SharedUseEnvelope

sealed class EnvelopeRejection(val code: String, message: String) : Exception(message) {
    data object UnsupportedVersion : EnvelopeRejection("envelope_unsupported_version", "envelope version is not 1")
    data object UnsupportedAlgorithm : EnvelopeRejection("envelope_unsupported_algorithm", "envelope algorithm is not the frozen suite")
    data object AadMismatch : EnvelopeRejection("envelope_aad_mismatch", "rebuilt AAD does not match the envelope")
    data object RevisionMismatch : EnvelopeRejection("envelope_revision_mismatch", "envelope revision does not match the entity")
    data object KeyVersionMismatch : EnvelopeRejection("envelope_key_version_mismatch", "envelope key version is unknown to this device")
    data object BadGeometry : EnvelopeRejection("envelope_bad_geometry", "IV or tag length is wrong for AES-256-GCM")
    data object Expired : EnvelopeRejection("shared_session_expired", "shared use envelope has expired")
    data object PurposeNotAllowed : EnvelopeRejection("shared_direct_forbidden", "shared use purpose is not permitted")
    data class ForbiddenPayloadKey(val key: String) :
        EnvelopeRejection("shared_residency_violation", "shared payload carried control-plane key " + key)
}

/**
 * Structural validation performed before any key material is touched.
 *
 * Decryption itself lives behind [DeviceKeyStore] because the ML-KEM private key must stay
 * hardware-wrapped; this object exists so an envelope that fails its binding is rejected without
 * ever reaching a cipher.
 */
object EnvelopeGuard {

    fun decodeBase64(value: String): ByteArray = Base64Codec.decode(value)

    fun verifySecretEnvelope(
        envelope: SecretEnvelope,
        expected: MobileAad.SecretInput,
        knownKeyVersions: Set<Int>,
    ) {
        requireSuite(envelope.v, envelope.alg, envelope.kem, envelope.aead)
        if (!knownKeyVersions.contains(envelope.keyVersion)) throw EnvelopeRejection.KeyVersionMismatch
        if (envelope.keyVersion != expected.keyVersion) throw EnvelopeRejection.KeyVersionMismatch
        if (envelope.entityRevision != expected.entityRevision) throw EnvelopeRejection.RevisionMismatch
        requireGeometry(envelope.iv, envelope.tag)
        val rebuilt = MobileAad.secretAad(expected)
        if (!MobileAad.constantTimeEquals(rebuilt, decodeBase64(envelope.aad))) throw EnvelopeRejection.AadMismatch
    }

    fun verifySharedEnvelope(
        envelope: SharedUseEnvelope,
        expected: MobileAad.SharedInput,
        allowedPurposes: Set<String>,
        nowMillis: Long,
    ) {
        requireSuite(envelope.v, envelope.alg, envelope.kem, envelope.aead)
        if (!SecretEnvelopeContract.sharedPurposes.contains(envelope.purpose)) throw EnvelopeRejection.PurposeNotAllowed
        if (!allowedPurposes.contains(envelope.purpose)) throw EnvelopeRejection.PurposeNotAllowed
        if (envelope.forbiddenClientToken != null) throw EnvelopeRejection.ForbiddenPayloadKey("clientToken")
        if (envelope.expiresAt <= nowMillis) throw EnvelopeRejection.Expired
        if (envelope.sessionId != expected.sessionId) throw EnvelopeRejection.AadMismatch
        if (envelope.resourceId != expected.resourceId) throw EnvelopeRejection.AadMismatch
        if (envelope.resourceRevision != expected.resourceRevision) throw EnvelopeRejection.RevisionMismatch
        requireGeometry(envelope.iv, envelope.tag)
        val rebuilt = MobileAad.sharedAad(expected)
        if (!MobileAad.constantTimeEquals(rebuilt, decodeBase64(envelope.aad))) throw EnvelopeRejection.AadMismatch
    }

    /**
     * A decrypted shared payload may only carry the credentials needed for the session.
     * Control-plane secrets appearing here are a residency violation, not a parse warning.
     */
    fun assertNoControlPlaneKeys(payloadKeys: Collection<String>) {
        for (key in payloadKeys) {
            if (SecretEnvelopeContract.forbiddenSharedPayloadKeys.contains(key)) {
                throw EnvelopeRejection.ForbiddenPayloadKey(key)
            }
        }
    }

    private fun requireSuite(version: Int, alg: String, kem: String, aead: String) {
        if (version != SecretEnvelopeContract.VERSION) throw EnvelopeRejection.UnsupportedVersion
        if (alg != SecretEnvelopeContract.ALG) throw EnvelopeRejection.UnsupportedAlgorithm
        if (kem != SecretEnvelopeContract.KEM) throw EnvelopeRejection.UnsupportedAlgorithm
        if (aead != SecretEnvelopeContract.AEAD) throw EnvelopeRejection.UnsupportedAlgorithm
    }

    private fun requireGeometry(iv: String, tag: String) {
        if (decodeBase64(iv).size != SecretEnvelopeContract.IV_BYTES) throw EnvelopeRejection.BadGeometry
        if (decodeBase64(tag).size != SecretEnvelopeContract.TAG_BYTES) throw EnvelopeRejection.BadGeometry
    }
}
