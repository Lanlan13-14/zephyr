package one.zephyr.mobile.data.repository

import org.junit.Assert.assertEquals
import org.junit.Test

class LocalAiPlanCatalogTest {

    @Test
    fun `normalized catalog keeps distinct plans and drops blank assistant names`() {
        val catalog = LocalAiCatalog(
            assistantName = "   ",
            plans = listOf(
                LocalAiPlan(id = "p1", title = "deploy"),
                LocalAiPlan(id = "p1", title = "duplicate"),
                LocalAiPlan(id = "p2", title = "rollback"),
            ),
        ).normalized()

        assertEquals("Zephyr AI", catalog.assistantName)
        assertEquals(listOf("p1", "p2"), catalog.plans.map { it.id })
        assertEquals("deploy", catalog.plans.first().title)
    }
}
