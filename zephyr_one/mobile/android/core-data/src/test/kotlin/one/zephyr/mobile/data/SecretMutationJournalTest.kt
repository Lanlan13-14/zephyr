package one.zephyr.mobile.data

import java.security.MessageDigest
import javax.crypto.AEADBadTagException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import one.zephyr.mobile.data.db.SecretMutationJournalRow
import one.zephyr.mobile.data.db.SecretMutationJournalState
import one.zephyr.mobile.data.db.SecretMutationRetention
import one.zephyr.mobile.model.SecretRef
import one.zephyr.mobile.security.SecretBlobStore
import one.zephyr.mobile.security.SecretCipher
import one.zephyr.mobile.security.SecretStore
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SecretMutationJournalTest {

    @Test
    fun `commit fails closed until startup recovery completes`() = runTest {
        val fixture = fixture()
        val intent = fixture.journal.stageClear(PASSWORD)

        val error = expectFailure<SecretMutationJournalException> {
            fixture.journal.commit("op-1", listOf(intent), SecretMutationRetention.UNTIL_REMOTE_ACK) {}
        }

        assertTrue(error.message.orEmpty().contains("recovery"))
        assertTrue(fixture.persistence.all().isEmpty())
    }

    @Test
    fun `normal Room failure rolls SecretStore back and removes prepared journal`() = runTest {
        val fixture = fixture(initialSecrets = mapOf(PASSWORD to "old"))
        fixture.journal.recover()
        val intent = fixture.journal.stagePut(PASSWORD, "new".toByteArray())

        expectFailure<IllegalStateException> {
            fixture.journal.commit("op-1", listOf(intent), SecretMutationRetention.UNTIL_REMOTE_ACK) {
                error("Room write failed")
            }
        }

        assertSecret("old", fixture.secretStore, PASSWORD)
        assertTrue(fixture.persistence.all().isEmpty())
    }

    @Test
    fun `rollback cleanup failure is suppressed and leaves durable prepared state`() = runTest {
        val fixture = fixture(initialSecrets = mapOf(PASSWORD to "old"))
        fixture.journal.recover()
        fixture.persistence.deleteFailures = 1

        val original = expectFailure<IllegalStateException> {
            fixture.journal.commit(
                "op-1",
                listOf(fixture.journal.stagePut(PASSWORD, "new".toByteArray())),
                SecretMutationRetention.UNTIL_REMOTE_ACK,
            ) { error("original Room failure") }
        }

        assertEquals("original Room failure", original.message)
        assertEquals(1, original.suppressed.size)
        assertTrue(original.suppressed.single().message.orEmpty().contains("journal delete"))
        assertSecret("old", fixture.secretStore, PASSWORD)
        assertEquals(SecretMutationJournalState.PREPARED.name, fixture.persistence.all().single().state)
    }

    @Test
    fun `split operation batch rolls back as one unit`() = runTest {
        val fixture = fixture(
            initialSecrets = mapOf(PASSWORD to "old-password", PRIVATE_KEY to "old-key"),
        )
        fixture.journal.recover()

        expectFailure<IllegalStateException> {
            fixture.journal.commitBatch(
                operations = listOf(
                    SecretMutationOperation(
                        "op-replace",
                        listOf(fixture.journal.stagePut(PASSWORD, "new-password".toByteArray())),
                        SecretMutationRetention.UNTIL_REMOTE_ACK,
                    ),
                    SecretMutationOperation(
                        "op-clear",
                        listOf(fixture.journal.stageClear(PRIVATE_KEY)),
                        SecretMutationRetention.UNTIL_REMOTE_ACK,
                    ),
                ),
            ) { error("pending row write failed") }
        }

        assertSecret("old-password", fixture.secretStore, PASSWORD)
        assertSecret("old-key", fixture.secretStore, PRIVATE_KEY)
        assertTrue(fixture.persistence.all().isEmpty())
    }

    @Test
    fun `process death after prepare rolls old value back on startup`() = runTest {
        val persistence = MemoryJournalPersistence()
        val blobs = MemoryBlobStore()
        val first = fixture(
            persistence = persistence,
            blobs = blobs,
            initialSecrets = mapOf(PASSWORD to "old"),
            crashAt = SecretMutationJournalFaultPoint.AFTER_PREPARED,
        )
        first.journal.recover()

        expectCrash {
            first.journal.commit(
                "op-1",
                listOf(first.journal.stagePut(PASSWORD, "new".toByteArray())),
                SecretMutationRetention.UNTIL_REMOTE_ACK,
            ) {}
        }

        assertSecret("old", first.secretStore, PASSWORD)
        assertEquals(SecretMutationJournalState.PREPARED.name, persistence.all().single().state)

        val restarted = fixture(persistence = persistence, blobs = blobs)
        restarted.journal.recover()
        assertSecret("old", restarted.secretStore, PASSWORD)
        assertTrue(persistence.all().isEmpty())
    }

    @Test
    fun `partial multi-ref apply is fully rolled back after process death`() = runTest {
        val persistence = MemoryJournalPersistence()
        val blobs = MemoryBlobStore()
        val first = fixture(
            persistence = persistence,
            blobs = blobs,
            initialSecrets = mapOf(PASSWORD to "old-password", PRIVATE_KEY to "old-key"),
            crashAt = SecretMutationJournalFaultPoint.AFTER_SECRET_ROW_APPLIED,
        )
        first.journal.recover()

        expectCrash {
            first.journal.commit(
                "op-1",
                listOf(
                    first.journal.stagePut(PASSWORD, "new-password".toByteArray()),
                    first.journal.stagePut(PRIVATE_KEY, "new-key".toByteArray()),
                ),
                SecretMutationRetention.UNTIL_REMOTE_ACK,
            ) {}
        }

        assertSecret("new-password", first.secretStore, PASSWORD)
        assertSecret("old-key", first.secretStore, PRIVATE_KEY)

        val restarted = fixture(persistence = persistence, blobs = blobs)
        restarted.journal.recover()
        assertSecret("old-password", restarted.secretStore, PASSWORD)
        assertSecret("old-key", restarted.secretStore, PRIVATE_KEY)
        assertTrue(persistence.all().isEmpty())
    }

    @Test
    fun `Room committed mutation rolls forward after process death`() = runTest {
        val persistence = MemoryJournalPersistence()
        val blobs = MemoryBlobStore()
        val first = fixture(
            persistence = persistence,
            blobs = blobs,
            initialSecrets = mapOf(PASSWORD to "old"),
            crashAt = SecretMutationJournalFaultPoint.AFTER_ROOM_COMMITTED,
        )
        first.journal.recover()
        var businessCommitted = false

        expectCrash {
            first.journal.commit(
                "op-1",
                listOf(first.journal.stagePut(PASSWORD, "new".toByteArray())),
                SecretMutationRetention.UNTIL_REMOTE_ACK,
            ) { businessCommitted = true }
        }

        assertTrue(businessCommitted)
        assertEquals(SecretMutationJournalState.LOCAL_COMMITTED.name, persistence.all().single().state)

        val restarted = fixture(persistence = persistence, blobs = blobs)
        restarted.journal.recover()
        assertSecret("new", restarted.secretStore, PASSWORD)
        assertEquals(1, persistence.all().size)
    }

    @Test
    fun `newer clear remains authoritative after its ACK row is deleted`() = runTest {
        val persistence = MemoryJournalPersistence()
        val blobs = MemoryBlobStore()
        val fixture = fixture(persistence = persistence, blobs = blobs)
        fixture.journal.recover()
        fixture.journal.commit(
            "op-old",
            listOf(fixture.journal.stagePut(PASSWORD, "old".toByteArray())),
            SecretMutationRetention.UNTIL_REMOTE_ACK,
        ) {}
        fixture.journal.commit(
            "op-clear",
            listOf(fixture.journal.stageClear(PASSWORD)),
            SecretMutationRetention.UNTIL_REMOTE_ACK,
        ) {}

        val beforeAck = persistence.all().sortedBy { it.sequence }
        assertEquals(beforeAck[1].journalId, beforeAck[0].supersededByJournalId)
        assertNull(fixture.secretStore.get(PASSWORD))

        fixture.journal.finalizeRemote(listOf("op-clear")) {}
        val oldRow = persistence.all().single()
        assertTrue(oldRow.supersededByJournalId != null)

        fixture(persistence = persistence, blobs = blobs).journal.recover()
        assertNull(fixture.secretStore.get(PASSWORD))
    }

    @Test
    fun `folded multi-operation rows rebind then finalize without residue`() = runTest {
        val fixture = fixture()
        fixture.journal.recover()
        fixture.journal.commit(
            "op-first",
            listOf(fixture.journal.stagePut(PASSWORD, "first".toByteArray())),
            SecretMutationRetention.UNTIL_REMOTE_ACK,
        ) {}
        fixture.journal.commit(
            "op-second",
            listOf(fixture.journal.stagePut(PRIVATE_KEY, "second".toByteArray())),
            SecretMutationRetention.UNTIL_REMOTE_ACK,
        ) {}

        fixture.journal.rebindOperations(
            rebindings = listOf(SecretMutationOperationRebinding(listOf("op-second"), "op-first")),
            finalizedOperationIds = emptyList(),
        ) {}

        assertEquals(setOf("op-first"), fixture.persistence.all().map { it.operationId }.toSet())
        fixture.journal.finalizeRemote(listOf("op-first")) {}
        assertTrue(fixture.persistence.all().isEmpty())
        assertSecret("first", fixture.secretStore, PASSWORD)
        assertSecret("second", fixture.secretStore, PRIVATE_KEY)
    }

    @Test
    fun `partial remote ACK keeps unrelated rows retryable until their own ACK`() = runTest {
        val fixture = fixture()
        fixture.journal.recover()
        fixture.journal.commit(
            "op-password",
            listOf(fixture.journal.stagePut(PASSWORD, "password".toByteArray())),
            SecretMutationRetention.UNTIL_REMOTE_ACK,
        ) {}
        fixture.journal.commit(
            "op-key",
            listOf(fixture.journal.stagePut(PRIVATE_KEY, "key".toByteArray())),
            SecretMutationRetention.UNTIL_REMOTE_ACK,
        ) {}

        fixture.journal.finalizeRemote(listOf("op-password")) {}
        assertEquals(listOf("op-key"), fixture.persistence.all().map { it.operationId })

        fixture.journal.finalizeRemote(listOf("op-key")) {}
        assertTrue(fixture.persistence.all().isEmpty())
    }

    @Test
    fun `created then deleted local rows finalize without a synthetic remote operation`() = runTest {
        val fixture = fixture()
        fixture.journal.recover()
        fixture.journal.commit(
            "op-create",
            listOf(fixture.journal.stagePut(PASSWORD, "temporary".toByteArray())),
            SecretMutationRetention.UNTIL_REMOTE_ACK,
        ) {}
        fixture.journal.commit(
            "op-delete",
            listOf(fixture.journal.stageClear(PASSWORD)),
            SecretMutationRetention.UNTIL_REMOTE_ACK,
        ) {}

        fixture.journal.rebindOperations(
            rebindings = emptyList(),
            finalizedOperationIds = listOf("op-create", "op-delete"),
        ) {}

        assertTrue(fixture.persistence.all().isEmpty())
        assertNull(fixture.secretStore.get(PASSWORD))
    }

    @Test
    fun `failed remote finalization retains durable blobs for retry`() = runTest {
        val fixture = fixture()
        fixture.journal.recover()
        fixture.journal.commit(
            "op-1",
            listOf(fixture.journal.stagePut(PASSWORD, "retry".toByteArray())),
            SecretMutationRetention.UNTIL_REMOTE_ACK,
        ) {}

        expectFailure<IllegalStateException> {
            fixture.journal.finalizeRemote(listOf("op-1")) { error("pending delete failed") }
        }

        assertEquals(listOf("op-1"), fixture.persistence.all().map { it.operationId })
        fixture.journal.finalizeRemote(listOf("op-1")) {}
        assertTrue(fixture.persistence.all().isEmpty())
    }

    @Test
    fun `commit-only replacement does not expose retained local value after cleanup`() = runTest {
        val persistence = MemoryJournalPersistence()
        val blobs = MemoryBlobStore()
        val fixture = fixture(persistence = persistence, blobs = blobs)
        fixture.journal.recover()
        fixture.journal.commit(
            "local-op",
            listOf(fixture.journal.stagePut(PASSWORD, "local".toByteArray())),
            SecretMutationRetention.UNTIL_REMOTE_ACK,
        ) {}
        fixture.journal.commit(
            "remote-page",
            listOf(fixture.journal.stagePut(PASSWORD, "server".toByteArray())),
            SecretMutationRetention.COMMIT_ONLY,
        ) {}

        assertEquals(1, persistence.all().size)
        assertTrue(persistence.all().single().supersededByJournalId != null)

        fixture(persistence = persistence, blobs = blobs).journal.recover()
        assertSecret("server", fixture.secretStore, PASSWORD)
    }

    @Test
    fun `sequence is causal when every mutation has the same timestamp`() = runTest {
        val fixture = fixture(clock = { 7L })
        fixture.journal.recover()
        fixture.journal.commit(
            "op-1",
            listOf(fixture.journal.stagePut(PASSWORD, "one".toByteArray())),
            SecretMutationRetention.UNTIL_REMOTE_ACK,
        ) {}
        fixture.journal.commit(
            "op-2",
            listOf(fixture.journal.stagePut(PRIVATE_KEY, "two".toByteArray())),
            SecretMutationRetention.UNTIL_REMOTE_ACK,
        ) {}

        assertEquals(listOf(1L, 2L), fixture.persistence.all().map { it.sequence })
        assertEquals(listOf(7L, 7L), fixture.persistence.all().map { it.createdAt })
    }

    @Test
    fun `shared lock covers prepare through Room commit`() = runTest {
        val prepared = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var firstPause = true
        val fixture = fixture(
            faultInjector = SecretMutationJournalFaultInjector { point, _ ->
                if (point == SecretMutationJournalFaultPoint.AFTER_PREPARED && firstPause) {
                    firstPause = false
                    prepared.complete(Unit)
                    release.await()
                }
            },
        )
        fixture.journal.recover()

        val first = async {
            fixture.journal.commit(
                "op-1",
                listOf(fixture.journal.stagePut(PASSWORD, "one".toByteArray())),
                SecretMutationRetention.UNTIL_REMOTE_ACK,
            ) {}
        }
        prepared.await()
        val second = async {
            fixture.journal.commit(
                "op-2",
                listOf(fixture.journal.stagePut(PASSWORD, "two".toByteArray())),
                SecretMutationRetention.UNTIL_REMOTE_ACK,
            ) {}
        }
        runCurrent()

        assertFalse(second.isCompleted)
        assertEquals(listOf("op-1"), fixture.persistence.all().map { it.operationId })

        release.complete(Unit)
        first.await()
        second.await()
        assertSecret("two", fixture.secretStore, PASSWORD)
    }

    @Test
    fun `foreign binding journal aborts before touching SecretStore`() = runTest {
        val persistence = MemoryJournalPersistence()
        val correct = fixture(persistence = persistence, initialSecrets = mapOf(PASSWORD to "current"))
        val foreign = preparedRow(
            scope = SCOPE.copy(serverId = "other-server"),
            operationId = "foreign-op",
            ref = PASSWORD,
            sequence = 1,
        )
        persistence.insertAll(listOf(foreign))

        expectFailure<SecretMutationJournalException> { correct.journal.recover() }

        assertSecret("current", correct.secretStore, PASSWORD)
    }

    @Test
    fun `recovery can resume after dying during committed replay`() = runTest {
        val persistence = MemoryJournalPersistence()
        val blobs = MemoryBlobStore()
        val writer = fixture(persistence = persistence, blobs = blobs)
        writer.journal.recover()
        writer.journal.commit(
            "op-1",
            listOf(
                writer.journal.stagePut(PASSWORD, "password".toByteArray()),
                writer.journal.stagePut(PRIVATE_KEY, "key".toByteArray()),
            ),
            SecretMutationRetention.UNTIL_REMOTE_ACK,
        ) {}

        val crashingRecovery = fixture(
            persistence = persistence,
            blobs = blobs,
            crashAt = SecretMutationJournalFaultPoint.DURING_RECOVERY_ROW_APPLIED,
        )
        expectCrash { crashingRecovery.journal.recover() }

        val resumed = fixture(persistence = persistence, blobs = blobs)
        resumed.journal.recover()
        assertSecret("password", resumed.secretStore, PASSWORD)
        assertSecret("key", resumed.secretStore, PRIVATE_KEY)
    }

    @Test
    fun `startup recovery is idempotent after a retained remote operation`() = runTest {
        val persistence = MemoryJournalPersistence()
        val blobs = MemoryBlobStore()
        val writer = fixture(persistence = persistence, blobs = blobs)
        writer.journal.recover()
        writer.journal.commit(
            "op-1",
            listOf(writer.journal.stagePut(PASSWORD, "durable".toByteArray())),
            SecretMutationRetention.UNTIL_REMOTE_ACK,
        ) {}

        val restarted = fixture(persistence = persistence, blobs = blobs)
        restarted.journal.recover()
        restarted.journal.recover()

        assertSecret("durable", restarted.secretStore, PASSWORD)
        assertEquals(listOf("op-1"), persistence.all().map { it.operationId })
    }

    private fun fixture(
        persistence: MemoryJournalPersistence = MemoryJournalPersistence(),
        blobs: MemoryBlobStore = MemoryBlobStore(),
        initialSecrets: Map<SecretRef, String> = emptyMap(),
        clock: () -> Long = { 1L },
        crashAt: SecretMutationJournalFaultPoint? = null,
        faultInjector: SecretMutationJournalFaultInjector = SecretMutationJournalFaultInjector.NONE,
    ): Fixture {
        val secretStore = SecretStore(
            blobs,
            SecretStore.SecretScope(
                SCOPE.serverId,
                SCOPE.ownerUserId,
                SCOPE.deviceId,
                SCOPE.bindingGeneration,
            ),
            cipher = TestSecretCipher(),
        )
        initialSecrets.forEach { (ref, value) -> secretStore.put(ref, value.toByteArray()) }
        var ids = persistence.allBlockingSize()
        val crashingInjector = if (crashAt == null) {
            faultInjector
        } else {
            var crashed = false
            SecretMutationJournalFaultInjector { point, _ ->
                if (!crashed && point == crashAt) {
                    crashed = true
                    throw SimulatedSecretMutationProcessDeath()
                }
            }
        }
        val journal = SecretMutationJournal(
            persistence = persistence,
            secretStore = secretStore,
            scope = SCOPE,
            clock = clock,
            journalIdFactory = { "journal-${++ids}" },
            faultInjector = crashingInjector,
        )
        return Fixture(journal, persistence, secretStore)
    }

    private data class Fixture(
        val journal: SecretMutationJournal,
        val persistence: MemoryJournalPersistence,
        val secretStore: SecretStore,
    )

    private suspend inline fun <reified T : Throwable> expectFailure(noinline block: suspend () -> Unit): T =
        try {
            block()
            fail("expected ${T::class.simpleName}")
            error("unreachable")
        } catch (error: Throwable) {
            if (error !is T) throw error
            error
        }

    private suspend fun expectCrash(block: suspend () -> Unit) {
        expectFailure<SimulatedSecretMutationProcessDeath>(block)
    }

    private fun assertSecret(expected: String, store: SecretStore, ref: SecretRef) {
        val actual = store.get(ref)
        requireNotNull(actual)
        try {
            assertArrayEquals(expected.toByteArray(), actual)
        } finally {
            actual.fill(0)
        }
    }

    private companion object {
        val SCOPE = SecretMutationJournalScope("server-1", "user-1", "device-1", "generation-1")
        val PASSWORD = SecretRef.of("connection", "connection-1", "password")
        val PRIVATE_KEY = SecretRef.of("connection", "connection-1", "privateKey")
    }
}

