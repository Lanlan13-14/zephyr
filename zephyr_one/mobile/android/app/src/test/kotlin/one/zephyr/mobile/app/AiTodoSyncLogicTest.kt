package one.zephyr.mobile.app

import one.zephyr.mobile.data.repository.LocalAiTodo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM tests for the pure todo sync policy. These encode the invariants the
 * coordinator relies on: convergence (merge→push is a fixpoint), no
 * resurrection of server deletes, offline-first survival.
 */
class AiTodoSyncLogicTest {

    private fun todo(
        id: String,
        title: String = "t-$id",
        status: String = "pending",
        revision: Long = 0,
        deletedAt: Long? = null,
        updatedAt: Long = 0,
    ) = LocalAiTodo(id = id, title = title, status = status, revision = revision, deletedAt = deletedAt, updatedAt = updatedAt)

    /* ── mergeTodos: pull direction ── */

    @Test
    fun `mirror row with newer revision wins`() {
        val merged = mergeTodos(
            local = listOf(todo("a", title = "stale", revision = 1)),
            mirror = listOf(todo("a", title = "fresh", revision = 2)),
        )
        assertEquals(listOf("fresh"), merged.map { it.title })
        assertEquals(2L, merged.single().revision)
    }

    @Test
    fun `never-pushed local row revision 0 accepts any mirror revision`() {
        val merged = mergeTodos(
            local = listOf(todo("a", title = "offline", revision = 0)),
            mirror = listOf(todo("a", title = "server", revision = 1)),
        )
        assertEquals(listOf("server"), merged.map { it.title })
    }

    @Test
    fun `local row at or above mirror revision survives`() {
        val local = mergeTodos(
            local = listOf(todo("a", title = "local-edit", revision = 3)),
            mirror = listOf(todo("a", title = "server-old", revision = 2)),
        )
        assertEquals(listOf("local-edit"), local.map { it.title })
    }

    @Test
    fun `mirror tombstone deletes the local row regardless of revision`() {
        val merged = mergeTodos(
            local = listOf(todo("a", revision = 9)),
            mirror = listOf(todo("a", revision = 2, deletedAt = 123L)),
        )
        assertTrue(merged.isEmpty())
    }

    @Test
    fun `local row absent from mirror survives offline creation`() {
        val merged = mergeTodos(
            local = listOf(todo("offline-only", revision = 0)),
            mirror = listOf(todo("server-row", revision = 5)),
        )
        assertEquals(setOf("offline-only", "server-row"), merged.map { it.id }.toSet())
    }

    @Test
    fun `mirror-only live row is appended`() {
        val merged = mergeTodos(local = emptyList(), mirror = listOf(todo("from-server", revision = 4)))
        assertEquals(listOf("from-server"), merged.map { it.id })
    }

    /* ── planPush: push direction ── */

    @Test
    fun `new local row is scheduled for upsert`() {
        val plan = planPush(local = listOf(todo("new")), mirror = emptyList())
        assertEquals(listOf("new"), plan.upserts.map { it.id })
        assertTrue(plan.deletes.isEmpty())
    }

    @Test
    fun `content-equal rows push nothing`() {
        val plan = planPush(
            local = listOf(todo("a", title = "same", revision = 1, updatedAt = 111)),
            mirror = listOf(todo("a", title = "same", revision = 7, updatedAt = 222)),
        )
        assertTrue(plan.isEmpty)
    }

    @Test
    fun `bookkeeping-only differences are not content`() {
        val plan = planPush(
            local = listOf(todo("a", revision = 1, updatedAt = 10)),
            mirror = listOf(todo("a", revision = 99, updatedAt = 99)),
        )
        assertTrue(plan.isEmpty)
    }

    @Test
    fun `changed content is scheduled for upsert`() {
        val plan = planPush(
            local = listOf(todo("a", title = "edited")),
            mirror = listOf(todo("a", title = "original", revision = 3)),
        )
        assertEquals(listOf("a"), plan.upserts.map { it.id })
        assertTrue(plan.deletes.isEmpty())
    }

    @Test
    fun `mirror live row missing locally is scheduled for delete`() {
        val plan = planPush(
            local = listOf(todo("kept")),
            mirror = listOf(todo("kept", revision = 1), todo("gone", revision = 2)),
        )
        assertEquals(listOf("gone"), plan.deletes)
        assertTrue(plan.upserts.isEmpty())
    }

