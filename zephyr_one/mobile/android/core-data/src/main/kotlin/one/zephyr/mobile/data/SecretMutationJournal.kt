package one.zephyr.mobile.data

import androidx.room.withTransaction
import java.util.UUID
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import one.zephyr.mobile.data.db.SecretMutationJournalRow
import one.zephyr.mobile.data.db.SecretMutationJournalState
import one.zephyr.mobile.data.db.SecretMutationKind
import one.zephyr.mobile.data.db.SecretMutationRetention
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.model.SecretRef
import one.zephyr.mobile.security.OpaqueSecretBlob
import one.zephyr.mobile.security.SecretStore

sealed interface SecretMutationIntent {
    val ref: SecretRef

    data class Put(
        override val ref: SecretRef,
        internal val replacement: OpaqueSecretBlob,
    ) : SecretMutationIntent

    data class Clear(override val ref: SecretRef) : SecretMutationIntent
}

data class SecretMutationJournalScope(
    val serverId: String,
    val ownerUserId: String,
    val deviceId: String,
    val bindingGeneration: String,
) {
    init {
        require(serverId.isNotBlank()) { "secret journal server must not be blank" }
        require(ownerUserId.isNotBlank()) { "secret journal owner must not be blank" }
        require(deviceId.isNotBlank()) { "secret journal device must not be blank" }
        require(bindingGeneration.isNotBlank()) { "secret journal generation must not be blank" }
    }

    internal fun owns(row: SecretMutationJournalRow): Boolean =
        row.serverId == serverId && row.ownerUserId == ownerUserId && row.deviceId == deviceId &&
            row.bindingGeneration == bindingGeneration
}

class SecretMutationJournalException(message: String, cause: Throwable? = null) :
    IllegalStateException(message, cause)

data class SecretMutationOperation(
    val operationId: String,
    val mutations: List<SecretMutationIntent>,
    val retention: SecretMutationRetention,
)

/** Moves retained secret rows from folded operation ids to the operation that will be sent. */
data class SecretMutationOperationRebinding(
    val sourceOperationIds: List<String>,
    val targetOperationId: String,
)

internal enum class SecretMutationJournalFaultPoint {
    AFTER_PREPARED,
    AFTER_SECRET_ROW_APPLIED,
    AFTER_ROOM_COMMITTED,
    DURING_RECOVERY_ROW_APPLIED,
}

/** Test-only process-death signal. Catching it would model an exception, not a crash. */
internal class SimulatedSecretMutationProcessDeath : Error("simulated secret mutation process death")

internal fun interface SecretMutationJournalFaultInjector {
    suspend fun hit(point: SecretMutationJournalFaultPoint, row: SecretMutationJournalRow?)

    companion object {
        val NONE = SecretMutationJournalFaultInjector { _, _ -> }
    }
}

/**
 * Storage port used by JVM fault tests. The production adapter delegates every transaction to the
 * same Room database as the mirror writes, so journal state and business state share one commit.
 */
internal interface SecretMutationJournalPersistence {
    suspend fun all(): List<SecretMutationJournalRow>
    suspend fun forScope(scope: SecretMutationJournalScope): List<SecretMutationJournalRow>
    suspend fun forOperation(scope: SecretMutationJournalScope, operationId: String): List<SecretMutationJournalRow>
    suspend fun maxSequence(scope: SecretMutationJournalScope): Long?
    suspend fun insertAll(rows: List<SecretMutationJournalRow>)
    suspend fun transitionOperation(
        scope: SecretMutationJournalScope,
        operationId: String,
        expectedState: String,
        nextState: String,
    ): Int
    suspend fun supersedeOlderForRef(
        scope: SecretMutationJournalScope,
        row: SecretMutationJournalRow,
        committedState: String,
    ): Int
    suspend fun rebindOperations(
        scope: SecretMutationJournalScope,
        sourceOperationIds: List<String>,
        targetOperationId: String,
    ): Int
    suspend fun deleteOperations(scope: SecretMutationJournalScope, operationIds: List<String>): Int
    suspend fun deleteRows(journalIds: List<String>): Int
    suspend fun <T> transaction(block: suspend () -> T): T
}

