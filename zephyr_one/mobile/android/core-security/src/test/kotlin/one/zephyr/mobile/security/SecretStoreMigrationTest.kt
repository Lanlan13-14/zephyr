package one.zephyr.mobile.security

import java.security.MessageDigest
import javax.crypto.AEADBadTagException
import one.zephyr.mobile.model.SecretRef
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SecretStoreMigrationTest {

    @Test
    fun `journal scope match requires the complete binding identity`() {
        val store = SecretStore(
            MemorySecretBlobStore(),
            SecretStore.SecretScope("server-1", "alice", "device-1", "generation-1"),
            cipher = FakeSecretCipher(),
        )

        assertTrue(store.matchesScope("server-1", "alice", "device-1", "generation-1"))
        assertFalse(store.matchesScope("server-2", "alice", "device-1", "generation-1"))
        assertFalse(store.matchesScope("server-1", "bob", "device-1", "generation-1"))
        assertFalse(store.matchesScope("server-1", "alice", "device-2", "generation-1"))
        assertFalse(store.matchesScope("server-1", "alice", "device-1", "generation-2"))
    }

    @Test
    fun `owned refs expose only the exact account generation`() {
        val blobs = MemorySecretBlobStore()
        val cipher = FakeSecretCipher()
        val first = SecretStore(blobs, scope("alice", "generation-1"), cipher = cipher)
        val second = SecretStore(blobs, scope("alice", "generation-2"), cipher = cipher)
        val firstRef = SecretRef.of("connection", "hostile/id", "password")
        val secondRef = SecretRef.of("connection", "other", "password")
        first.put(firstRef, byteArrayOf(1))
        second.put(secondRef, byteArrayOf(2))

        assertEquals(listOf(firstRef), first.ownedRefs())
        assertEquals(listOf(secondRef), second.ownedRefs())
    }

    @Test
    fun `entity purge is exact for hostile ids and isolated by account generation`() {
        val blobs = MemorySecretBlobStore()
        val cipher = FakeSecretCipher()
        val alice = scope("alice", "generation-1")
        val aliceNext = scope("alice", "generation-2")
        val bob = scope("bob", "generation-1")
        val aliceStore = SecretStore(blobs, alice, cipher = cipher)
        val aliceNextStore = SecretStore(blobs, aliceNext, cipher = cipher)
        val bobStore = SecretStore(blobs, bob, cipher = cipher)
        val parent = SecretRef.of("connection", "abc", "password")
        val child = SecretRef.of("connection", "abc/child", "password")

        aliceStore.put(parent, "alice-parent".toByteArray())
        aliceStore.put(child, "alice-child".toByteArray())
        aliceNextStore.put(parent, "alice-next".toByteArray())
        bobStore.put(parent, "bob-parent".toByteArray())

        aliceStore.removeEntity("connection", "abc")

        assertNull(aliceStore.get(parent))
        assertSecret("alice-child", aliceStore.get(child))
        assertSecret("alice-next", aliceNextStore.get(parent))
        assertSecret("bob-parent", bobStore.get(parent))
    }

    @Test
    fun `scoped slash ref is migrated to structured ref after authenticated read`() {
        val blobs = MemorySecretBlobStore()
        val cipher = FakeSecretCipher()
        val scope = scope("alice", "generation-1")
        val store = SecretStore(blobs, scope, cipher = cipher)
        val legacy = SecretRef("connection/abc/child/password")
        val canonical = legacy.canonical()
        val oldPhysical = SecretRef(secretStorePhysicalPrefix(scope) + legacy.value)
        val newPhysical = SecretRef(secretStorePhysicalPrefix(scope) + canonical.value)
        val plaintext = "migrate-me".toByteArray()
        blobs.write(
            oldPhysical,
            cipher.seal(secretStoreAlias(scope), plaintext, currentAad(scope, legacy)),
        )

        assertSecret("migrate-me", store.get(canonical))

        assertNull(blobs.read(oldPhysical))
        assertTrue(blobs.read(newPhysical) != null)
    }

    @Test
    fun `unscoped legacy ref is deleted only after account aad proves ownership`() {
        val blobs = MemorySecretBlobStore()
        val cipher = FakeSecretCipher()
        val aliceScope = scope("alice", "generation-1")
        val bobScope = scope("bob", "generation-1")
        val aliceStore = SecretStore(blobs, aliceScope, cipher = cipher)
        val bobStore = SecretStore(blobs, bobScope, cipher = cipher)
        val legacy = SecretRef("connection/abc/child/password")
        val canonical = legacy.canonical()
        val plaintext = "legacy-alice".toByteArray()
        blobs.write(
            legacy,
            cipher.seal(
                KeystoreMasterKey.ALIAS_SECRET_STORE,
                plaintext,
                legacyAad(aliceScope, legacy),
            ),
        )

        bobStore.removeEntity("connection", "abc/child")
        assertTrue(blobs.read(legacy) != null)

        assertSecret("legacy-alice", aliceStore.get(canonical))
        assertNull(blobs.read(legacy))
        assertTrue(
            blobs.read(SecretRef(secretStorePhysicalPrefix(aliceScope) + canonical.value)) != null,
        )
        assertFalse(bobStore.has(canonical))
    }

    @Test
    fun `legacy entity purge does not consume a slash separated child id`() {
        val blobs = MemorySecretBlobStore()
        val cipher = FakeSecretCipher()
        val scope = scope("alice", "generation-1")
        val store = SecretStore(blobs, scope, cipher = cipher)
        val parent = SecretRef("connection/abc/password")
        val child = SecretRef("connection/abc/child/password")
        blobs.write(
            parent,
            cipher.seal(KeystoreMasterKey.ALIAS_SECRET_STORE, byteArrayOf(1), legacyAad(scope, parent)),
        )
        blobs.write(
            child,
            cipher.seal(KeystoreMasterKey.ALIAS_SECRET_STORE, byteArrayOf(2), legacyAad(scope, child)),
        )

        store.removeEntity("connection", "abc")

        assertNull(blobs.read(parent))
        assertTrue(blobs.read(child) != null)
    }

    @Test
    fun `device identity direct blobs migrate without rotating key material`() {
        val blobs = MemorySecretBlobStore()
        val canonical = SecretRef.of("__deviceIdentity", "scope/digest", "mlkemPrivateKey")
        val legacy = SecretRef(requireNotNull(canonical.legacyValueOrNull()))
        val keyMaterial = byteArrayOf(1, 2, 3, 4)
        blobs.write(legacy, keyMaterial)

        val migrated = blobs.readMigratingLegacyRef(canonical)

        assertArrayEquals(keyMaterial, migrated)
        assertNull(blobs.read(legacy))
        assertArrayEquals(keyMaterial, blobs.read(canonical))
    }

    private fun scope(userId: String, generation: String) =
        SecretStore.SecretScope("server", userId, "device", generation)

    private fun currentAad(scope: SecretStore.SecretScope, ref: SecretRef): ByteArray =
        (
            "zephyr-one-secretstore-v1\u0000" + scope.serverId +
                "\u0000" + scope.userId +
                "\u0000" + scope.deviceId +
                "\u0000" + scope.generation +
                "\u0000" + ref.value
            ).toByteArray(Charsets.UTF_8)

    private fun legacyAad(scope: SecretStore.SecretScope, ref: SecretRef): ByteArray =
        (
            "zephyr-one-secretstore-v1\u0000" + scope.serverId +
                "\u0000" + scope.userId +
                "\u0000" + scope.deviceId +
                "\u0000" + ref.value
            ).toByteArray(Charsets.UTF_8)

    private fun assertSecret(expected: String, actual: ByteArray?) {
        requireNotNull(actual)
        try {
            assertArrayEquals(expected.toByteArray(), actual)
        } finally {
            actual.fill(0)
        }
    }
}

