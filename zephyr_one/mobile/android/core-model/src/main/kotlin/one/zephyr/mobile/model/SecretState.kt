package one.zephyr.mobile.model

/**
 * Secret editing is an explicit tri-state (ZEPHYR_PARITY.md 5.3). A masked placeholder is never
 * a new secret, so "unchanged" must be representable and must never reach a fieldMask.
 */
sealed interface SecretState {
    /** Keep whatever the server already holds. Produces no fieldMask entry. */
    data object Unchanged : SecretState

    /** Replace with a new plaintext value, which is enveloped before it leaves the device. */
    data class Replace(val plaintext: String) : SecretState

    /** Explicitly clear the stored secret. */
    data object Clear : SecretState

    val contributesToFieldMask: Boolean
        get() = this !is Unchanged
}

/**
 * List payloads only ever carry presence, never the secret. Mirrors Zephyr's hasX/masked contract.
 */
data class SecretPresence(
    val hasValue: Boolean,
    val secretRef: String? = null,
) {
    companion object {
        val absent = SecretPresence(hasValue = false)
        const val MASK = "******"
    }
}

/** A reference into the local SecretStore. Business rows never hold ciphertext directly. */
@JvmInline
value class SecretRef(val value: String) {
    companion object {
        fun of(entityType: String, entityId: String, fieldName: String): SecretRef =
            SecretRef(entityType + "/" + entityId + "/" + fieldName)
    }
}
