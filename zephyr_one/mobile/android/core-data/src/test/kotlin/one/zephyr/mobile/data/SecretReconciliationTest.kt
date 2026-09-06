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
                change(
                    payload = payload(hasPassword = true, hasPrivateKey = false),
                    fieldMask = emptyList(),
                ),
                opener = EnvelopeOpener { _, _ -> "unused".toByteArray() },
            )
        }

        assertEquals(SecretReconciliationFailure.MISSING_ENVELOPE, error.failure)
    }

    @Test
    fun `an already-mirrored row with empty mask and no envelope does not freeze the cursor`() {
        val change = change(
            payload = payload(hasPassword = true, hasPrivateKey = false),
            fieldMask = emptyList(),
        )
        val secrets = prepareSecrets(
            change,
            opener = EnvelopeOpener { _, _ -> error("must not open") },
            allowMissingEnvelope = true,
        )
        try {
            assertEquals(true, secrets.states.getValue("password"))
            assertTrue(secrets.values["password"] == null)
            val mutations = planPageSecretMutations(
                changes = listOf(change),
                page = ApplicablePage(setOf(0), mapOf(0 to secrets)),
            )
            assertTrue(mutations.none { it.ref.partsOrNull()?.fieldName == "password" && it is PlannedSecretMutation.Put })
        } finally {
            secrets.close()
        }
    }

    @Test
    fun `live seq50 name-only page with empty decoded mask still plans without a password put`() {
        val change = change(
            payload = JsonObject(
                mapOf(
                    "ownerUserId" to JsonPrimitive("8f9d1961-1fbb-436c-ab4a-09aaf7c42bce"),
                    "name" to JsonPrimitive("home1"),
                    "hasPassword" to JsonPrimitive(true),
                    "hasPrivateKey" to JsonPrimitive(false),
                ),
            ),
            fieldMask = emptyList(),
        )
        val secrets = prepareSecrets(
            change,
            opener = EnvelopeOpener { _, _ -> error("must not open") },
            allowMissingEnvelope = true,
        )
        try {
            val mutations = planPageSecretMutations(
                changes = listOf(change),
                page = ApplicablePage(setOf(0), mapOf(0 to secrets)),
            )
            assertTrue(mutations.none { it is PlannedSecretMutation.Put })
        } finally {
            secrets.close()
        }
    }

    @Test
    fun `live name-only page with presence and no envelope does not freeze the cursor`() {
        val secrets = prepareSecrets(
            change(
                payload = JsonObject(
                    mapOf(
                        "ownerUserId" to JsonPrimitive("8f9d1961-1fbb-436c-ab4a-09aaf7c42bce"),
                        "name" to JsonPrimitive("home1"),
                        "hasPassword" to JsonPrimitive(true),
                        "hasPrivateKey" to JsonPrimitive(false),
                    ),
                ),
                fieldMask = listOf("name"),
            ),
            opener = EnvelopeOpener { _, _ -> error("must not open") },
        )
        try {
            assertEquals(true, secrets.states.getValue("password"))
            assertEquals(false, secrets.states.getValue("privateKey"))
            assertTrue(secrets.values["password"] == null)
        } finally {
            secrets.close()
        }
    }

    @Test
    fun `incremental name patch without a local secret does not freeze the cursor`() {
        val secrets = prepareSecrets(
            change(
                payload = payload(hasPassword = true, hasPrivateKey = false),
                envelopes = mapOf("password" to envelope()),
                fieldMask = listOf("name"),
            ),
            opener = EnvelopeOpener { _, _ -> null },
        )
        try {
            assertEquals(true, secrets.states.getValue("password"))
            assertTrue(secrets.values["password"] == null)
        } finally {
            secrets.close()
        }
    }

    @Test
    fun `incremental presence without an envelope reuses a retained local secret`() {
        val retained = "s3cret".toByteArray()
        val secrets = prepareSecrets(
            change(payload = payload(hasPassword = true, hasPrivateKey = false)),
            opener = EnvelopeOpener { _, _ -> error("must not open") },
            retainedSecrets = mapOf("password" to retained),
        )
        try {
            assertEquals("s3cret", secrets.values.getValue("password").decodeToString())
            assertEquals(true, secrets.states.getValue("password"))
            assertEquals(false, secrets.states.getValue("privateKey"))
        } finally {
            secrets.close()
            retained.fill(0)
        }
    }

    @Test
    fun `a fresh envelope still wins over a retained local secret`() {
        val retained = "stale".toByteArray()
        val secrets = prepareSecrets(
            change(
                payload = payload(hasPassword = true, hasPrivateKey = false),
                envelopes = mapOf("password" to envelope()),
            ),
            opener = EnvelopeOpener { _, _ -> "fresh".toByteArray() },
            retainedSecrets = mapOf("password" to retained),
        )
        try {
            assertEquals("fresh", secrets.values.getValue("password").decodeToString())
        } finally {
            secrets.close()
            retained.fill(0)
        }
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
                    fieldMask = emptyList(),
                ),
                opener = EnvelopeOpener { _, _ -> null },
            )
        }

        assertEquals(SecretReconciliationFailure.ENVELOPE_REJECTED, error.failure)
    }

    @Test
    fun `opener SecretReconciliationException keeps a retained secret on a name patch`() {
        val retained = "local-secret".toByteArray()
        val secrets = prepareSecrets(
            change(
                payload = payload(hasPassword = true, hasPrivateKey = false),
                envelopes = mapOf("password" to envelope()),
                fieldMask = listOf("name"),
            ),
            opener = EnvelopeOpener { _, _ ->
                throw SecretReconciliationException(SecretReconciliationFailure.ENVELOPE_REJECTED)
            },
            retainedSecrets = mapOf("password" to retained),
        )
        try {
            assertEquals("local-secret", secrets.values.getValue("password").decodeToString())
        } finally {
            secrets.close()
            retained.fill(0)
        }
    }

    @Test
    fun `a rejected envelope keeps a retained local secret instead of freezing the page`() {
        val retained = "local-secret".toByteArray()
        val secrets = prepareSecrets(
            change(
                payload = payload(hasPassword = true, hasPrivateKey = false),
                envelopes = mapOf("password" to envelope()),
            ),
            opener = EnvelopeOpener { _, _ -> null },
            retainedSecrets = mapOf("password" to retained),
        )
        try {
            assertEquals("local-secret", secrets.values.getValue("password").decodeToString())
            assertEquals(true, secrets.states.getValue("password"))
        } finally {
            secrets.close()
            retained.fill(0)
        }
    }

    @Test
    fun `an envelope opener exception keeps a retained local secret`() {
        val retained = "local-secret".toByteArray()
        val secrets = prepareSecrets(
            change(
                payload = payload(hasPassword = true, hasPrivateKey = false),
                envelopes = mapOf("password" to envelope()),
            ),
            opener = EnvelopeOpener { _, _ -> error("device unwrap failed") },
            retainedSecrets = mapOf("password" to retained),
        )
        try {
            assertEquals("local-secret", secrets.values.getValue("password").decodeToString())
        } finally {
            secrets.close()
            retained.fill(0)
        }
    }

    @Test
    fun `an envelope opener exception is normalized and fails closed`() {
        val error = expectSecretFailure {
            prepareSecrets(
                change(
                    payload = payload(hasPassword = true, hasPrivateKey = false),
                    envelopes = mapOf("password" to envelope()),
                    fieldMask = emptyList(),
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
        fieldMask: List<String> = listOf("name"),
    ) = SyncChange(
        changeSeq = 5,
        entityType = "connection",
        entityId = entityId,
        action = action,
        revision = revision,
        changedAt = 10,
        fieldMask = fieldMask,
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

    // ---- bootstrap snapshot semantics (§19: snapshot is self-contained; local mirror may
    // ------ retain secrets when the page cannot supply an openable envelope) ------------------

    @Test
    fun `snapshot full-replacement mask is never treated as an incremental secret patch`() {
        /* The live failure shape: a bootstrap page carries fieldMask = the full editable set,
         * which contains no secret fields, so isIncrementalSecretPatch(change) would answer
         * true and silently swallow an unopenable envelope. Snapshot semantics must disable
         * that fallback and fail closed with the true code when no retained secret exists. */
        val error = expectSecretFailure {
            prepareSecrets(
                change(
                    payload = payload(hasPassword = true, hasPrivateKey = false),
                    envelopes = mapOf("password" to envelope()),
                    fieldMask = listOf("name", "host", "port", "protocol", "username"),
                ),
                opener = EnvelopeOpener { _, _ -> null },
                snapshot = true,
            )
        }
        assertEquals(SecretReconciliationFailure.ENVELOPE_REJECTED, error.failure)
        assertEquals("connection", error.entityType)
        assertEquals("c-1", error.entityId)
        assertEquals("password", error.fieldName)
    }

    @Test
    fun `snapshot without an envelope and without a retained secret fails closed as missing envelope`() {
        val error = expectSecretFailure {
            prepareSecrets(
                change(
                    payload = payload(hasPassword = true, hasPrivateKey = false),
                    fieldMask = listOf("name", "host"),
                ),
                opener = EnvelopeOpener { _, _ -> error("must not open") },
                snapshot = true,
            )
        }
        assertEquals(SecretReconciliationFailure.MISSING_ENVELOPE, error.failure)
    }

    @Test
    fun `snapshot re-stage retains the local mirror secret when the envelope cannot be opened`() {
        /* The second-bootstrap repair path: the mirror already holds the password from the
         * first bootstrap, the re-staged page's envelope cannot be opened (stale AAD), and
         * the retained plaintext must keep the snapshot complete instead of failing staging. */
        val retained = "kept-local".toByteArray()
        val secrets = prepareSecrets(
            change(
                payload = payload(hasPassword = true, hasPrivateKey = false),
                envelopes = mapOf("password" to envelope()),
                fieldMask = listOf("name", "host", "port"),
            ),
            opener = EnvelopeOpener { _, _ -> null },
            retainedSecrets = mapOf("password" to retained),
            snapshot = true,
        )
        try {
            assertEquals("kept-local", secrets.values.getValue("password").decodeToString())
            assertEquals(true, secrets.states.getValue("password"))
        } finally {
            secrets.close()
            retained.fill(0)
        }
    }

    @Test
    fun `snapshot re-stage retains the local mirror secret when the envelope is absent`() {
        val retained = "kept-local".toByteArray()
        val secrets = prepareSecrets(
            change(
                payload = payload(hasPassword = true, hasPrivateKey = false),
                fieldMask = listOf("name", "host"),
            ),
            opener = EnvelopeOpener { _, _ -> error("must not open") },
            retainedSecrets = mapOf("password" to retained),
            snapshot = true,
        )
        try {
            assertEquals("kept-local", secrets.values.getValue("password").decodeToString())
        } finally {
            secrets.close()
            retained.fill(0)
        }
    }

    @Test
    fun `snapshot planner re-puts a retained value so promotion stays complete`() {
        val retained = "kept-local".toByteArray()
        val change = change(
            payload = payload(hasPassword = true, hasPrivateKey = false),
            envelopes = mapOf("password" to envelope()),
            fieldMask = listOf("name", "host"),
        )
        val secrets = prepareSecrets(
            change,
            opener = EnvelopeOpener { _, _ -> null },
            retainedSecrets = mapOf("password" to retained),
            snapshot = true,
        )
        try {
            val mutations = planBootstrapPageSecretMutations(
                generation = 77L,
                changes = listOf(change),
                prepared = mapOf(0 to secrets),
            )
            val put = mutations.filterIsInstance<PlannedSecretMutation.Put>().first()
            assertEquals("kept-local", put.plaintext.decodeToString())
            assertTrue(put.ref.canonical().value.contains("77"))
        } finally {
            secrets.close()
            retained.fill(0)
        }
    }

    @Test
    fun `incremental pages keep the pre-existing behavior without snapshot flag`() {
        /* Regression guard: the incremental fallback must remain byte-for-byte intact for
         * change-feed pages — this is exactly what PR #115/#116 established. */
        val secrets = prepareSecrets(
            change(
                payload = payload(hasPassword = true, hasPrivateKey = false),
                envelopes = mapOf("password" to envelope()),
                fieldMask = listOf("name"),
            ),
            opener = EnvelopeOpener { _, _ -> null },
        )
        try {
            assertEquals(true, secrets.states.getValue("password"))
            assertTrue(secrets.values["password"] == null)
        } finally {
            secrets.close()
        }
    }
}
