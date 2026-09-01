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
 * A rejection returns null to the mirror writer, which aborts the complete page without advancing
 * its revision or cursor. Keeping a previous plaintext under a new server presence/revision would
 * pair the wrong secret with the row and make the next round skip the only chance to repair it.
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
        val expected = MobileAad.SecretInput(
            serverId = serverId(),
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
