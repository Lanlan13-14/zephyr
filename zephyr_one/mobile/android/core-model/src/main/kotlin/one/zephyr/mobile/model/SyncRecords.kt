package one.zephyr.mobile.model

import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.contracts.SyncAction
import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.contracts.SyncPhase

/**
 * A local write waiting to be pushed. Persisted in the same transaction as the optimistic
 * entity write (SYNC_STATE_MACHINE.md 5), so a crash can never leave one without the other.
 */
data class PendingOperation(
    val opId: String,
    val batchId: String? = null,
    val entityType: String,
    val entityId: String,
    val action: SyncAction,
    val baseRevision: Long,
    val fieldMask: List<String>,
    val payload: JsonObject,
    val createdAt: Long,
    val attemptCount: Int = 0,
    val lastError: String? = null,
    /** Locally created rows fold away entirely if deleted before the first push. */
    val createdLocally: Boolean = false,
    /**
     * Registry field names whose secret value changed locally.
     *
     * Secrets are deliberately absent from [fieldMask] and [payload] (SYNC_STATE_MACHINE.md 4.3), so
     * without this list the push layer could not tell that a secret needs a fresh envelope. Only the
     * names live here; the plaintext stays in the SecretStore.
     */
    val secretFields: List<String> = emptyList(),
    /** Set once the op has been transmitted: retries must reuse the same opId, never a new one. */
    val dispatchedAt: Long? = null,
) {
    val isDispatched: Boolean get() = dispatchedAt != null
}

/** Progress for the file sync card. */
data class SyncProgress(
    val phase: SyncPhase?,
    val entitiesProcessed: Int = 0,
    val entitiesTotal: Int? = null,
    val bytesProcessed: Long = 0,
    val bytesTotal: Long? = null,
) {
    val fraction: Float?
        get() = entitiesTotal?.takeIf { it > 0 }?.let { entitiesProcessed.toFloat() / it }

    companion object {
        val idle = SyncProgress(phase = null)
    }
}

/**
 * Everything the file sync screen shows. Target interval and last actual sync are separate
 * fields on purpose: background schedulers cannot promise the target.
 */
data class SyncStatus(
    val bindingState: BindingState,
    val enabled: Boolean,
    val automaticEnabled: Boolean,
    val targetIntervalSec: Int,
    val networkPolicy: NetworkPolicy,
    val appliedCursor: Long,
    val acknowledgedCursor: Long,
    val pendingCount: Int,
    val conflictCount: Int,
    val lastAttemptAt: Long?,
    val lastSuccessAt: Long?,
    val lastError: MobileError?,
    val progress: SyncProgress = SyncProgress.idle,
    val rerunRequested: Boolean = false,
) {
    /** Sync Now stays available whenever the binding is live, even with automatic off. */
    val canSyncNow: Boolean get() = bindingState.canRunSync || bindingState == BindingState.CONFLICTED

    val isRunning: Boolean get() = progress.phase != null

    companion object {
        fun unbound(): SyncStatus = SyncStatus(
            bindingState = BindingState.UNBOUND,
            enabled = false,
            automaticEnabled = false,
            targetIntervalSec = 300,
            networkPolicy = NetworkPolicy.ANY,
            appliedCursor = 0,
            acknowledgedCursor = 0,
            pendingCount = 0,
            conflictCount = 0,
            lastAttemptAt = null,
            lastSuccessAt = null,
            lastError = null,
        )
    }
}

enum class NetworkPolicy(val wireName: String) {
    WIFI_ONLY("wifiOnly"),
    ANY("any"),
    ;

    companion object {
        fun fromWire(value: String?): NetworkPolicy =
            entries.firstOrNull { it.wireName == value } ?: ANY
    }
}

/** A stable conflict awaiting an explicit user choice. Never auto-resolved. */
data class ConflictRecord(
    val conflictId: String,
    val entityType: String,
    val entityId: String,
    val displayName: String,
    val overlappingFields: List<String>,
    val baseRevision: Long,
    val serverRevision: Long,
    val localPayloadJson: String,
    val serverPayloadJson: String,
    val basePayloadJson: String?,
    val detectedAt: Long,
) {
    /** Secret fields cannot be text-merged; the user picks one side and it is re-enveloped. */
    val isSecretConflict: Boolean
        get() = overlappingFields.any { field ->
            one.zephyr.mobile.contracts.EntityRegistry.byType[entityType]
                ?.secretFields?.contains(field) == true
        }
}

/** Trigger that started a sync round, for diagnostics and the status card. */
enum class SyncTrigger {
    FOREGROUND_START,
    BIND_COMPLETE,
    MANUAL,
    INTERVAL,
    NETWORK_RESTORED,
    LOCAL_WRITE_DEBOUNCE,
    SERVER_WAKE,
}
