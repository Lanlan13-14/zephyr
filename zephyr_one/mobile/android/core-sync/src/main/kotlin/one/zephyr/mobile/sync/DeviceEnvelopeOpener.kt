package one.zephyr.mobile.sync

import one.zephyr.mobile.data.EnvelopeOpener
import one.zephyr.mobile.model.SyncChange
import one.zephyr.mobile.security.DeviceEnvelopeCrypto
import one.zephyr.mobile.security.DeviceIdentity
import one.zephyr.mobile.security.EnvelopeRejection
import one.zephyr.mobile.security.MobileAad

/**
 * Opens the secret envelopes attached to a change.
 *
 * Lives in core-sync because it is the only layer that holds both the device private key
 * (core-security) and the binding identity needed to rebuild the AAD. core-data deliberately only
 * sees the [EnvelopeOpener] port, so the mirror writer cannot reach key material.
 *
 * A rejection returns null. The mirror writer then either keeps a previously
 * opened local secret (incremental non-secret patches) or fails the page.
 * Ciphertext is opened first under the envelope's own revision, then under
 * the change-feed revision for older main ends.
 */
class DeviceEnvelopeOpener(
    private val identity: DeviceIdentity,
    /**
     * Published main-end serverId from /capabilities, not the local ServerProfile
     * row id. Envelope AAD is bound to the server's value; a local UUID makes
     * every password-bearing connection unopenable and aborts the whole page.
     */
    private val serverId: () -> String,
    private val userId: String,
    private val deviceId: String,
    private val knownKeyVersions: () -> Set<Int>,
    private val onRejected: (String, String) -> Unit = { _, _ -> },
) : EnvelopeOpener {

    override fun open(change: SyncChange, fieldName: String): ByteArray? {
        val envelope = change.secretEnvelopes[fieldName] ?: return null
        /* Prefer the revision stamped on the envelope (the one the ciphertext
         * was sealed under). Fall back to the change-feed revision for older
         * main ends that resealed every patch at the entity revision. */
        val revisions = linkedSetOf(envelope.entityRevision, change.revision)
            .filter { it > 0L }
        var lastRejection: String? = null
        for (revision in revisions) {
            val expected = MobileAad.SecretInput(
                serverId = serverId(),
                userId = userId,
                deviceId = deviceId,
                entityType = change.entityType,
                entityId = change.entityId,
                fieldName = fieldName,
                entityRevision = revision,
                keyVersion = envelope.keyVersion,
            )
            try {
                return identity.withPrivateKey { privateKey ->
                    DeviceEnvelopeCrypto.openSecretEnvelope(
                        envelope = envelope,
                        expected = expected,
                        knownKeyVersions = knownKeyVersions(),
                        privateKey = privateKey,
                    )
                }
            } catch (rejection: EnvelopeRejection) {
                lastRejection = rejection.code
            } catch (_: Exception) {
                lastRejection = "envelope_open_failed"
            }
        }
        onRejected(
            change.entityType + "/" + change.entityId + "/" + fieldName,
            lastRejection ?: "envelope_open_failed",
        )
        return null
    }
}