private class RoomSecretMutationJournalPersistence(
    private val db: ZephyrDatabase,
) : SecretMutationJournalPersistence {
    private val dao get() = db.secretMutationJournalDao()

    override suspend fun all() = dao.all()

    override suspend fun forScope(scope: SecretMutationJournalScope) = dao.forScope(
        scope.serverId,
        scope.ownerUserId,
        scope.deviceId,
        scope.bindingGeneration,
    )

    override suspend fun forOperation(scope: SecretMutationJournalScope, operationId: String) = dao.forOperation(
        scope.serverId,
        scope.ownerUserId,
        scope.deviceId,
        scope.bindingGeneration,
        operationId,
    )

    override suspend fun maxSequence(scope: SecretMutationJournalScope) = dao.maxSequence(
        scope.serverId,
        scope.ownerUserId,
        scope.deviceId,
        scope.bindingGeneration,
    )

    override suspend fun insertAll(rows: List<SecretMutationJournalRow>) = dao.insertAll(rows)

    override suspend fun transitionOperation(
        scope: SecretMutationJournalScope,
        operationId: String,
        expectedState: String,
        nextState: String,
    ) = dao.transitionOperation(
        scope.serverId,
        scope.ownerUserId,
        scope.deviceId,
        scope.bindingGeneration,
        operationId,
        expectedState,
        nextState,
    )

    override suspend fun supersedeOlderForRef(
        scope: SecretMutationJournalScope,
        row: SecretMutationJournalRow,
        committedState: String,
    ) = dao.supersedeOlderForRef(
        scope.serverId,
        scope.ownerUserId,
        scope.deviceId,
        scope.bindingGeneration,
        row.secretRef,
        row.sequence,
        committedState,
        row.journalId,
    )

    override suspend fun rebindOperations(
        scope: SecretMutationJournalScope,
        sourceOperationIds: List<String>,
        targetOperationId: String,
    ) = dao.rebindOperations(
        scope.serverId,
        scope.ownerUserId,
        scope.deviceId,
        scope.bindingGeneration,
        sourceOperationIds,
        targetOperationId,
    )

    override suspend fun deleteOperations(scope: SecretMutationJournalScope, operationIds: List<String>) =
        dao.deleteOperations(
            scope.serverId,
            scope.ownerUserId,
            scope.deviceId,
            scope.bindingGeneration,
            operationIds,
        )

    override suspend fun deleteRows(journalIds: List<String>) = dao.deleteRows(journalIds)

    override suspend fun <T> transaction(block: suspend () -> T): T = db.withTransaction { block() }
}

/**
 * Crash-atomic bridge between SQLCipher Room and the file-backed [SecretStore].
 *
 * [commit] owns one mutex across PREPARED persistence, SecretStore installation and the Room
 * business transaction. Callers must put all mirror/pending-operation writes in its callback.
 * PREPARED rolls back on startup; LOCAL_COMMITTED rolls forward. A durable sequence and permanent
 * supersession link ensure that removing a newer journal row can never reactivate an older value.
 */
