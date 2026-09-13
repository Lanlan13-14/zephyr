package one.zephyr.mobile.app

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import one.zephyr.mobile.model.AiProvider
import one.zephyr.mobile.model.AiMemory
import one.zephyr.mobile.model.AiSkill
import one.zephyr.mobile.model.AiEnv
import one.zephyr.mobile.model.AiTodo
import one.zephyr.mobile.data.repository.LocalAiRepository
import one.zephyr.mobile.data.repository.OwnedAiRepository

/**
 * Generic merge/push policy over [SyncedRow]s — the entity-family
 * generalization of the todo policy in AiTodoSyncLogic.kt, with identical
 * invariants (two-round convergence, no resurrection, offline rows survive,
 * tombstones required in the mirror input).
 *
 * A [SyncedRow] is any catalog row carrying the sync bookkeeping trio
 * (id / revision / deletedAt). Secret-bearing rows (provider apiKey, env
 * value) keep their secrets in the local SecretStore; the diff runs on
 * non-secret content only, and secrets ride the LocalWriteGateway envelope
 * (SecretState) rather than the content payload.
 */
internal interface SyncedRow {
    val syncId: String
    val syncRevision: Long
    val syncDeletedAt: Long?
}

/** Merge mirror rows into local rows. [mirror] MUST include tombstones. */
internal fun <T : SyncedRow> mergeRows(local: List<T>, mirror: List<T>, replace: (remote: T, localRow: T) -> T): List<T> {
    val mirrorById = mirror.associateBy { it.syncId }
    val survived = local.mapNotNull { row ->
        val remote = mirrorById[row.syncId]
        when {
            remote == null -> row
            remote.syncDeletedAt != null -> null
            remote.syncRevision > row.syncRevision || row.syncRevision == 0L -> replace(remote, row)
            else -> row
        }
    }
    val localIds = local.mapTo(mutableSetOf()) { it.syncId }
    val incoming = mirror.filter { it.syncId !in localIds && it.syncDeletedAt == null }
    return survived + incoming
}

internal data class PushPlan<T>(val upserts: List<T>, val deletes: List<String>) {
    val isEmpty: Boolean get() = upserts.isEmpty() && deletes.isEmpty()
}

/** Diff local rows against the mirror (tombstones included) into a push plan. */
internal fun <T : SyncedRow> planRowPush(
    local: List<T>,
    mirror: List<T>,
    contentEquals: (a: T, b: T) -> Boolean,
): PushPlan<T> {
    val mirrorById = mirror.associateBy { it.syncId }
    val upserts = local.filter { row ->
        val remote = mirrorById[row.syncId]
        when {
            remote == null -> true
            remote.syncDeletedAt != null -> false // server tombstone wins; pull side drops the local row
            else -> !contentEquals(row, remote)
        }
    }
    val localIds = local.mapTo(mutableSetOf()) { it.syncId }
    val deletes = mirror.filter { it.syncDeletedAt == null && it.syncId !in localIds }.map { it.syncId }
    return PushPlan(upserts = upserts, deletes = deletes)
}

/**
 * One entity family member: how to read the local catalog, how to read the
 * mirror (tombstones included), and how to push. The coordinator drives every
 * binding with the same loop.
 */
internal interface EntityBinding {
    val entityType: String

    /** Local rows with sync bookkeeping attached. */
    suspend fun localRows(): List<SyncedRow>

    /** Mirror rows including tombstones, mapped to the same shape. */
    suspend fun mirrorRows(owner: String): List<SyncedRow>

    /** Persist a merged snapshot back into the local catalog (pull side). */
    suspend fun applyMerged(rows: List<SyncedRow>)

    /** Push one upsert and one delete through the owned repository. */
    suspend fun pushUpsert(row: SyncedRow, owner: String)
    suspend fun pushDelete(id: String, owner: String)

    /** Content equality for the diff (sync bookkeeping excluded). */
    fun contentEquals(a: SyncedRow, b: SyncedRow): Boolean
}
