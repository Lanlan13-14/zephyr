package one.zephyr.mobile.model.sync

import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import one.zephyr.mobile.contracts.SyncAction
import org.junit.Assert.assertEquals
import org.junit.Test

class PushPredictionFixtureTest {

    @Test
    fun matchesGeneratedClassifyCases() {
        val cases = Fixtures.array(Fixtures.syncCases, "classifyPush")
        assertEquals(true, cases.isNotEmpty())
        for (case in cases) {
            val name = case["name"]!!.jsonPrimitive.content
            val expected = case["expected"]!!.jsonObject
            val result = PushPrediction.classify(
                localMask = Fixtures.strings(case["localMask"]),
                serverChangedFields = Fixtures.strings(case["serverChangedFields"]),
                baseRevision = case["baseRevision"]!!.jsonPrimitive.long,
                currentRevision = case["currentRevision"]!!.jsonPrimitive.long,
            )
            assertEquals(name + " status", expected["status"]!!.jsonPrimitive.content, result.status.wireName)
            assertEquals(name + " reason", expected["reason"]!!.jsonPrimitive.content, result.reason.wireName)
            assertEquals(name + " fields", Fixtures.strings(expected["fields"]), result.fields)
        }
    }

    @Test
    fun matchesGeneratedApplyChangeCases() {
        val cases = Fixtures.array(Fixtures.syncCases, "applyChange")
        assertEquals(true, cases.isNotEmpty())
        for (case in cases) {
            val name = case["name"]!!.jsonPrimitive.content
            val change = case["change"]!!.jsonObject
            val result = PushPrediction.shouldApplyChange(
                localRevision = case["localRevision"]!!.jsonPrimitive.long,
                action = SyncAction.valueOf(change["action"]!!.jsonPrimitive.content.uppercase()),
                changeRevision = change["revision"]!!.jsonPrimitive.long,
            )
            assertEquals(name, case["expected"]!!.jsonPrimitive.content.toBoolean(), result)
        }
    }

    @Test
    fun cursorNeverMovesBackwards() {
        assertEquals(12L, PushPrediction.advanceCursor(12L, listOf(3L, 7L, 11L)))
        assertEquals(15L, PushPrediction.advanceCursor(12L, listOf(13L, 15L)))
    }

    @Test
    fun staleUpsertCannotResurrectAfterTombstone() {
        // Row deleted and tombstoned at revision 9. A replayed/bootstrap-backfilled UPSERT
        // carrying an OLDER revision (7) must not recreate the row; only an UPSERT newer
        // than the delete is a legitimate server-side recreation. MirrorWriter passes the
        // tombstone revision as localRevision when the live row is gone.
        val tombstoneRevision = 12L
        assertEquals(
            false,
            PushPrediction.shouldApplyChange(tombstoneRevision, SyncAction.UPSERT, changeRevision = 7L),
        )
        assertEquals(
            true,
            PushPrediction.shouldApplyChange(tombstoneRevision, SyncAction.UPSERT, changeRevision = 13L),
        )
        // DELETE always applies, tombstone semantics intact.
        assertEquals(
            true,
            PushPrediction.shouldApplyChange(tombstoneRevision, SyncAction.DELETE, changeRevision = 7L),
        )
    }
}