private class MemoryJournalPersistence : SecretMutationJournalPersistence {
    private var rows = mutableListOf<SecretMutationJournalRow>()
    var deleteFailures: Int = 0

    fun allBlockingSize(): Int = rows.size

    override suspend fun all(): List<SecretMutationJournalRow> = rows.map(SecretMutationJournalRow::deepCopy)

    override suspend fun forScope(scope: SecretMutationJournalScope): List<SecretMutationJournalRow> =
        rows.filter(scope::owns).sortedBy { it.sequence }.map(SecretMutationJournalRow::deepCopy)

    override suspend fun forOperation(
        scope: SecretMutationJournalScope,
        operationId: String,
    ): List<SecretMutationJournalRow> = rows.filter { scope.owns(it) && it.operationId == operationId }
        .sortedBy { it.sequence }
        .map(SecretMutationJournalRow::deepCopy)

    override suspend fun maxSequence(scope: SecretMutationJournalScope): Long? =
        rows.filter(scope::owns).maxOfOrNull { it.sequence }

    override suspend fun insertAll(rows: List<SecretMutationJournalRow>) {
        check(rows.none { incoming -> this.rows.any { it.journalId == incoming.journalId } })
        this.rows += rows.map(SecretMutationJournalRow::deepCopy)
    }

