package one.zephyr.mobile.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.model.SecretEnvelope
import one.zephyr.mobile.model.SecretRef
import one.zephyr.mobile.model.SyncChange
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SecretReconciliationTest {

    @Test
    fun `remote false presence plans the exact hostile-id refs as absent`() {
        val change = change(
            entityId = "folder/child:2",
            payload = payload(hasPassword = false, hasPrivateKey = false),
        )

        val prepared = prepareSecrets(change, opener = null)

        assertEquals(mapOf("password" to false, "privateKey" to false), prepared.states)
        val passwordRef = SecretRef.of("connection", "folder/child:2", "password")
        val neighbour = SecretRef.of("connection", "folder", "child:2/password")
        assertTrue(shouldRemoveSnapshotSecret(passwordRef, emptySet(), emptySet()))
        assertNotEquals(passwordRef, neighbour)
    }

    @Test
    fun `true presence without an envelope fails closed`() {
        val error = expectSecretFailure {
            prepareSecrets(
                change(payload = payload(hasPassword = true, hasPrivateKey = false)),
                opener = EnvelopeOpener { _, _ -> "unused".toByteArray() },
            )
        }

        assertEquals(SecretReconciliationFailure.MISSING_ENVELOPE, error.failure)
    }

    @Test
    fun `a missing registry presence flag cannot silently clear a stored secret`() {
        val error = expectSecretFailure {
            prepareSecrets(
                change(
                    payload = JsonObject(
                        mapOf(
                            "ownerUserId" to JsonPrimitive("user-1"),
                            "name" to JsonPrimitive("host"),
                            "hasPrivateKey" to JsonPrimitive(false),
                        ),
                    ),
                ),
                opener = null,
            )
        }

        assertEquals(SecretReconciliationFailure.INVALID_PRESENCE, error.failure)
    }

    @Test
    fun `an envelope that cannot be opened fails the complete page plan`() {
        val error = expectSecretFailure {
            prepareSecrets(
                change(
                    payload = payload(hasPassword = true, hasPrivateKey = false),
                    envelopes = mapOf("password" to envelope()),
                ),
                opener = EnvelopeOpener { _, _ -> null },
            )
        }

        assertEquals(SecretReconciliationFailure.ENVELOPE_REJECTED, error.failure)
    }

    @Test
    fun `an envelope opener exception is normalized and fails closed`() {
        val error = expectSecretFailure {
            prepareSecrets(
                change(
                    payload = payload(hasPassword = true, hasPrivateKey = false),
                    envelopes = mapOf("password" to envelope()),
                ),
                opener = EnvelopeOpener { _, _ -> error("device unwrap failed") },
            )
        }

        assertEquals(SecretReconciliationFailure.ENVELOPE_REJECTED, error.failure)
    }

    @Test
    fun `remote clear plans durable clear intents for every declared absent secret`() {
        val change = change(payload = payload(hasPassword = false, hasPrivateKey = false))
        val secrets = prepareSecrets(change, opener = null)
        try {
            val mutations = planPageSecretMutations(
                changes = listOf(change),
                page = ApplicablePage(setOf(0), mapOf(0 to secrets)),
            )

            assertEquals(2, mutations.size)
            assertTrue(mutations.all { it is PlannedSecretMutation.Clear })
            assertEquals(
                setOf("password", "privateKey"),
                mutations.mapNotNull { it.ref.partsOrNull()?.fieldName }.toSet(),
            )
        } finally {
            secrets.close()
        }
    }

    @Test
    fun `delete plans durable clear intents even without payload presence flags`() {
        val deletion = change(
            payload = JsonObject(emptyMap()),
            action = SyncAction.DELETE,
            tombstone = JsonObject(mapOf("ownerUserId" to JsonPrimitive("user-1"))),
        )

        val mutations = planPageSecretMutations(
            changes = listOf(deletion),
            page = ApplicablePage(setOf(0), emptyMap()),
        )

        assertEquals(2, mutations.size)
        assertTrue(mutations.all { it is PlannedSecretMutation.Clear })
    }

    @Test
    fun `later clear coalesces an earlier put for the same ref`() {
        val put = change(
            payload = payload(hasPassword = true, hasPrivateKey = false),
            envelopes = mapOf("password" to envelope()),
        )
        val clear = change(
            payload = payload(hasPassword = false, hasPrivateKey = false),
            revision = 3,
        )
        val first = prepareSecrets(put, EnvelopeOpener { _, _ -> "secret".toByteArray() })
        val second = prepareSecrets(clear, opener = null)
        try {
            val mutations = planPageSecretMutations(
                changes = listOf(put, clear),
                page = ApplicablePage(setOf(0, 1), mapOf(0 to first, 1 to second)),
            )

            assertEquals(2, mutations.size)
            assertTrue(mutations.all { it is PlannedSecretMutation.Clear })
        } finally {
            first.close()
            second.close()
        }
    }

    @Test
    fun `bootstrap temp refs isolate generations and hostile ids`() {
        val parent = bootstrapSecretRef(7, "connection", "abc", "password")
        val child = bootstrapSecretRef(7, "connection", "abc/child", "password")
        val nextGeneration = bootstrapSecretRef(8, "connection", "abc", "password")

        assertNotEquals(parent, child)
        assertNotEquals(parent, nextGeneration)
        assertEquals("__bootstrapSecret", child.partsOrNull()?.entityType)
        assertEquals("password", child.partsOrNull()?.fieldName)
    }

    @Test
    fun `bootstrap cleanup deletes refs outside the snapshot`() {
        val stale = SecretRef.of("connection", "stale/id", "password")

        assertTrue(shouldRemoveSnapshotSecret(stale, desiredRefs = emptySet(), pendingEntities = emptySet()))
    }

    @Test
    fun `bootstrap cleanup protects every ref of a pending local entity`() {
        val pending = SecretRef.of("connection", "local/id", "privateKey")

        assertFalse(
            shouldRemoveSnapshotSecret(
                pending,
                desiredRefs = emptySet(),
                pendingEntities = setOf(EntityKey("connection", "local/id")),
            ),
        )
    }

    @Test
    fun `corrupt stored presence cannot be interpreted as a remote clear`() {
        val error = expectSecretFailure {
            requirePresenceValue(
                JsonObject(mapOf("hasPassword" to JsonPrimitive("false"))),
                "password",
            )
        }

        assertEquals(SecretReconciliationFailure.INVALID_PRESENCE, error.failure)
    }

    private fun change(
        entityId: String = "c-1",
        payload: JsonObject,
        envelopes: Map<String, SecretEnvelope> = emptyMap(),
        action: SyncAction = SyncAction.UPSERT,
        tombstone: JsonObject? = null,
        revision: Long = 2,
    ) = SyncChange(
        changeSeq = 5,
        entityType = "connection",
        entityId = entityId,
        action = action,
        revision = revision,
        changedAt = 10,
        fieldMask = listOf("name"),
        payload = payload,
        secretEnvelopes = envelopes,
        tombstone = tombstone,
    )

    private fun payload(hasPassword: Boolean, hasPrivateKey: Boolean) = JsonObject(
        mapOf(
            "ownerUserId" to JsonPrimitive("user-1"),
            "name" to JsonPrimitive("host"),
            "hasPassword" to JsonPrimitive(hasPassword),
            "hasPrivateKey" to JsonPrimitive(hasPrivateKey),
        ),
    )

    private fun envelope() = SecretEnvelope(
        v = 1,
        alg = "ML-KEM-768+HKDF-SHA256+AES-256-GCM",
        kem = "ML-KEM-768",
        aead = "AES-256-GCM",
        ct = "Y3Q=",
        iv = "aXY=",
        tag = "dGFn",
        data = "ZGF0YQ==",
        aad = "YWFk",
        keyVersion = 1,
        entityRevision = 2,
    )

    private fun expectSecretFailure(block: () -> Unit): SecretReconciliationException = try {
        block()
        fail("expected SecretReconciliationException")
        error("unreachable")
    } catch (failure: SecretReconciliationException) {
        failure
    }
}
