package one.zephyr.mobile.app.binding

import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.model.AccountBinding
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LegacyAccountDatabaseMigrationTest {

    @Test
    fun `matching completed marker uses existing scoped database`() {
        val expected = LegacyAccountDatabaseMigration.marker(binding())

        assertEquals(
            LegacyAccountMigrationDecision.Ready,
            LegacyAccountDatabaseMigration.decide(expected, expected, pendingWriteCount = 0),
        )
    }

    @Test
    fun `missing marker requires server bootstrap instead of plaintext import`() {
        val expected = LegacyAccountDatabaseMigration.marker(binding())

        assertEquals(
            LegacyAccountMigrationDecision.RequiresBootstrap,
            LegacyAccountDatabaseMigration.decide(null, expected, pendingWriteCount = 0),
        )
    }

    @Test
    fun `pending legacy writes block even when an old marker matches`() {
        val expected = LegacyAccountDatabaseMigration.marker(binding())

        val decision = LegacyAccountDatabaseMigration.decide(expected, expected, pendingWriteCount = 3)

        assertEquals(LegacyAccountMigrationDecision.BlockedByPendingWrites(3), decision)
    }

    @Test
    fun `marker is opaque stable and generation specific`() {
        val first = LegacyAccountDatabaseMigration.marker(binding())
        val same = LegacyAccountDatabaseMigration.marker(binding())
        val rebound = LegacyAccountDatabaseMigration.marker(binding(boundAt = 101L))

        assertEquals(first, same)
        assertNotEquals(first, rebound)
        assertTrue(first.matches(Regex("[0-9a-f]{64}")))
        assertFalse(first.contains("alice"))
        assertFalse(first.contains("server"))
    }

    @Test
    fun `encrypted database readiness is generation bound`() {
        val first = binding(deviceId = "device-1")
        val rebound = binding(deviceId = "device-2")
        val stored = AccountDatabaseReadiness.marker(first)

        assertFalse(AccountDatabaseReadiness.requiresBootstrap(stored, first))
        assertTrue(AccountDatabaseReadiness.requiresBootstrap(stored, rebound))
        assertTrue(AccountDatabaseReadiness.requiresBootstrap(null, first))
    }

    private fun binding(boundAt: Long = 100L, deviceId: String = "device-1") = AccountBinding(
        serverProfileId = "server-1",
        userId = "alice",
        username = "Alice",
        deviceId = deviceId,
        deviceName = "Phone",
        tokenId = "token-1",
        tokenName = "Primary",
        state = BindingState.IDLE,
        registryHash = "registry",
        boundAt = boundAt,
        lastSyncAt = null,
        instanceEpoch = 7L,
    )
}
