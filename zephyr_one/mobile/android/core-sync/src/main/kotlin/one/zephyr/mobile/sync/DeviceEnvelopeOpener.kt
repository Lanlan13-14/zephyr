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
 * A rejection is *not* fatal to the page. The AAD binds the envelope to an exact entityRevision, so
 * an envelope that arrives alongside a newer revision legitimately fails to verify; the field keeps
 * its previous value and the next round retries with matching revisions.
 */
class DeviceEnvelopeOpener(
    private val identity: DeviceIdentity,
    private val serverId: String,
    private val userId: String,
    private val deviceId: String,
    private val knownKeyVersions: () -> Set<Int>,
    private val onRejected: (String, String) -> Unit = { _, _ -> },
) : EnvelopeOpener {

    override fun open(change: SyncChange, fieldName: String): ByteArray? {
        val envelope = change.secretEnvelopes[fieldName] ?: return null
        val expected = MobileAad.SecretInput(
            serverId = serverId,
            userId = userId,
            deviceId = deviceId,
            entityType = change.entityType,
            entityId = change.entityId,
            fieldName = fieldName,
            entityRevision = change.revision,
            keyVersion = envelope.keyVersion,
        )
        return try {
            identity.withPrivateKey { privateKey ->
                DeviceEnvelopeCrypto.openSecretEnvelope(
                    envelope = envelope,
                    expected = expected,
                    knownKeyVersions = knownKeyVersions(),
                    privateKey = privateKey,
                )
            }
        } catch (rejection: EnvelopeRejection) {
            onRejected(change.entityType + "/" + change.entityId + "/" + fieldName, rejection.code)
            null
        } catch (failure: Exception) {
            // A cipher failure is reported the same way as a structural rejection: the message is
            // never surfaced, because it could echo ciphertext into a log.
            onRejected(change.entityType + "/" + change.entityId + "/" + fieldName, "envelope_open_failed")
            null
        }
    }
}
