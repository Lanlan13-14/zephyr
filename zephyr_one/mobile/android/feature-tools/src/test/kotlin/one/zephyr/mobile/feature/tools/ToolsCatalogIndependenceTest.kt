package one.zephyr.mobile.feature.tools

import one.zephyr.mobile.model.ActionGate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolsCatalogIndependenceTest {

    @Test
    fun `ai backup and device settings stay allowed without a main end`() {
        val inventory = ToolsInventory(online = false, aiRuntimeAvailable = false, role = ServerRole.USER)
        assertEquals(ActionGate.Allowed, ToolsCatalog.gate(ToolEntry.AI_WORKSPACE, inventory))
        assertEquals(ActionGate.Allowed, ToolsCatalog.gate(ToolEntry.BACKUP_RESTORE, inventory))
        assertEquals(ActionGate.Allowed, ToolsCatalog.gate(ToolEntry.APPEARANCE, inventory))
        assertEquals(ActionGate.Allowed, ToolsCatalog.gate(ToolEntry.LANGUAGE, inventory))
        assertEquals(ActionGate.Allowed, ToolsCatalog.gate(ToolEntry.FILE_SYNC, inventory))
        assertEquals(ActionGate.Allowed, ToolsCatalog.gate(ToolEntry.CLIENT_TOKEN, inventory))
    }

    @Test
    fun `batch still needs a local executable ssh host`() {
        val empty = ToolsInventory()
        val gate = ToolsCatalog.gate(ToolEntry.BATCH_EXEC, empty)
        assertTrue(gate is ActionGate.Disabled)
        val ready = ToolsInventory(executableSshCount = 1)
        assertEquals(ActionGate.Allowed, ToolsCatalog.gate(ToolEntry.BATCH_EXEC, ready))
    }
}
