package one.zephyr.mobile.app

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import one.zephyr.mobile.data.repository.LocalAiRepository
import one.zephyr.mobile.data.repository.OwnedAiRepository

/**
 * Entity-family coordinator: the AiTodoSyncCoordinator loop generalized to
 * provider / memory / skill / env / todo. Pull (merge mirror → catalog, after
 * every sync round), push (diff catalog → mirror on catalog emission). The
 * per-entity specifics live in [EntityBinding] implementations; the loop and
 * its invariants are shared once.
 *
 * Providers: pushing a provider upsert sends apiKey through the
 * LocalWriteGateway secret envelope (SecretState.Set from the local
 * SecretStore) when a local key exists; the server-side mirror projection
 * never returns the key itself, so a mirrored row arrives with
 * apiKey=SecretPresence(false/true) and content equality treats presence as
 * equal either way (presence is bookkeeping, not content). Pull-merging a
 * mirror provider row into the catalog keeps the local key untouched.
 */
internal class AiEntitySyncCoordinator(
    private val scope: CoroutineScope,
    private val localAi: LocalAiRepository,
    private val ownedAi: OwnedAiRepository,
    private val ownerUserId: () -> String,
    private val syncEnabled: suspend () -> Boolean,
    private val bindings: List<EntityBinding>,
    private val journal: QuarantineJournal? = null,
) {
    private var started = false
    private var observeJob: Job? = null

    /** Ids ever observed locally, per entity type; guard mirror deletes. */
    private val seenIds = HashMap<String, MutableSet<String>>()

    /** Quarantined entity entries that failed verification or push, isolated from stalling sync. */
    private val quarantine = java.util.concurrent.ConcurrentHashMap<String, QuarantineItem>()

    fun getQuarantinedItems(): List<QuarantineItem> = quarantine.values.toList()

    fun retryQuarantined(entityType: String, entityId: String) {
        quarantine.remove("$entityType:$entityId")
        persistQuarantine()
        reconcile()
    }

    fun start() {
        if (started) return
        started = true
        restoreQuarantine()
        reconcile()
        startObserving()
    }

    /** Reload persisted quarantine so failures survive process restarts (spec §5.2). */
    private fun restoreQuarantine() {
        val stored = journal?.load() ?: return
        for ((key, item) in stored) quarantine[key] = item
    }

    private fun persistQuarantine() {
        journal?.save(quarantine.values)
    }

    /** Merge mirror → local for every binding, then push what changed. */
    fun reconcile() {
        scope.launch {
            try {
                val owner = ownerUserId()
                if (owner.isBlank()) return@launch
                // Per-binding isolation: one binding failing to merge does not block others
                for (binding in bindings) {
                    try {
                        mergeBinding(binding, owner)
                    } catch (err: CancellationException) {
                        throw err
                    } catch (err: Exception) {
                        Log.w(TAG, "mergeBinding failed for ${binding.entityType}", err)
                    }
                }
                if (syncEnabled()) {
                    for (binding in bindings) {
                        try {
                            pushBinding(binding, owner)
                        } catch (err: CancellationException) {
                            throw err
                        } catch (err: Exception) {
                            Log.w(TAG, "pushBinding failed for ${binding.entityType}", err)
                        }
                    }
                }
            } catch (err: CancellationException) {
                throw err
            } catch (err: Exception) {
                Log.w(TAG, "reconcile failed", err)
            }
        }
    }

    private suspend fun mergeBinding(binding: EntityBinding, owner: String) {
        val local = binding.localRows()
        seenIds.getOrPut(binding.entityType) { mutableSetOf() } += local.map { it.syncId }
        val mirror = binding.mirrorRows(owner)
        val merged = mergeRows(
            local = local,
            mirror = mirror,
            replace = { remote, _ -> remote },
        )
        if (merged != local) binding.applyMerged(merged)
    }

    private suspend fun pushBinding(binding: EntityBinding, owner: String) {
        val local = binding.localRows()
        seenIds.getOrPut(binding.entityType) { mutableSetOf() } += local.map { it.syncId }
        val mirror = binding.mirrorRows(owner)

        // Exclude quarantined IDs for this entity type
        val quarantinedForType = quarantine.values
            .filter { it.entityType == binding.entityType }
            .map { it.entityId }
            .toSet()

        val plan = planRowPush(
            local = local,
            mirror = mirror,
            contentEquals = binding::contentEquals,
            quarantinedIds = quarantinedForType,
        )

        // Per-operation isolation: failure of one row does not crash or abort remaining rows
        for (upsert in plan.upserts) {
            try {
                binding.pushUpsert(upsert, owner)
                // If it was in quarantine and succeeded, clear it
                if (quarantine.remove("${binding.entityType}:${upsert.syncId}") != null) persistQuarantine()
            } catch (err: CancellationException) {
                throw err
            } catch (err: Exception) {
                val key = "${binding.entityType}:${upsert.syncId}"
                val prev = quarantine[key]
                val retries = (prev?.retryCount ?: 0) + 1
                quarantine[key] = QuarantineItem(
                    entityType = binding.entityType,
                    entityId = upsert.syncId,
                    reason = err.message ?: "push upsert error",
                    retryCount = retries,
                )
                persistQuarantine()
                Log.w(TAG, "pushUpsert failed for $key (quarantined)", err)
            }
        }

        val seen = seenIds[binding.entityType] ?: emptySet()
        for (id in plan.deletes.filter { it in seen }) {
            try {
                binding.pushDelete(id, owner)
                if (quarantine.remove("${binding.entityType}:$id") != null) persistQuarantine()
            } catch (err: CancellationException) {
                throw err
            } catch (err: Exception) {
                val key = "${binding.entityType}:$id"
                val prev = quarantine[key]
                val retries = (prev?.retryCount ?: 0) + 1
                quarantine[key] = QuarantineItem(
                    entityType = binding.entityType,
                    entityId = id,
                    reason = err.message ?: "push delete error",
                    retryCount = retries,
                )
                persistQuarantine()
                Log.w(TAG, "pushDelete failed for $key (quarantined)", err)
            }
        }
    }

    private fun startObserving() {
        if (observeJob?.isActive == true) return
        observeJob = scope.launch {
            localAi.observe().collect {
                try {
                    if (syncEnabled()) {
                        val owner = ownerUserId()
                        if (owner.isNotBlank()) {
                            for (binding in bindings) {
                                try {
                                    pushBinding(binding, owner)
                                } catch (err: CancellationException) {
                                    throw err
                                } catch (err: Exception) {
                                    Log.w(TAG, "push failed for ${binding.entityType}", err)
                                }
                            }
                        }
                    }
                } catch (err: CancellationException) {
                    throw err
                } catch (err: Exception) {
                    Log.w(TAG, "observe push loop failed", err)
                }
            }
        }
    }

    private companion object {
        const val TAG = "AiEntitySync"
    }
}
