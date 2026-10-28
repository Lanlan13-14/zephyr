package one.zephyr.mobile.data.db

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class SyncStateRowImportDecisionTest {

    @Test
    fun `new SyncStateRow defaults importDecisionRequired to false`() {
        val row = SyncStateRow(
            bindingKey = "bind-empty",
            bindingState = "BOUND_NEEDS_BOOTSTRAP",
            appliedCursor = 0,
            ackedCursor = 0,
            snapshotCursor = 0,
            lastAttemptAt = null,
            lastSuccessAt = null,
            lastErrorCode = null,
            lastErrorMessage = null,
            consecutiveFailures = 0,
            nextEligibleAt = null,
            registryHash = null,
        )
        assertFalse(row.importDecisionRequired)
    }

    @Test
    fun `migration three to four is additive`() {
        assertEquals(3, ZephyrDatabase.MIGRATION_3_4.startVersion)
        assertEquals(4, ZephyrDatabase.MIGRATION_3_4.endVersion)
    }
}
