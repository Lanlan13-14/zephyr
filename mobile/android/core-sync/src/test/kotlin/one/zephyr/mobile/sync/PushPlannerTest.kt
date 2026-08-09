package one.zephyr.mobile.sync

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.contracts.SyncAction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PushPlannerTest {

    @Test
    fun `folds repeated edits of one entity into a single operation`() {
        val plan = PushPlanner.plan(
            listOf(
                pendingOp("op-1", fieldMask = listOf("name"), payload = payload("name" to "a"), createdAt = 1),
                pendingOp("op-2", fieldMask = listOf("host"), payload = payload("host" to "h"), createdAt = 2),
            ),
            canSealSecrets = false,
        )

        assertEquals(1, plan.operationCount)
        val op = plan.batches.single().single()
        // The first opId survives so a replay still deduplicates server-side.
        assertEquals("op-1", op.opId)
        assertEquals(listOf("name", "host"), op.fieldMask)
        assertTrue(plan.foldedRemoved.contains("op-2"))
    }

    @Test
    fun `never folds a group that already has an operation in flight`() {
        val plan = PushPlanner.plan(
            listOf(
                pendingOp("op-sent", fieldMask = listOf("name"), createdAt = 1, dispatchedAt = 500),
                pendingOp("op-new", fieldMask = listOf("host"), createdAt = 2),
            ),
            canSealSecrets = false,
        )

        // Rewriting op-sent's content would make the server deduplicate the merged edit away.
        assertEquals(listOf("op-sent"), plan.batches.single().map { it.opId })
        assertEquals(
            listOf(DeferredOperation("op-new", DeferralReason.IN_FLIGHT_PREDECESSOR)),
            plan.deferred,
        )
        assertFalse(plan.foldedRemoved.contains("op-new"))
    }

    @Test
    fun `defers a secret change while no server key is available`() {
        val plan = PushPlanner.plan(
            listOf(pendingOp("op-1", fieldMask = emptyList(), secretFields = listOf("password"))),
            canSealSecrets = false,
        )

        assertTrue(plan.isEmpty)
        assertEquals(DeferralReason.SECRET_UNSEALABLE, plan.deferred.single().reason)
        // Deferred, never dropped: the local secret is still the newest value.
        assertFalse(plan.foldedRemoved.contains("op-1"))
    }

    @Test
    fun `sends a secret change once sealing is possible`() {
        val plan = PushPlanner.plan(
            listOf(pendingOp("op-1", fieldMask = emptyList(), secretFields = listOf("password"))),
            canSealSecrets = true,
        )

        assertEquals(listOf("op-1"), plan.batches.single().map { it.opId })
        assertTrue(plan.deferred.isEmpty())
    }

    @Test
    fun `drops a locally created row deleted before its first push`() {
        val plan = PushPlanner.plan(
            listOf(
                pendingOp("op-1", createdLocally = true, createdAt = 1),
                pendingOp("op-2", action = SyncAction.DELETE, fieldMask = emptyList(), createdAt = 2),
            ),
            canSealSecrets = false,
        )

        assertTrue(plan.isEmpty)
        assertEquals(setOf("op-1", "op-2"), plan.foldedRemoved.toSet())
    }

    @Test
    fun `orders batches by dependency order`() {
        val plan = PushPlanner.plan(
            listOf(
                pendingOp("op-conn", entityType = "connection", entityId = "c-1"),
                pendingOp("op-token", entityType = "clientToken", entityId = "t-1", fieldMask = listOf("name")),
                pendingOp("op-key", entityType = "sshKey", entityId = "k-1", fieldMask = listOf("name")),
            ),
            canSealSecrets = false,
        )

        // clientToken(0) -> sshKey(10) -> connection(40): a connection must never be pushed before
        // the key it references.
        assertEquals(
            listOf("clientToken", "sshKey", "connection"),
            plan.batches.single().map { it.entityType },
        )
    }

    @Test
    fun `chunks to the frozen batch limit`() {
        val ops = (1..450).map { index ->
            pendingOp("op-" + index, entityId = "c-" + index)
        }
        val plan = PushPlanner.plan(ops, canSealSecrets = false)

        assertEquals(listOf(200, 200, 50), plan.batches.map { it.size })
    }

    @Test
    fun `drops an upsert with nothing left to say`() {
        val plan = PushPlanner.plan(
            listOf(pendingOp("op-1", fieldMask = emptyList())),
            canSealSecrets = false,
        )

        assertTrue(plan.isEmpty)
        assertEquals(listOf("op-1"), plan.foldedRemoved)
    }

    private fun payload(vararg pairs: Pair<String, String>): JsonObject =
        JsonObject(pairs.associate { (key, value) -> key to JsonPrimitive(value) })
}
