package one.zephyr.mobile.model.sync

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import one.zephyr.mobile.contracts.ConflictResolution
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConflictResolverFixtureTest {

    @Test
    fun matchesGeneratedConflictCases() {
        val cases = Fixtures.array(Fixtures.syncCases, "conflictResolution")
        assertEquals(true, cases.isNotEmpty())
        for (case in cases) {
            val name = case["name"]!!.jsonPrimitive.content
            val expected = case["expected"]!!.jsonObject
            val outcome = ConflictResolver.resolve(
                resolution = ConflictResolution.valueOf(
                    case["resolution"]!!.jsonPrimitive.content.uppercase(),
                ),
                entityType = case["entityType"]!!.jsonPrimitive.content,
                entityId = case["entityId"]!!.jsonPrimitive.content,
                serverRevision = case["serverRevision"]!!.jsonPrimitive.long,
                newOpId = case["newOpId"]!!.jsonPrimitive.content,
                mask = Fixtures.strings(case["mask"]),
                payload = case["payload"]?.jsonObject ?: JsonObject(emptyMap()),
            )

            assertEquals(name + " clearsConflict", true, outcome.clearsConflict)
            val expectedOp = expected["operation"]
            if (expectedOp == null || expectedOp is JsonNull) {
                assertNull(name + " expects no queued operation", outcome.operation)
                continue
            }
            val want = Fixtures.operation(expectedOp.jsonObject)
            val got = outcome.operation!!
            assertEquals(name + " opId", want.opId, got.opId)
            assertEquals(name + " entityId", want.entityId, got.entityId)
            assertEquals(name + " action", want.action, got.action)
            assertEquals(name + " baseRevision", want.baseRevision, got.baseRevision)
            assertEquals(name + " fieldMask", want.fieldMask, got.fieldMask)
            assertEquals(name + " payload", want.payload, got.payload)
            assertEquals(name + " createdLocally", want.createdLocally, got.createdLocally)
        }
    }
}