private class MemorySecretBlobStore : SecretBlobStore {
    private val values = linkedMapOf<String, ByteArray>()

    override fun read(ref: SecretRef): ByteArray? = values[ref.value]?.copyOf()

    override fun write(ref: SecretRef, blob: ByteArray) {
        values[ref.value] = blob.copyOf()
    }

    override fun delete(ref: SecretRef) {
        values.remove(ref.value)?.fill(0)
    }

    override fun listRefs(): List<SecretRef> = values.keys.map(::SecretRef)

    override fun deleteAll() {
        values.values.forEach { it.fill(0) }
        values.clear()
    }
}

private class FakeSecretCipher : SecretCipher {
    override fun seal(alias: String, plaintext: ByteArray, aad: ByteArray): ByteArray {
        val tag = tag(alias, aad)
        return ByteArray(tag.size + plaintext.size).also { blob ->
            tag.copyInto(blob)
            plaintext.copyInto(blob, tag.size)
        }
    }

    override fun open(alias: String, blob: ByteArray, aad: ByteArray): ByteArray {
        val expected = tag(alias, aad)
        if (blob.size < expected.size || !blob.copyOfRange(0, expected.size).contentEquals(expected)) {
            throw AEADBadTagException("AAD mismatch")
        }
        return blob.copyOfRange(expected.size, blob.size)
    }

    override fun deleteKey(alias: String) = Unit

    private fun tag(alias: String, aad: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").run {
            update(alias.toByteArray(Charsets.UTF_8))
            update(0)
            digest(aad)
        }
}
