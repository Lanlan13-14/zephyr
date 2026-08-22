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
    fun `device key aliases bind server and this device before the account is known`() {
        val thisDevice = DeviceIdentity.Scope("server", "alice", "device-1")
        val otherDevice = thisDevice.copy(deviceId = "device-2")
        val otherServer = thisDevice.copy(serverId = "other-server")
        val otherAccount = thisDevice.copy(userId = "bob")

        val alias = deviceIdentityAlias(DeviceIdentity.ALIAS_SIGNING, thisDevice)
        assertNotEquals(alias, deviceIdentityAlias(DeviceIdentity.ALIAS_SIGNING, otherDevice))
        assertNotEquals(alias, deviceIdentityAlias(DeviceIdentity.ALIAS_SIGNING, otherServer))
        // Enrollment mints the key before userId exists, so the live alias cannot
        // mix the account into the digest. The previous digest remains a read
        // fallback for already-bound devices.
        assertEquals(alias, deviceIdentityAlias(DeviceIdentity.ALIAS_SIGNING, otherAccount))
        assertNotEquals(
            alias,
            deviceIdentityLegacyAlias(DeviceIdentity.ALIAS_SIGNING, thisDevice),
        )
        assertNotEquals(
            deviceIdentityLegacyAlias(DeviceIdentity.ALIAS_SIGNING, thisDevice),
            deviceIdentityLegacyAlias(DeviceIdentity.ALIAS_SIGNING, otherAccount),
        )
        assertFalse(alias.contains("alice"))
        assertFalse(alias.contains("device-1"))
    }
}
