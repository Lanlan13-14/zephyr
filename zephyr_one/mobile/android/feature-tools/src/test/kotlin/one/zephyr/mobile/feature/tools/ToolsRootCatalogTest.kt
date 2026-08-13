package one.zephyr.mobile.feature.tools

import one.zephyr.mobile.model.ActionGate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolsRootCatalogTest {

    @Test
    fun `all root catalog rows remain visible and ordered by section`() {
        val inventory = ToolsInventory()
        val rows = ToolsCatalog.sections().flatMap { ToolsCatalog.visibleRows(it, inventory) }

        assertEquals(ToolEntry.entries.toList(), rows)
        assertTrue(ToolEntry.CLIENT_TOKEN in ToolsCatalog.rows(ToolSection.FILE_SYNC))
        assertTrue(ToolEntry.SERVER_SETTINGS in ToolsCatalog.rows(ToolSection.SERVER))
        assertTrue(ToolEntry.BACKUP_RESTORE in ToolsCatalog.rows(ToolSection.SERVER))
        assertTrue(ToolEntry.RUNTIME_STATUS in ToolsCatalog.rows(ToolSection.SERVER))
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
