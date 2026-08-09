package one.zephyr.mobile.data.repository

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.data.db.SyncStateRow
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.NetworkPolicy
import one.zephyr.mobile.model.SyncProgress
import one.zephyr.mobile.model.SyncStatus

/** Cursors, failure counters and the status the 文件同步 card renders. */
class SyncStateRepository(private val db: ZephyrDatabase) {

    suspend fun state(bindingKey: String): SyncStateRow? = db.syncStateDao().find(bindingKey)

    suspend fun ensure(bindingKey: String): SyncStateRow =
        db.syncStateDao().find(bindingKey) ?: SyncStateRow(
            bindingKey = bindingKey,
            bindingState = BindingState.BOUND_NEEDS_BOOTSTRAP.name,
            appliedCursor = 0,
            ackedCursor = 0,
            snapshotCursor = 0,
            lastAttemptAt = null,
            lastSuccessAt = null,
            lastErrorCode = null,
            lastErrorMessage = null,
            consecutiveFailures = 0,
            nextEligibleAt = null,
            registryHash = null,
        ).also { db.syncStateDao().upsert(it) }

    suspend fun save(row: SyncStateRow) = db.syncStateDao().upsert(row)

    suspend fun updateAppliedCursor(bindingKey: String, cursor: Long) =
        db.syncStateDao().updateAppliedCursor(bindingKey, cursor)

    suspend fun updateAckedCursor(bindingKey: String, cursor: Long) =
        db.syncStateDao().updateAckedCursor(bindingKey, cursor)

    suspend fun updateState(bindingKey: String, state: BindingState) =
        db.syncStateDao().updateState(bindingKey, state.name)

    /**
     * Composed status.
     *
     * pendingCount and conflictCount come from their own tables rather than a cached counter so the
     * card can never claim "已同步" while an operation is still queued.
     */
    fun observeStatus(
        bindingKey: String,
        automaticEnabled: Boolean,
        targetIntervalSec: Int,
        policy: NetworkPolicy,
        progress: Flow<SyncProgress>,
    ): Flow<SyncStatus> = combine(
        db.syncStateDao().observe(bindingKey),
        db.pendingOperationDao().observeCount(),
        db.conflictDao().observeCount(),
        progress,
    ) { row, pending, conflicts, currentProgress ->
        val state = row?.bindingState?.let { name -> runCatching { BindingState.valueOf(name) }.getOrNull() }
            ?: BindingState.UNBOUND
        SyncStatus(
            bindingState = state,
            enabled = state.isBound,
            automaticEnabled = automaticEnabled,
            targetIntervalSec = targetIntervalSec,
            networkPolicy = policy,
            appliedCursor = row?.appliedCursor ?: 0,
            acknowledgedCursor = row?.ackedCursor ?: 0,
            pendingCount = pending,
            conflictCount = conflicts,
            lastAttemptAt = row?.lastAttemptAt,
            lastSuccessAt = row?.lastSuccessAt,
            lastError = row?.lastErrorCode?.let { code ->
                MobileError.local(code, row.lastErrorMessage ?: code)
            },
            progress = currentProgress,
        )
    }

    fun observePendingCount(): Flow<Int> = db.pendingOperationDao().observeCount()

    fun observeConflictCount(): Flow<Int> = db.conflictDao().observeCount()

    fun observeBindingState(bindingKey: String): Flow<BindingState> =
        db.syncStateDao().observe(bindingKey).map { row ->
            row?.bindingState?.let { name -> runCatching { BindingState.valueOf(name) }.getOrNull() }
                ?: BindingState.UNBOUND
        }
}
