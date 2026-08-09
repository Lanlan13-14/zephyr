package one.zephyr.mobile.model.sync

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import one.zephyr.mobile.contracts.SyncContract
import org.junit.Assert.assertEquals
import org.junit.Test

class OperationFoldingFixtureTest {

    @Test
    fun matchesGeneratedFoldCases() {
        val cases = Fixtures.array(Fixtures.syncCases, "fold")
        assertEquals(true, cases.isNotEmpty())
        for (case in cases) {
            val name = case["name"]!!.jsonPrimitive.content
            val input = Fixtures.array(case, "operations").map(Fixtures::operation)
            val expected = Fixtures.array(case, "expected").map(Fixtures::operation)
            val folded = OperationFolding.fold(input)

            assertEquals(name + " count", expected.size, folded.size)
            expected.forEachIndexed { index, want ->
                val got = folded[index]
                assertEquals(name + " opId", want.opId, got.opId)
                assertEquals(name + " action", want.action, got.action)
                assertEquals(name + " entityId", want.entityId, got.entityId)
                assertEquals(name + " baseRevision", want.baseRevision, got.baseRevision)
                assertEquals(name + " fieldMask", want.fieldMask, got.fieldMask)
                assertEquals(name + " payload", want.payload, got.payload)
                assertEquals(name + " createdLocally", want.createdLocally, got.createdLocally)
            }
        }
    }

    @Test
    fun matchesGeneratedPushOrderAndBatching() {
        val node = Fixtures.syncCases["pushOrder"]!!.jsonObject
        val input = Fixtures.array(node, "input").map(Fixtures::operation)
        val expectedIds = Fixtures.strings(node["expectedOpIds"])
        assertEquals(expectedIds, OperationFolding.sortForPush(input).map { it.opId })

        val expectedBatches = node["expectedBatchCount"]!!.jsonPrimitive.content.toInt()
        assertEquals(expectedBatches, OperationFolding.batch(input, maxPerBatch = 2).size)
    }

    @Test
    fun batchesNeverExceedTheFrozenLimit() {
        val many = (1..451).map { index ->
            Fixtures.operation(
                buildJsonObject {
                    put("opId", JsonPrimitive("op-" + index))
                    put("entityType", JsonPrimitive("note"))
                    put("entityId", JsonPrimitive("n-" + index))
                    put("action", JsonPrimitive("upsert"))
                    put("baseRevision", JsonPrimitive(1))
                },
            )
        }
        val batches = OperationFolding.batch(many)
        assertEquals(3, batches.size)
        assertEquals(true, batches.all { it.size <= SyncContract.MAX_OPS_PER_BATCH })
        assertEquals(451, batches.sumOf { it.size })
    }
}
