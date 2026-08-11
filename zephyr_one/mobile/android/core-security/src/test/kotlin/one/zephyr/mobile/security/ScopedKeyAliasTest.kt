package one.zephyr.mobile.security

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ScopedKeyAliasTest {

    @Test
    fun `secret store alias is stable and account scoped`() {
        val alice = SecretStore.SecretScope("server", "alice", "device")
        val bob = alice.copy(userId = "bob")
        val replacement = alice.copy(generation = "next-binding")

        assertEquals(secretStoreAlias(alice), secretStoreAlias(alice.copy()))
        assertNotEquals(secretStoreAlias(alice), secretStoreAlias(bob))
        assertNotEquals(secretStoreAlias(alice), secretStoreAlias(replacement))
        assertFalse(secretStoreAlias(alice).contains("alice"))
    }

    @Test
    fun `device key aliases bind server account and this device`() {
        val thisDevice = DeviceIdentity.Scope("server", "alice", "device-1")
        val otherDevice = thisDevice.copy(deviceId = "device-2")
        val otherAccount = thisDevice.copy(userId = "bob")

        val alias = deviceIdentityAlias(DeviceIdentity.ALIAS_SIGNING, thisDevice)
        assertNotEquals(alias, deviceIdentityAlias(DeviceIdentity.ALIAS_SIGNING, otherDevice))
        assertNotEquals(alias, deviceIdentityAlias(DeviceIdentity.ALIAS_SIGNING, otherAccount))
        assertFalse(alias.contains("alice"))
        assertFalse(alias.contains("device-1"))
    }
}
