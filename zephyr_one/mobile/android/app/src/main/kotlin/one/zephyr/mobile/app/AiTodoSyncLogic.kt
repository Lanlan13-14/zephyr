package one.zephyr.mobile.app

import one.zephyr.mobile.data.repository.LocalAiTodo

/**
 * Pure todo sync policy — no Android, no Room, no coroutines. JVM-unit-testable.
 *
 * Invariants this policy guarantees:
 *  - Convergence: merge() followed by planPush() on the merged state produces
 *    an empty push plan (no ping-pong between pull and push).
 *  - No resurrection: a server tombstone is never answered with an upsert;
 *    the local row is deleted by merge, not re-pushed.
 *  - Offline creation survives: a local row the mirror has never seen is
 *    kept locally and scheduled for push, never dropped by merge.
 */

/** Business-field equality; revision/deletedAt/updatedAt are sync bookkeeping, not content. */
internal fun todoContentEquals(a: LocalAiTodo, b: LocalAiTodo): Boolean =
    a.id == b.id &&
        a.title == b.title &&
        a.description == b.description &&
        a.status == b.status &&
        a.priority == b.priority &&
        a.dueAt == b.dueAt &&
        a.steps == b.steps &&
        a.note == b.note &&
        a.source == b.source

/**
 * Pull merge, last-writer-wins by revision, row by row:
 *  - mirror live row with strictly newer revision (or local never pushed, revision 0) wins;
 *  - local row newer-or-equal revision is kept (offline edits survive until their push lands);
 *  - mirror tombstone deletes the local row whatever the revision (server delete is final);
 *  - local rows absent from the mirror are kept (created offline);
 *  - mirror live rows absent locally are appended.
 *
 * [mirror] MUST include tombstoned rows (deletedAt != null) or server deletes
 * cannot propagate.
 */
internal fun mergeTodos(local: List<LocalAiTodo>, mirror: List<LocalAiTodo>): List<LocalAiTodo> {
    val mirrorById = mirror.associateBy { it.id }
    val survived = local.mapNotNull { row ->
        val remote = mirrorById[row.id]
        when {
            remote == null -> row
            remote.deletedAt != null -> null
            remote.revision > row.revision || row.revision == 0L -> remote
            else -> row
        }
    }
    val localIds = local.mapTo(mutableSetOf()) { it.id }
    val incoming = mirror.filter { it.id !in localIds && it.deletedAt == null }
    return survived + incoming
}

/** What the coordinator owes the server after diffing local rows against the mirror. */
internal data class TodoPushPlan(val upserts: List<LocalAiTodo>, val deletes: List<String>) {
    val isEmpty: Boolean get() = upserts.isEmpty() && deletes.isEmpty()
}

/**
 * Push plan from local (authority for content) against the mirror.
 * [mirror] MUST include tombstones: a tombstoned row counts as "the server
 * has newer knowledge", so a stale local row is neither re-pushed (that
 * would resurrect a server-side delete) nor deleted again.
 *
 *  - local row missing from mirror (no live row, no tombstone) → upsert (new);
 *  - local row differs in content from the live mirror row → upsert (edit);
 *  - live mirror row whose id is gone from local → delete;
 *  - content-equal rows → nothing (idempotent: merge-triggered saves repush nothing).
 */
internal fun planPush(local: List<LocalAiTodo>, mirror: List<LocalAiTodo>): TodoPushPlan {
    val mirrorById = mirror.associateBy { it.id }
    val upserts = local.filter { row ->
        val remote = mirrorById[row.id]
        when {
            remote == null -> true
            remote.deletedAt != null -> false // server tombstone: pull side will drop the local row
            else -> !todoContentEquals(row, remote)
        }
    }
    val localIds = local.mapTo(mutableSetOf()) { it.id }
    val deletes = mirror.filter { it.deletedAt == null && it.id !in localIds }.map { it.id }
    return TodoPushPlan(upserts = upserts, deletes = deletes)
}
