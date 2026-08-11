package one.zephyr.mobile.app.di

import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.model.AccountBinding
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountDatabaseCompositionTest {

    @Test
    fun `database scope uses verified server user and binding generation`() {
        val binding = binding(boundAt = 100L)

        val scope = AccountContainer.databaseScopeOf(binding)

        assertEquals(binding.serverProfileId, scope.serverId)
        assertEquals(binding.userId, scope.userId)
        assertEquals(AccountContainer.generationOf(binding), scope.generation)
    }

    @Test
    fun `rebind changes database generation without changing account identity`() {
        val first = AccountContainer.databaseScopeOf(binding(boundAt = 100L))
        val rebound = AccountContainer.databaseScopeOf(binding(boundAt = 101L))

        assertEquals(first.serverId, rebound.serverId)
        assertEquals(first.userId, rebound.userId)
        assertNotEquals(first.generation, rebound.generation)
    }

    @Test
    fun `fresh device binding changes generation even when server timestamps collide`() {
        val first = AccountContainer.databaseScopeOf(binding(boundAt = 100L, deviceId = "device-1"))
        val rebound = AccountContainer.databaseScopeOf(binding(boundAt = 100L, deviceId = "device-2"))

        assertNotEquals(first.generation, rebound.generation)
        assertTrue(first.generation.matches(Regex("[0-9a-f]{64}")))
        assertTrue(rebound.generation.matches(Regex("[0-9a-f]{64}")))
    }

    private fun binding(boundAt: Long, deviceId: String = "device-1") = AccountBinding(
        serverProfileId = "server-1",
        userId = "user-1",
        username = "alice",
        deviceId = deviceId,
        deviceName = "Phone",
        tokenId = "token-1",
        tokenName = "Primary",
        state = BindingState.IDLE,
        registryHash = "registry",
        boundAt = boundAt,
        lastSyncAt = null,
        instanceEpoch = 4L,
    )
}
