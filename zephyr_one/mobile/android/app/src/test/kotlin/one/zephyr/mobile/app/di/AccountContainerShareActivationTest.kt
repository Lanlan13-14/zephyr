package one.zephyr.mobile.app.di

import one.zephyr.mobile.feature.filesync.KeyValueEditor
import one.zephyr.mobile.feature.filesync.KeyValueStore
import one.zephyr.mobile.feature.filesync.PersistentShareStore
import one.zephyr.mobile.feature.filesync.SafShareGrants
import one.zephyr.mobile.feature.filesync.UriGrant
import one.zephyr.mobile.feature.filesync.UriPermissionStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountContainerShareActivationTest {

    @Test
    fun `prepared replacement preserves old grant until idempotent activation`() {
        val values = InMemoryKeyValueStore()
        val permissions = InMemoryUriPermissionStore()
        val tree = "content://documents/tree/account-a"
        val oldOwner = PersistentShareStore.ownerId("server", "user-a", "device", "generation-a")
        val nextOwner = PersistentShareStore.ownerId("server", "user-b", "device", "generation-b")
        val oldGrants = SafShareGrants(
            permissions = permissions,
            store = PersistentShareStore(values, ownerId = oldOwner),
            reconcileOnInit = false,
        )
        assertNotNull(
            oldGrants.authorize(
                profileId = "share-a",
                shareName = "Account A",
                treeUri = tree,
                requestWrite = true,
            ),
        )

        val nextGrants = SafShareGrants(
            permissions = permissions,
            store = PersistentShareStore(values, ownerId = nextOwner),
            reconcileOnInit = false,
        )
        val activation = AccountContainerShareActivation(nextGrants)

        assertEquals(listOf(UriGrant(tree, canRead = true, canWrite = true)), permissions.persisted())
        assertEquals(0, permissions.releaseCalls)

        activation.activate()

        assertTrue(permissions.persisted().isEmpty())
        assertEquals(1, permissions.releaseCalls)

        activation.activate()

        assertEquals(1, permissions.releaseCalls)
    }
}

private class InMemoryUriPermissionStore : UriPermissionStore {
    private val grants = LinkedHashMap<String, UriGrant>()
    var releaseCalls = 0
        private set

    override fun persisted(): List<UriGrant> = grants.values.toList()

    override fun takePersistable(uri: String, allowWrite: Boolean): Boolean {
        grants[uri] = UriGrant(uri, canRead = true, canWrite = allowWrite)
        return true
    }

    override fun releasePersistable(uri: String, releaseRead: Boolean, releaseWrite: Boolean): Boolean {
        releaseCalls += 1
        val existing = grants[uri] ?: return true
        val retained = existing.copy(
            canRead = existing.canRead && !releaseRead,
            canWrite = existing.canWrite && !releaseWrite,
        )
        if (!retained.canRead && !retained.canWrite) grants.remove(uri) else grants[uri] = retained
        return true
    }
}

private class InMemoryKeyValueStore : KeyValueStore {
    private val values = LinkedHashMap<String, Any>()

    override fun string(key: String): String? = values[key] as? String

    override fun boolean(key: String, defaultValue: Boolean): Boolean =
        values[key] as? Boolean ?: defaultValue

    @Suppress("UNCHECKED_CAST")
    override fun stringSet(key: String): Set<String> = values[key] as? Set<String> ?: emptySet()

    override fun keys(): Set<String> = values.keys.toSet()

    override fun edit(block: KeyValueEditor.() -> Unit): Boolean {
        val staged = LinkedHashMap(values)
        object : KeyValueEditor {
            override fun putString(key: String, value: String) {
                staged[key] = value
            }

            override fun putBoolean(key: String, value: Boolean) {
                staged[key] = value
            }

            override fun putStringSet(key: String, value: Set<String>) {
                staged[key] = value.toSet()
            }

            override fun remove(key: String) {
                staged.remove(key)
            }
        }.block()
        values.clear()
        values.putAll(staged)
        return true
    }
}
