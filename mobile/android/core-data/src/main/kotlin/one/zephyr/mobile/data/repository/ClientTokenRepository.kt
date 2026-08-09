package one.zephyr.mobile.data.repository

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.data.LocalEdit
import one.zephyr.mobile.data.LocalWriteGateway
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.data.mapper.ResourceMappers
import one.zephyr.mobile.model.ClientToken
import one.zephyr.mobile.model.SecretRef
import one.zephyr.mobile.model.SecretState
import one.zephyr.mobile.security.SecretStore

/**
 * Client Tokens (S46).
 *
 * The token secret is a first-class mutual-backup field, not metadata: PRODUCT_REQUIREMENTS.md 12
 * lists "token metadata only" as a release blocker. The secret therefore arrives through a device
 * envelope and lives in the SecretStore, while the mirror row keeps only presence.
 *
 * Reveal, rotate, delete and reset-all all require a main-end sensitive grant. This repository
 * refuses to act without one so the guard cannot be skipped by calling the data layer directly.
 */
class ClientTokenRepository(
    private val db: ZephyrDatabase,
    private val gateway: LocalWriteGateway,
    private val secretStore: SecretStore,
) {

    fun observeAll(ownerUserId: String): Flow<List<ClientToken>> =
        db.mirrorDao().observeByType(ClientToken.ENTITY_TYPE, ownerUserId).map { rows ->
            rows.map { ResourceMappers.clientToken(it) }
        }

    suspend fun find(id: String): ClientToken? =
        db.mirrorDao().find(ClientToken.ENTITY_TYPE, id)?.let { ResourceMappers.clientToken(it) }

    /** Only the name is editable; the secret is server-minted (registry: editableFields = [name]). */
    suspend fun rename(id: String, name: String, ownerUserId: String) {
        require(name.isNotBlank() && name.length <= ClientToken.MAX_NAME_CHARS) {
            "token name must be 1.." + ClientToken.MAX_NAME_CHARS + " characters"
        }
        gateway.apply(
            LocalEdit(
                entityType = ClientToken.ENTITY_TYPE,
                entityId = id,
                action = SyncAction.UPSERT,
                requestedMask = listOf("name"),
                values = JsonObject(mapOf("name" to JsonPrimitive(name))),
            ),
            ownerUserId,
        )
    }

    /**
     * Reveals the stored token.
     *
     * @param grantId proof that the main end verified the account password or TOTP for this exact
     *   action. DEVELOPMENT.md 617 forbids App Lock or biometrics from standing in for it.
     */
    fun reveal(id: String, grantId: String?): String? {
        require(!grantId.isNullOrEmpty()) {
            "revealing a Client Token requires a main-end sensitive grant"
        }
        return secretStore.getText(SecretRef.of(ClientToken.ENTITY_TYPE, id, "token"))
    }

    fun hasSecret(id: String): Boolean =
        secretStore.has(SecretRef.of(ClientToken.ENTITY_TYPE, id, "token"))

    /**
     * Stores a token secret that arrived in a device envelope.
     *
     * Called by the sync actor after the envelope AAD has been verified; the plaintext never passes
     * through a mirror payload.
     */
    fun storeSecret(id: String, plaintext: String) {
        require(plaintext.length in ClientToken.MIN_SECRET_CHARS..ClientToken.MAX_SECRET_CHARS) {
            "client token secret length is outside the frozen bounds"
        }
        secretStore.putText(SecretRef.of(ClientToken.ENTITY_TYPE, id, "token"), plaintext)
    }

    /**
     * Queues the local half of a token delete.
     *
     * @param grantId required for the same reason as [reveal]: deleting a token detaches every
     *   device bound through it.
     */
    suspend fun delete(id: String, ownerUserId: String, grantId: String?) {
        require(!grantId.isNullOrEmpty()) { "deleting a Client Token requires a main-end sensitive grant" }
        gateway.apply(
            LocalEdit(
                entityType = ClientToken.ENTITY_TYPE,
                entityId = id,
                action = SyncAction.DELETE,
                requestedMask = emptyList(),
            ),
            ownerUserId,
        )
    }

    /** Drops every locally cached token secret, used after a main-end reset-all. */
    suspend fun forgetAllSecrets(ownerUserId: String) {
        for (row in db.mirrorDao().listByType(ClientToken.ENTITY_TYPE, ownerUserId)) {
            secretStore.remove(SecretRef.of(ClientToken.ENTITY_TYPE, row.entityId, "token"))
        }
    }
}
