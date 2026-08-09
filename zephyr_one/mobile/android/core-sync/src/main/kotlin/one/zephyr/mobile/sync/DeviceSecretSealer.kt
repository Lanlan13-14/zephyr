package one.zephyr.mobile.sync

import one.zephyr.mobile.model.SecretEnvelope
import one.zephyr.mobile.model.SecretRef
import one.zephyr.mobile.security.DeviceEnvelopeCrypto
import one.zephyr.mobile.security.MlKem
import one.zephyr.mobile.security.MobileAad
import one.zephyr.mobile.security.SecretStore

/** Supplies the server's ML-KEM-768 public key, or null when the server has not published one. */
fun interface ServerEncryptionKeyProvider {
    /** @return raw public key bytes and their key version, or null when unavailable. */
    fun current(): ServerEncryptionKey?
}

data class ServerEncryptionKey(val publicKey: ByteArray, val keyVersion: Int) {
    override fun equals(other: Any?): Boolean =
        other is ServerEncryptionKey && keyVersion == other.keyVersion && publicKey.contentEquals(other.publicKey)

    override fun hashCode(): Int = 31 * publicKey.contentHashCode() + keyVersion
}

/**
 * Seals locally changed secrets for the server.
 *
 * **Blocked by the frozen contract, deliberately not faked.** DATA_AND_MIGRATION.md 5.2 defines the
 * device envelope in one direction only: the server seals *for* a device public key, which is what
 * BindRequest.keys.encryption carries. Neither /capabilities nor BindResponse publishes a server
 * encryption public key, so a device currently has nothing to seal *to*.
 *
 * The consequences are followed through honestly rather than papered over:
 *  - [canSeal] returns false while no key is registered;
 *  - [PushPlanner] then defers any operation with a changed secret instead of sending it;
 *  - the secret stays in the local SecretStore and the operation stays queued, so nothing is lost.
 *
 * Downgrading to plaintext, or pushing the masked placeholder as if it were a new
 * value, are both explicit release blockers, so neither is implemented. When the main end publishes
 * a key, wiring [ServerEncryptionKeyProvider] is the only change needed here.
 */
class DeviceSecretSealer(
    private val secretStore: SecretStore,
    private val serverKey: ServerEncryptionKeyProvider,
    private val serverId: String,
    private val userId: String,
    private val deviceId: String,
) : SecretSealer {

    override fun canSeal(): Boolean = serverKey.current() != null && MlKem.isAvailable

    override suspend fun seal(
        entityType: String,
        entityId: String,
        fieldName: String,
        entityRevision: Long,
    ): SecretEnvelope? {
        val key = serverKey.current() ?: return null
        val ref = SecretRef.of(entityType, entityId, fieldName)
        val plaintext = secretStore.get(ref) ?: return null
        return try {
            val aad = MobileAad.secretAad(
                MobileAad.SecretInput(
                    serverId = serverId,
                    userId = userId,
                    deviceId = deviceId,
                    entityType = entityType,
                    entityId = entityId,
                    fieldName = fieldName,
                    entityRevision = entityRevision,
                    keyVersion = key.keyVersion,
                ),
            )
            DeviceEnvelopeCrypto.sealForPublicKey(
                plaintext = plaintext,
                publicKey = key.publicKey,
                aad = aad,
                keyVersion = key.keyVersion,
                entityRevision = entityRevision,
            )
        } finally {
            // The plaintext copy handed back by the store is zeroed here rather than left for the
            // GC: a secret must not survive in a heap dump longer than the operation needs it.
            plaintext.fill(0)
        }
    }
}

/** No server key available. Used until the main end publishes one. */
object UnavailableSecretSealer : SecretSealer {
    override fun canSeal(): Boolean = false

    override suspend fun seal(
        entityType: String,
        entityId: String,
        fieldName: String,
        entityRevision: Long,
    ): SecretEnvelope? = null
}