    override suspend fun transitionOperation(
        scope: SecretMutationJournalScope,
        operationId: String,
        expectedState: String,
        nextState: String,
    ): Int = mutateWhere({ scope.owns(it) && it.operationId == operationId && it.state == expectedState }) {
        it.copy(state = nextState)
    }

    override suspend fun supersedeOlderForRef(
        scope: SecretMutationJournalScope,
        row: SecretMutationJournalRow,
        committedState: String,
    ): Int = mutateWhere(
        {
            scope.owns(it) && it.secretRef == row.secretRef && it.sequence < row.sequence &&
                it.state == committedState && it.supersededByJournalId == null
        },
    ) { it.copy(supersededByJournalId = row.journalId) }

    override suspend fun rebindOperations(
        scope: SecretMutationJournalScope,
        sourceOperationIds: List<String>,
        targetOperationId: String,
    ): Int = mutateWhere({ scope.owns(it) && it.operationId in sourceOperationIds }) {
        it.copy(operationId = targetOperationId)
    }

    override suspend fun deleteOperations(
        scope: SecretMutationJournalScope,
        operationIds: List<String>,
    ): Int = deleteWhere { scope.owns(it) && it.operationId in operationIds }

    override suspend fun deleteRows(journalIds: List<String>): Int {
        if (deleteFailures > 0) {
            deleteFailures -= 1
            error("simulated journal delete failure")
        }
        return deleteWhere { it.journalId in journalIds }
    }

