package one.zephyr.mobile.data.db

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

enum class SecretMutationKind {
    PUT,
    CLEAR,
}

enum class SecretMutationJournalState {
    /** The old/new opaque values are durable, but the Room business mutation is not committed. */
    PREPARED,

    /** The Room mirror and operation queue committed; recovery must replay the new value. */
    LOCAL_COMMITTED,
}

enum class SecretMutationRetention {
    /** Local edits retain the old encrypted value until the server accepts the operation. */
    UNTIL_REMOTE_ACK,

    /** Inbound mirror writes can discard the journal once their Room transaction commits. */
    COMMIT_ONLY,
}

/**
 * Crash-recovery intent for one SecretRef mutation.
 *
 * Both blobs are ciphertext sealed by the account generation's non-exportable Keystore key and
 * bound to [secretRef] as AAD. No plaintext secret is ever written to Room.
 */
@Entity(
    tableName = "secret_mutation_journal",
    indices = [
        Index(value = ["serverId", "ownerUserId", "deviceId", "bindingGeneration", "state"]),
        Index(
            value = ["serverId", "ownerUserId", "deviceId", "bindingGeneration", "sequence"],
            unique = true,
        ),
        Index(value = ["operationId"]),
        Index(value = ["entityType", "entityId"]),
    ],
)
data class SecretMutationJournalRow(
    @PrimaryKey val journalId: String,
    val serverId: String,
    val ownerUserId: String,
    val deviceId: String,
    val bindingGeneration: String,
    val operationId: String,
    val secretRef: String,
    val entityType: String,
    val entityId: String,
    val fieldName: String,
    val mutation: String,
    val state: String,
    val retention: String,
    val oldOpaqueBlob: ByteArray?,
    val newOpaqueBlob: ByteArray?,
    /** Durable causal order. Wall-clock time and random ids are not ordering primitives. */
    val sequence: Long,
    /** Never cleared: deleting the newer row must not make this older value live again. */
    val supersededByJournalId: String?,
    val createdAt: Long,
)