    @Test
    fun `mirror tombstone plus stale local row schedules neither upsert nor delete`() {
        val plan = planPush(
            local = listOf(todo("a", title = "resurrect-attempt", revision = 1)),
            mirror = listOf(todo("a", revision = 3, deletedAt = 5L)),
        )
        // No upsert: that would resurrect the server delete. No delete: the
        // mirror row is already tombstoned. The pull merge drops the local row.
        assertTrue(plan.isEmpty)
    }

    /* ── convergence: merge+push, server ack, then merge+push again is a fixpoint ── */

    /** Simulates the server accepting a push: content lands, revision bumps, deletes tombstone. */
    private fun applyPlan(mirror: List<LocalAiTodo>, plan: TodoPushPlan): List<LocalAiTodo> {
        val byId = mirror.associateBy { it.id }.toMutableMap()
        for (row in plan.upserts) byId[row.id] = row.copy(revision = (byId[row.id]?.revision ?: 0L) + 1)
        for (id in plan.deletes) byId[id]?.let { byId[id] = it.copy(deletedAt = Long.MAX_VALUE) }
        return byId.values.toList()
    }

    @Test
    fun `two-round convergence - second plan is empty and content stable`() {
        val local = listOf(
            todo("a", title = "local-new", revision = 0),
            todo("b", title = "server-wins", revision = 1),
            todo("c", title = "deleted", revision = 4),
            todo("d", title = "local-keeps", revision = 6),
        )
        val mirror = listOf(
            todo("a", title = "already-pushed", revision = 2),
            todo("b", title = "fresh", revision = 3),
            todo("c", revision = 2, deletedAt = 9L),
            todo("d", title = "stale", revision = 5),
            todo("e", title = "server-only", revision = 1),
        )
        // Round 1: merge, push
        val merged1 = mergeTodos(local, mirror)
        val plan1 = planPush(local = merged1, mirror = mirror)
        // Server acks the plan into the mirror
        val mirrorAfterAck = applyPlan(mirror, plan1)
        // Round 2: merge again, push again — must be a fixpoint
        val merged2 = mergeTodos(merged1, mirrorAfterAck)
        val plan2 = planPush(local = merged2, mirror = mirrorAfterAck)
        assertTrue("second plan not empty: ${plan2.upserts.map { it.id }} ${plan2.deletes}", plan2.isEmpty)
        // Content stable across the ack (only bookkeeping changed)
        assertEquals(merged1.map { it.title }.sorted(), merged2.map { it.title }.sorted())
        // The tombstoned row stayed dead
        assertTrue(merged2.none { it.id == "c" })
    }

    @Test
    fun `offline edit flow converges after push echo`() {
        // 1. local edit on top of a synced row
        val localEdit = listOf(todo("a", title = "edited", revision = 2))
        val mirrorOld = listOf(todo("a", title = "base", revision = 2))
        val plan = planPush(localEdit, mirrorOld)
        assertEquals(listOf("a"), plan.upserts.map { it.id })

        // 2. server accepts and bumps revision; echo arrives as mirror row
        val mirrorAfterAck = listOf(todo("a", title = "edited", revision = 3))
        val merged = mergeTodos(localEdit, mirrorAfterAck)
        assertEquals(3L, merged.single().revision)
        assertTrue(planPush(merged, mirrorAfterAck).isEmpty)
    }

    @Test
    fun `todoContentEquals ignores revision deletedAt and updatedAt`() {
        val a = todo("x", revision = 1, updatedAt = 1)
        val b = todo("x", revision = 8, updatedAt = 99, deletedAt = null)
        org.junit.Assert.assertTrue(todoContentEquals(a, b))
        org.junit.Assert.assertFalse(todoContentEquals(a, b.copy(status = "completed")))
    }

    @Test
    fun `steps participate in content equality`() {
        val withStep = todo("x").let { it.copy(steps = listOf(one.zephyr.mobile.data.repository.LocalAiTodoStep("s1", "step", false))) }
        val without = todo("x")
        org.junit.Assert.assertFalse(todoContentEquals(withStep, without))
    }
}