    override suspend fun <T> transaction(block: suspend () -> T): T {
        val before = rows.map(SecretMutationJournalRow::deepCopy).toMutableList()
        return try {
            block()
        } catch (failure: Throwable) {
            rows = before
            throw failure
        }
    }

    private fun mutateWhere(
        predicate: (SecretMutationJournalRow) -> Boolean,
        transform: (SecretMutationJournalRow) -> SecretMutationJournalRow,
    ): Int {
        var changed = 0
        rows = rows.mapTo(mutableListOf()) { row ->
            if (predicate(row)) {
                changed += 1
                transform(row)
            } else {
                row
            }
        }
        return changed
    }

    private fun deleteWhere(predicate: (SecretMutationJournalRow) -> Boolean): Int {
        val before = rows.size
        rows.removeAll(predicate)
        return before - rows.size
    }
}

private class MemoryBlobStore : SecretBlobStore {
    private val values = linkedMapOf<String, ByteArray>()

    override fun read(ref: SecretRef): ByteArray? = values[ref.value]?.copyOf()

    override fun write(ref: SecretRef, blob: ByteArray) {
        values.put(ref.value, blob.copyOf())?.fill(0)
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

private class TestSecretCipher : SecretCipher {
    override fun seal(alias: String, plaintext: ByteArray, aad: ByteArray): ByteArray {
        val tag = tag(alias, aad)
        return tag + plaintext
    }

    override fun open(alias: String, blob: ByteArray, aad: ByteArray): ByteArray {
        val expected = tag(alias, aad)
        if (blob.size < expected.size || !blob.copyOfRange(0, expected.size).contentEquals(expected)) {
            throw AEADBadTagException("scope or ref mismatch")
        }
        return blob.copyOfRange(expected.size, blob.size)
    }

    override fun deleteKey(alias: String) = Unit

    private fun tag(alias: String, aad: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").run {
        update(alias.toByteArray())
        digest(aad)
    }
}

private fun SecretMutationJournalRow.deepCopy(): SecretMutationJournalRow = copy(
    oldOpaqueBlob = oldOpaqueBlob?.copyOf(),
    newOpaqueBlob = newOpaqueBlob?.copyOf(),
)

private fun preparedRow(
    scope: SecretMutationJournalScope,
    operationId: String,
    ref: SecretRef,
    sequence: Long,
): SecretMutationJournalRow {
    val parts = requireNotNull(ref.partsOrNull())
    return SecretMutationJournalRow(
        journalId = "foreign-$sequence",
        serverId = scope.serverId,
        ownerUserId = scope.ownerUserId,
        deviceId = scope.deviceId,
        bindingGeneration = scope.bindingGeneration,
        operationId = operationId,
        secretRef = ref.value,
        entityType = parts.entityType,
        entityId = parts.entityId,
        fieldName = parts.fieldName,
        mutation = "CLEAR",
        state = "PREPARED",
        retention = "UNTIL_REMOTE_ACK",
        oldOpaqueBlob = null,
        newOpaqueBlob = null,
        sequence = sequence,
        supersededByJournalId = null,
        createdAt = 1,
    )
}
