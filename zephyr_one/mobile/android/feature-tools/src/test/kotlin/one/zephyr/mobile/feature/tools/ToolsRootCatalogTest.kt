package one.zephyr.mobile.feature.tools

import one.zephyr.mobile.model.ActionGate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolsRootCatalogTest {

    @Test
    fun `root catalog matches demo rows and order`() {
        val inventory = ToolsInventory()
        val rows = ToolsCatalog.sections().flatMap { ToolsCatalog.visibleRows(it, inventory) }

        assertEquals(
            listOf(
                ToolEntry.BATCH_EXEC,
                ToolEntry.PROXY,
                ToolEntry.SSH_KEY,
                ToolEntry.AI_WORKSPACE,
                ToolEntry.FILE_SYNC,
                ToolEntry.SERVER_SETTINGS,
                ToolEntry.APPEARANCE,
                ToolEntry.LANGUAGE,
                ToolEntry.APP_LOCK,
                ToolEntry.DIAGNOSTICS,
            ),
            rows,
        )
        assertTrue(ToolEntry.FILE_SYNC in ToolsCatalog.rows(ToolSection.FILE_SYNC))
        assertTrue(ToolEntry.SERVER_SETTINGS in ToolsCatalog.rows(ToolSection.SERVER))
    }

    @Test
    fun `unavailable remote rows carry an honest reason`() {
        val inventory = ToolsInventory()
        for (entry in listOf(ToolEntry.BATCH_EXEC, ToolEntry.DOCKER, ToolEntry.MONITOR, ToolEntry.LOGS)) {
            val gate = ToolsCatalog.gate(entry, inventory)
            assertTrue(gate is ActionGate.Disabled)
            assertTrue((gate as ActionGate.Disabled).reason.isNotBlank())
        }
    }
}
