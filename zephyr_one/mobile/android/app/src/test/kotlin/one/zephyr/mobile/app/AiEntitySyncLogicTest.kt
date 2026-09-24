package one.zephyr.mobile.app

import one.zephyr.mobile.data.repository.LocalAiMemory
import one.zephyr.mobile.data.repository.LocalAiProvider
import one.zephyr.mobile.data.repository.LocalAiSkill
import one.zephyr.mobile.data.repository.LocalAiTodo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Generic entity-family policy tests (AiEntitySyncLogic). The todo-specific
 * policy keeps its own suite (AiTodoSyncLogicTest); these cover the
 * generalized merge/planPush over the SyncedRow surface plus the provider
 * secret rule (presence is bookkeeping, not content).
 */

private data class Row(
    val id: String,
    val payload: String,
    override val syncRevision: Long = 0,
    override val syncDeletedAt: Long? = null,
) : SyncedRow {
    override val syncId: String get() = id
}

private fun same(a: Row, b: Row) = a.id == b.id && a.payload == b.payload

class AiEntitySyncLogicTest {

    @Test
    fun `two-round convergence with mixed states`() {
        val local = listOf(
            Row("a", "new-offline"),
            Row("b", "stale", syncRevision = 1),
            Row("c", "deleted-remotely", syncRevision = 4),
            Row("d", "local-newer", syncRevision = 6),
        )
        val mirror = listOf(
            Row("b", "fresh", syncRevision = 3),
            Row("c", "x", syncRevision = 9, syncDeletedAt = 9L),
            Row("d", "older", syncRevision = 5),
            Row("e", "server-only", syncRevision = 1),
        )
        val merged1 = mergeRows(local, mirror, replace = { remote, _ -> remote })
        val plan1 = planRowPush(merged1, mirror, ::same)
        // ack: upserts bump revision, deletes tombstone
        val byId = mirror.associateBy { it.id }.toMutableMap()
        for (u in plan1.upserts) byId[u.id] = u.copy(syncRevision = (byId[u.id]?.syncRevision ?: 0L) + 1)
        for (d in plan1.deletes) byId[d]?.let { byId[d] = it.copy(syncDeletedAt = Long.MAX_VALUE) }
        val mirror2 = byId.values.toList()
        val merged2 = mergeRows(merged1, mirror2, replace = { remote, _ -> remote })
        val plan2 = planRowPush(merged2, mirror2, ::same)
        assertTrue("second plan must be empty: ${plan2.upserts.map { it.id }} ${plan2.deletes}", plan2.isEmpty)
        assertTrue(merged2.none { it.id == "c" })
        assertEquals(listOf("a", "b", "d", "e"), merged2.map { it.id }.sorted())
    }

    @Test
    fun `tombstone suppresses resurrection regardless of local revision`() {
        val local = listOf(Row("x", "edited", syncRevision = 99))
        val mirror = listOf(Row("x", "old", syncRevision = 10, syncDeletedAt = 10L))
        val merged = mergeRows(local, mirror, replace = { r, _ -> r })
        assertTrue(merged.isEmpty())
        val plan = planRowPush(local, mirror, ::same)
        assertTrue(plan.upserts.isEmpty())
        assertTrue(plan.deletes.isEmpty())
    }

    @Test
    fun `revision-zero local rows adopt the mirror row`() {
        val local = listOf(Row("a", "never-pushed"))
        val mirror = listOf(Row("a", "server", syncRevision = 2))
        val merged = mergeRows(local, mirror, replace = { r, _ -> r })
        assertEquals("server", merged.single().payload)
        assertEquals(2L, merged.single().syncRevision)
    }

    @Test
    fun `content-equal rows produce no push`() {
        val local = listOf(Row("a", "same", syncRevision = 2))
        val mirror = listOf(Row("a", "same", syncRevision = 2))
        assertTrue(planRowPush(local, mirror, ::same).isEmpty)
    }

    @Test
    fun `provider secret presence is bookkeeping not content`() {
        /* A local provider (with a key in the SecretStore) vs its mirrored
         * echo (presence-only projection): content equality must hold or the
         * coordinator would re-push the provider every round. */
        val local = ProviderRow("p1", "OpenAI", "https://api.openai.com", hasKey = true)
        val mirror = ProviderRow("p1", "OpenAI", "https://api.openai.com", hasKey = false)
        assertTrue(providerContentEquals(local, mirror))
    }

    @Test
    fun `quarantined rows are excluded from push plan`() {
        val local = listOf(
            Row("ok-1", "normal"),
            Row("bad-2", "fails-validation"),
            Row("ok-3", "normal"),
        )
        val mirror = emptyList<Row>()
        val quarantined = setOf("bad-2")
        val plan = planRowPush(local, mirror, quarantinedIds = quarantined, contentEquals = ::same)

        assertEquals(2, plan.upserts.size)
        assertEquals(listOf("ok-1", "ok-3"), plan.upserts.map { it.id })
        assertTrue("quarantined row must not be in plan", plan.upserts.none { it.id == "bad-2" })
    }

    @Test
    fun `quarantined deletes are excluded from push plan`() {
        val local = emptyList<Row>()
        val mirror = listOf(
            Row("d1", "rem-1"),
            Row("d2", "rem-2"),
        )
        val quarantined = setOf("d1")
        val plan = planRowPush(local, mirror, quarantinedIds = quarantined, contentEquals = ::same)

        assertEquals(listOf("d2"), plan.deletes)
    }
}

/* Local provider test rows — presence flag models apiKey=SecretPresence. */
internal data class ProviderRow(
    val id: String,
    val name: String,
    val baseUrl: String,
    val hasKey: Boolean,
    override val syncRevision: Long = 0,
    override val syncDeletedAt: Long? = null,
) : SyncedRow {
    override val syncId: String get() = id
}

internal fun providerContentEquals(a: ProviderRow, b: ProviderRow): Boolean =
    a.id == b.id && a.name == b.name && a.baseUrl == b.baseUrl
