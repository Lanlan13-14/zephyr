package one.zephyr.mobile.model.sync

import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class FieldMaskFixtureTest {

    @Test
    fun matchesGeneratedFieldMaskCases() {
        val cases = Fixtures.array(Fixtures.syncCases, "fieldMask")
        assertEquals(true, cases.isNotEmpty())
        for (case in cases) {
            val name = case["name"]!!.jsonPrimitive.content
            val entityType = case["entityType"]!!.jsonPrimitive.content
            val requested = Fixtures.strings(case["requested"])
            val expected = case["expected"]!!.jsonObject
            val result = FieldMask.sanitize(entityType, requested)

            assertEquals(name + " accepted", Fixtures.strings(expected["accepted"]), result.accepted)

            val expectedRejections = Fixtures.array(expected, "rejected").map {
                it["field"]!!.jsonPrimitive.content + ":" + it["reason"]!!.jsonPrimitive.content
            }
            val actualRejections = result.rejected.map { it.field + ":" + it.reason.wireName }
            assertEquals(name + " rejected", expectedRejections, actualRejections)
        }
    }

    @Test
    fun maskedPlaceholderIsNeverAccepted() {
        // A UI that leaks the "******" display value must not turn it into a secret write.
        val result = FieldMask.sanitize("connection", listOf("password"))
        assertEquals(emptyList<String>(), result.accepted)
        assertEquals(MaskRejectionReason.FORBIDDEN, result.rejected.single().reason)
    }

    @Test
    fun nestedSettingsPathsResolveAtTheirRoot() {
        val result = FieldMask.sanitize("oneUserSettings", listOf("appearance.theme", "appearance.customCss"))
        assertEquals(listOf("appearance.theme"), result.accepted)
        assertEquals(MaskRejectionReason.FORBIDDEN, result.rejected.single().reason)
    }

    @Test(expected = IllegalArgumentException::class)
    fun unknownEntityTypeIsRejected() {
        FieldMask.sanitize("notAnEntity", listOf("name"))
    }
}
