package one.zephyr.mobile.app

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import one.zephyr.mobile.data.repository.LocalAiRepository
import one.zephyr.mobile.data.repository.LocalAiTodo
import one.zephyr.mobile.data.repository.OwnedAiRepository
import one.zephyr.mobile.model.AiTodo
import one.zephyr.mobile.model.AiTodoStep

/**
 * Bridges the account-local todo catalog (what the UI and the todo_* tools
 * read and write) with the OwnedAiRepository mirror (what syncs with the main
 * side through the Link change feed).
 *
 * Pull: [reconcile] runs once at start and after every completed sync round.
 * Mirror rows — tombstones included — are merged into the local catalog via
 * [mergeTodos]: newer-revision wins, mirror tombstone deletes the local row,
 * rows absent from the mirror survive (offline-first).
 *
 * Push: the local catalog flow is observed and diffed row-for-row against the
 * mirror by content (see [planPush]). Only changed or new rows are pushed
 * through OwnedAiRepository. The diff makes push idempotent — a merge-triggered
 * save re-enters with zero diff and pushes nothing, so pull and push cannot
 * ping-pong. UI writes (settings todo list) and AI writes (todo_* tools in
 * AndroidAiPlatformHost) both land in the catalog and are covered without any
 * per-call-site instrumentation.
 *
 * Deletes are guarded by a seen-id set: a mirror row is only deleted when its
 * id has previously been observed in a local snapshot. Without the guard,
 * [LocalAiRepository.normalized] dropping a server row (e.g. blank title)
 * would fabricate a delete for a row this device never owned.
 *
 * Everything no-ops while unbound; push additionally requires
 * `syncFromMainEnabled`, re-evaluated on every emission so toggling the
 * setting takes effect without a restart.
 */
class AiTodoSyncCoordinator(
    private val scope: CoroutineScope,
    private val localAi: LocalAiRepository,
    private val ownedAi: OwnedAiRepository,
    private val ownerUserId: () -> String,
    private val syncEnabled: suspend () -> Boolean,
) {
    private var started = false
    private var observeJob: Job? = null

    /** Ids ever observed in a local snapshot; guards mirror deletes (see class doc). */
    private val seenIds = mutableSetOf<String>()

    /** Idempotent; called from [AccountContainer.startNetworkProducers]. */
    fun start() {
        if (started) return
        started = true
        reconcile()
        startObserving()
    }

    /**
     * Full round-trip: merge mirror → local, then (when push is enabled)
     * diff local → mirror. Called at start and after every sync round, so a
     * late-enabled toggle converges on the next round even with no local
     * writes in between.
     */
    fun reconcile() {
        scope.launch {
            try {
                val owner = ownerUserId()
                if (owner.isBlank()) return@launch
                mergeFromMirror(owner)
                if (syncEnabled()) {
                    val todos = localAi.load().todos
                    seenIds += todos.map { it.id }
                    pushChanged(todos)
                }
            } catch (err: CancellationException) {
                throw err
            } catch (err: Exception) {
                Log.w(TAG, "reconcile failed", err)
            }
        }
    }

    private suspend fun mergeFromMirror(owner: String) {
        val mirror = ownedAi.listTodosWithTombstones(owner)
        val local = localAi.load()
        val merged = mergeTodos(local = local.todos, mirror = mirror.map { it.toLocal() })
        if (merged != local.todos) localAi.save(local.copy(todos = merged))
    }

    private fun startObserving() {
        if (observeJob?.isActive == true) return
        observeJob = scope.launch {
            localAi.observe().collect { catalog ->
                seenIds += catalog.todos.map { it.id }
                try {
                    if (syncEnabled()) pushChanged(catalog.todos)
                } catch (err: CancellationException) {
                    throw err
                } catch (err: Exception) {
                    Log.w(TAG, "push failed", err)
                }
            }
        }
    }

    private suspend fun pushChanged(todos: List<LocalAiTodo>) {
        val owner = ownerUserId()
        if (owner.isBlank()) return
        val mirror = ownedAi.listTodosWithTombstones(owner).map { it.toLocal() }
        val plan = planPush(local = todos, mirror = mirror)
        for (upsert in plan.upserts) ownedAi.saveTodo(upsert.toModel(owner), PUSH_MASK, owner)
        for (deleteId in plan.deletes.filter { it in seenIds }) {
            ownedAi.delete(AiTodo.ENTITY_TYPE, deleteId, owner)
        }
        /* The mirror write re-enters via the next catalog emission or sync
         * round; planPush against the refreshed mirror is then empty, so
         * there is no echo loop. */
    }

    private companion object {
        const val TAG = "AiTodoSync"
        val PUSH_MASK = listOf(
            "title", "description", "status", "priority", "dueAt", "steps", "note", "source",
        )
    }
}

private fun LocalAiTodo.toModel(owner: String): AiTodo = AiTodo(
    id = id,
    ownerUserId = owner,
    title = title,
    description = description,
    status = status,
    priority = priority,
    dueAt = dueAt,
    steps = steps.map { s -> AiTodoStep(id = s.id, title = s.title, done = s.done) },
    note = note,
    source = source,
    updatedAt = updatedAt,
)

private fun AiTodo.toLocal(): LocalAiTodo = LocalAiTodo(
    id = id,
    title = title,
    description = description,
    status = status,
    priority = priority,
    dueAt = dueAt,
    steps = steps.map { s -> one.zephyr.mobile.data.repository.LocalAiTodoStep(id = s.id, title = s.title, done = s.done) },
    note = note,
    source = source,
    revision = revision,
    deletedAt = deletedAt,
    updatedAt = updatedAt,
)
