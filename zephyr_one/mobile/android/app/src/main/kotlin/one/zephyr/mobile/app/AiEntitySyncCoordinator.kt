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
class AiEntitySyncCoordinator(
    private val scope: CoroutineScope,
    private val localAi: LocalAiRepository,
    private val ownedAi: OwnedAiRepository,
    private val ownerUserId: () -> String,
    private val syncEnabled: suspend () -> Boolean,
    private val bindings: List<EntityBinding>,
) {
    private var started = false
    private var observeJob: Job? = null

    /** Ids ever observed locally, per entity type; guard mirror deletes. */
    private val seenIds = HashMap<String, MutableSet<String>>()

    fun start() {
        if (started) return
        started = true
        reconcile()
        startObserving()
    }

    /** Merge mirror → local for every binding, then push what changed. */
    fun reconcile() {
        scope.launch {
            try {
                val owner = ownerUserId()
                if (owner.isBlank()) return@launch
                for (binding in bindings) mergeBinding(binding, owner)
                if (syncEnabled()) {
                    for (binding in bindings) pushBinding(binding, owner)
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
        val plan = planRowPush(local = local, mirror = mirror, contentEquals = binding::contentEquals)
        for (upsert in plan.upserts) binding.pushUpsert(upsert, owner)
        val seen = seenIds[binding.entityType] ?: emptySet()
        for (id in plan.deletes.filter { it in seen }) binding.pushDelete(id, owner)
    }

    private fun startObserving() {
        if (observeJob?.isActive == true) return
        observeJob = scope.launch {
            localAi.observe().collect {
                try {
                    if (syncEnabled()) {
                        val owner = ownerUserId()
                        if (owner.isNotBlank()) {
                            for (binding in bindings) pushBinding(binding, owner)
                        }
                    }
                } catch (err: CancellationException) {
                    throw err
                } catch (err: Exception) {
                    Log.w(TAG, "push failed", err)
                }
            }
        }
    }

    private companion object {
        const val TAG = "AiEntitySync"
    }
}