class SecretMutationJournal internal constructor(
    private val persistence: SecretMutationJournalPersistence,
    private val secretStore: SecretStore,
    val scope: SecretMutationJournalScope,
    private val clock: () -> Long = System::currentTimeMillis,
    private val journalIdFactory: () -> String = { "secret-journal-" + UUID.randomUUID() },
    private val faultInjector: SecretMutationJournalFaultInjector = SecretMutationJournalFaultInjector.NONE,
) {
    constructor(
        db: ZephyrDatabase,
        secretStore: SecretStore,
        serverId: String,
        ownerUserId: String,
        deviceId: String,
        bindingGeneration: String,
        clock: () -> Long = System::currentTimeMillis,
        journalIdFactory: () -> String = { "secret-journal-" + UUID.randomUUID() },
    ) : this(
        RoomSecretMutationJournalPersistence(db),
        secretStore,
        SecretMutationJournalScope(serverId, ownerUserId, deviceId, bindingGeneration),
        clock,
        journalIdFactory,
        SecretMutationJournalFaultInjector.NONE,
    )

    private val mutex = Mutex()
    private var recoveryComplete = false

    init {
        require(
            secretStore.matchesScope(
                scope.serverId,
                scope.ownerUserId,
                scope.deviceId,
                scope.bindingGeneration,
            ),
        ) { "secret journal scope does not match SecretStore" }
    }

    fun stagePut(
        ref: SecretRef,
        plaintext: ByteArray,
        residency: Residency = Residency.OWNED,
    ): SecretMutationIntent.Put =
        SecretMutationIntent.Put(ref.canonical(), secretStore.sealOpaque(ref, plaintext, residency))

    fun stageClear(ref: SecretRef): SecretMutationIntent.Clear =
        SecretMutationIntent.Clear(ref.canonical())

    /**
     * Executes one complete cross-store mutation while holding the journal's shared lock.
     *
     * The callback runs inside Room's transaction. A normal pre-commit failure restores the old
     * secrets and removes PREPARED rows. A process death leaves durable state for [recover].
     */
    suspend fun <T> commit(
        operationId: String,
        mutations: List<SecretMutationIntent>,
        retention: SecretMutationRetention,
        roomCommit: suspend () -> T,
    ): T = commitBatch(
        operations = listOf(SecretMutationOperation(operationId, mutations, retention)),
        roomCommit = roomCommit,
    )

    /** Commits a split wire edit without exposing an intermediate SecretStore or Room state. */
    suspend fun <T> commitBatch(
        operations: List<SecretMutationOperation>,
        roomCommit: suspend () -> T,
    ): T = mutex.withLock {
        requireRecoveryComplete()
        val rows = prepareBatchLocked(operations)
        val operationIds = operations.map { it.operationId }
        try {
            faultInjector.hit(SecretMutationJournalFaultPoint.AFTER_PREPARED, null)
            applyNew(rows) { row ->
                faultInjector.hit(SecretMutationJournalFaultPoint.AFTER_SECRET_ROW_APPLIED, row)
            }
            val result = persistence.transaction {
                val value = roomCommit()
                for (operation in operations) {
                    markLocalCommittedLocked(
                        operation.operationId,
                        rows.filter { it.operationId == operation.operationId },
                    )
                }
                value
            }
            faultInjector.hit(SecretMutationJournalFaultPoint.AFTER_ROOM_COMMITTED, null)
            val commitOnlyIds = operations.filter {
                it.retention == SecretMutationRetention.COMMIT_ONLY
            }.mapTo(hashSetOf()) { it.operationId }
            if (commitOnlyIds.isNotEmpty()) {
                persistence.transaction {
                    persistence.deleteRows(
                        rows.filter { it.operationId in commitOnlyIds }.map { it.journalId },
                    )
                }
            }
            result
        } catch (failure: Throwable) {
            if (failure is SimulatedSecretMutationProcessDeath) throw failure
            compensateFailedCommit(operationIds, failure)
            throw failure
        } finally {
            rows.forEach(SecretMutationJournalRow::wipeTransientCopies)
        }
    }

    /** Startup gate. AccountContainer must complete this before publishing the account graph. */
    suspend fun recover() = mutex.withLock {
        if (recoveryComplete) return@withLock
        requireScopeIsolation()
        val rows = persistence.forScope(scope)
        try {
            rows.forEach(::validateRow)
            validateOperationStates(rows)

            val prepared = rows.filter { it.state == SecretMutationJournalState.PREPARED.name }
                .sortedByDescending { it.sequence }
            for (row in prepared) {
                applyOld(listOf(row))
                faultInjector.hit(SecretMutationJournalFaultPoint.DURING_RECOVERY_ROW_APPLIED, row)
            }
            if (prepared.isNotEmpty()) {
                persistence.transaction { persistence.deleteRows(prepared.map { it.journalId }) }
            }

            val activeCommitted = rows.filter {
                it.state == SecretMutationJournalState.LOCAL_COMMITTED.name &&
                    it.supersededByJournalId == null
            }.sortedBy { it.sequence }
            val duplicateActiveRefs = activeCommitted.groupBy { it.secretRef }.filterValues { it.size > 1 }
            if (duplicateActiveRefs.isNotEmpty()) {
                throw SecretMutationJournalException("secret journal has multiple active values for one ref")
            }
            applyNew(activeCommitted) { row ->
                faultInjector.hit(SecretMutationJournalFaultPoint.DURING_RECOVERY_ROW_APPLIED, row)
            }

            val commitOnly = rows.filter {
                it.state == SecretMutationJournalState.LOCAL_COMMITTED.name &&
                    it.retention == SecretMutationRetention.COMMIT_ONLY.name
            }
            if (commitOnly.isNotEmpty()) {
                persistence.transaction { persistence.deleteRows(commitOnly.map { it.journalId }) }
            }
            recoveryComplete = true
        } finally {
            rows.forEach(SecretMutationJournalRow::wipeTransientCopies)
        }
    }

    /** Atomically removes accepted operation rows with the caller's pending-operation update. */
    suspend fun <T> finalizeRemote(
        operationIds: List<String>,
        roomCommit: suspend () -> T,
    ): T = mutex.withLock {
        requireRecoveryComplete()
        val distinctIds = operationIds.distinct()
        val rows = distinctIds.flatMap { persistence.forOperation(scope, it) }
        try {
            validateRemoteRows(rows, "remote finalization found an invalid journal state")
            persistence.transaction {
                val result = roomCommit()
                deleteRemoteRowsLocked(distinctIds, rows)
                result
            }
        } finally {
            rows.forEach(SecretMutationJournalRow::wipeTransientCopies)
        }
    }

    /** Atomically gives retained rows the folded operation id without changing causal order. */
    suspend fun <T> rebindOperations(
        sourceOperationIds: List<String>,
        targetOperationId: String,
        roomCommit: suspend () -> T,
    ): T = rebindOperations(
        rebindings = listOf(SecretMutationOperationRebinding(sourceOperationIds, targetOperationId)),
        finalizedOperationIds = emptyList(),
        roomCommit = roomCommit,
    )

    /**
     * Folds pending operations without separating their queue mutation from journal ownership.
     * Rows with no surviving operation (for example a local create followed by a local delete) are
     * finalized in the same transaction rather than being rebound to an operation that will never
     * reach the server.
     */
    suspend fun <T> rebindOperations(
        rebindings: List<SecretMutationOperationRebinding>,
        finalizedOperationIds: List<String>,
        roomCommit: suspend () -> T,
    ): T = mutex.withLock {
        requireRecoveryComplete()
        val normalized = rebindings.mapNotNull { rebinding ->
            require(rebinding.targetOperationId.isNotBlank()) { "folded operation id must not be blank" }
            val sources = rebinding.sourceOperationIds.distinct()
                .filter { it != rebinding.targetOperationId }
            if (sources.isEmpty()) null else rebinding.copy(sourceOperationIds = sources)
        }
        val sourceIds = normalized.flatMap { it.sourceOperationIds }
        require(sourceIds.distinct().size == sourceIds.size) {
            "a secret journal operation cannot be folded into two targets"
        }
        val finalIds = finalizedOperationIds.distinct()
        require(sourceIds.intersect(finalIds.toSet()).isEmpty()) {
            "a secret journal operation cannot be folded and finalized together"
        }
        val reboundRows = normalized.associateWith { rebinding ->
            rebinding.sourceOperationIds.flatMap { persistence.forOperation(scope, it) }
        }
        val finalizedRows = finalIds.flatMap { persistence.forOperation(scope, it) }
        try {
            validateRemoteRows(
                reboundRows.values.flatten() + finalizedRows,
                "cannot fold an uncommitted secret journal",
            )
            persistence.transaction {
                val result = roomCommit()
                for ((rebinding, rows) in reboundRows) {
                    if (rows.isEmpty()) continue
                    val changed = persistence.rebindOperations(
                        scope,
                        rebinding.sourceOperationIds,
                        rebinding.targetOperationId,
                    )
                    if (changed != rows.size) {
                        throw SecretMutationJournalException("secret journal fold rebinding was incomplete")
                    }
                }
                deleteRemoteRowsLocked(finalIds, finalizedRows)
                result
            }
        } finally {
            (reboundRows.values.flatten() + finalizedRows)
                .forEach(SecretMutationJournalRow::wipeTransientCopies)
        }
    }

    private fun validateRemoteRows(rows: List<SecretMutationJournalRow>, message: String) {
        if (rows.any {
                it.state != SecretMutationJournalState.LOCAL_COMMITTED.name ||
                    it.retention != SecretMutationRetention.UNTIL_REMOTE_ACK.name
            }
        ) {
            throw SecretMutationJournalException(message)
        }
    }

    private suspend fun deleteRemoteRowsLocked(
        operationIds: List<String>,
        rows: List<SecretMutationJournalRow>,
    ) {
        if (rows.isEmpty()) return
        val deleted = persistence.deleteOperations(scope, operationIds)
        if (deleted != rows.size) {
            throw SecretMutationJournalException("secret journal remote finalization was incomplete")
        }
    }

    private suspend fun prepareBatchLocked(
        operations: List<SecretMutationOperation>,
    ): List<SecretMutationJournalRow> {
        require(operations.isNotEmpty()) { "secret journal operation batch must not be empty" }
        require(operations.all { it.operationId.isNotBlank() }) {
            "secret journal operation id must not be blank"
        }
        require(operations.map { it.operationId }.distinct().size == operations.size) {
            "secret journal operation batch contains duplicate ids"
        }
        require(operations.all { it.mutations.isNotEmpty() }) {
            "secret journal mutation set must not be empty"
        }
        val mutations = operations.flatMap { it.mutations }
        require(mutations.map { it.ref.canonical().value }.distinct().size == mutations.size) {
            "secret journal contains duplicate refs"
        }
        requireScopeIsolation()
        for (operation in operations) {
            if (persistence.forOperation(scope, operation.operationId).isNotEmpty()) {
                throw SecretMutationJournalException("secret journal operation id was already used")
            }
        }

        val rows = persistence.transaction {
            var sequence = persistence.maxSequence(scope) ?: 0L
            val now = clock()
            val preparedRows = operations.flatMap { operation ->
                operation.mutations.map { mutation ->
                    if (sequence == Long.MAX_VALUE) {
                        throw SecretMutationJournalException("secret journal sequence exhausted")
                    }
                    sequence += 1L
                    val ref = mutation.ref.canonical()
                    val parts = ref.partsOrNull()
                        ?: throw SecretMutationJournalException("secret journal ref is not canonical")
                    SecretMutationJournalRow(
                        journalId = journalIdFactory(),
                        serverId = scope.serverId,
                        ownerUserId = scope.ownerUserId,
                        deviceId = scope.deviceId,
                        bindingGeneration = scope.bindingGeneration,
                        operationId = operation.operationId,
                        secretRef = ref.value,
                        entityType = parts.entityType,
                        entityId = parts.entityId,
                        fieldName = parts.fieldName,
                        mutation = when (mutation) {
                            is SecretMutationIntent.Put -> SecretMutationKind.PUT.name
                            is SecretMutationIntent.Clear -> SecretMutationKind.CLEAR.name
                        },
                        state = SecretMutationJournalState.PREPARED.name,
                        retention = operation.retention.name,
                        oldOpaqueBlob = secretStore.snapshotOpaque(ref)?.copyForPersistence(),
                        newOpaqueBlob = when (mutation) {
                            is SecretMutationIntent.Put -> mutation.replacement.copyForPersistence()
                            is SecretMutationIntent.Clear -> null
                        },
                        sequence = sequence,
                        supersededByJournalId = null,
                        createdAt = now,
                    )
                }
            }
            try {
                persistence.insertAll(preparedRows)
                preparedRows
            } catch (failure: Throwable) {
                preparedRows.forEach(SecretMutationJournalRow::wipeTransientCopies)
                throw failure
            }
        }
        return rows
    }

    private suspend fun markLocalCommittedLocked(
        operationId: String,
        preparedRows: List<SecretMutationJournalRow>,
    ) {
        val changed = persistence.transitionOperation(
            scope,
            operationId,
            SecretMutationJournalState.PREPARED.name,
            SecretMutationJournalState.LOCAL_COMMITTED.name,
        )
        if (changed != preparedRows.size) {
            throw SecretMutationJournalException("secret journal transition was incomplete")
        }
        for (row in preparedRows.sortedBy { it.sequence }) {
            persistence.supersedeOlderForRef(
                scope,
                row,
                SecretMutationJournalState.LOCAL_COMMITTED.name,
            )
        }
    }

    private suspend fun compensateFailedCommit(operationIds: List<String>, failure: Throwable) {
        val current = try {
            operationIds.flatMap { persistence.forOperation(scope, it) }
        } catch (lookupFailure: Throwable) {
            failure.addSuppressed(lookupFailure)
            return
        }
        if (current.isEmpty()) return
        if (current.all { it.state == SecretMutationJournalState.PREPARED.name }) {
            try {
                applyOld(current)
                persistence.transaction { persistence.deleteRows(current.map { it.journalId }) }
            } catch (rollbackFailure: Throwable) {
                failure.addSuppressed(rollbackFailure)
            }
            return
        }
        if (current.all { it.state == SecretMutationJournalState.LOCAL_COMMITTED.name }) {
            try {
                applyNew(current.filter { it.supersededByJournalId == null })
            } catch (rollForwardFailure: Throwable) {
                failure.addSuppressed(rollForwardFailure)
            }
            return
        }
        failure.addSuppressed(SecretMutationJournalException("secret journal operation has mixed states"))
    }

    private fun requireRecoveryComplete() {
        if (!recoveryComplete) {
            throw SecretMutationJournalException("secret journal recovery has not completed")
        }
    }

    private suspend fun requireScopeIsolation() {
        if (!secretStore.matchesScope(
                scope.serverId,
                scope.ownerUserId,
                scope.deviceId,
                scope.bindingGeneration,
            )
        ) {
            throw SecretMutationJournalException("secret journal scope changed")
        }
        if (persistence.all().any { !scope.owns(it) }) {
            throw SecretMutationJournalException("account database contains another secret journal scope")
        }
    }

    private fun validateOperationStates(rows: List<SecretMutationJournalRow>) {
        for (operationRows in rows.groupBy { it.operationId }.values) {
            if (operationRows.mapTo(linkedSetOf()) { it.state }.size != 1) {
                throw SecretMutationJournalException("secret journal operation has mixed states")
            }
        }
    }

    private suspend fun applyNew(
        rows: List<SecretMutationJournalRow>,
        afterEach: suspend (SecretMutationJournalRow) -> Unit = {},
    ) {
        for (row in rows.sortedBy { it.sequence }) {
            validateRow(row)
            val replacement = row.newOpaqueBlob?.let(OpaqueSecretBlob::fromPersistence)
            secretStore.restoreOpaque(SecretRef(row.secretRef), replacement)
            if (!secretStore.opaqueMatches(SecretRef(row.secretRef), replacement)) {
                throw SecretMutationJournalException("secret journal roll-forward verification failed")
            }
            afterEach(row)
        }
    }

    private suspend fun applyOld(rows: List<SecretMutationJournalRow>) {
        for (row in rows.sortedByDescending { it.sequence }) {
            validateRow(row)
            val previous = row.oldOpaqueBlob?.let(OpaqueSecretBlob::fromPersistence)
            secretStore.restoreOpaque(SecretRef(row.secretRef), previous)
            if (!secretStore.opaqueMatches(SecretRef(row.secretRef), previous)) {
                throw SecretMutationJournalException("secret journal rollback verification failed")
            }
        }
    }

    private fun validateRow(row: SecretMutationJournalRow) {
        if (!scope.owns(row)) {
            throw SecretMutationJournalException("secret journal row has the wrong scope")
        }
        if (row.sequence <= 0L || row.supersededByJournalId == row.journalId) {
            throw SecretMutationJournalException("secret journal ordering metadata is invalid")
        }
        val parts = SecretRef(row.secretRef).canonical().partsOrNull()
        if (
            parts == null || parts.entityType != row.entityType || parts.entityId != row.entityId ||
            parts.fieldName != row.fieldName
        ) {
            throw SecretMutationJournalException("secret journal ref metadata is invalid")
        }
        when (row.mutation) {
            SecretMutationKind.PUT.name -> if (row.newOpaqueBlob == null) {
                throw SecretMutationJournalException("secret put journal omitted its ciphertext")
            }
            SecretMutationKind.CLEAR.name -> if (row.newOpaqueBlob != null) {
                throw SecretMutationJournalException("secret clear journal carried replacement bytes")
            }
            else -> throw SecretMutationJournalException("secret journal mutation is invalid")
        }
        if (row.state !in SecretMutationJournalState.entries.map { it.name }) {
            throw SecretMutationJournalException("secret journal state is invalid")
        }
        if (row.retention !in SecretMutationRetention.entries.map { it.name }) {
            throw SecretMutationJournalException("secret journal retention is invalid")
        }
    }
}

private fun SecretMutationJournalRow.wipeTransientCopies() {
    oldOpaqueBlob?.fill(0)
    newOpaqueBlob?.fill(0)
}
