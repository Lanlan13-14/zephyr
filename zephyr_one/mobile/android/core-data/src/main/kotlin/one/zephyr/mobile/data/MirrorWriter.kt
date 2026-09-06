package one.zephyr.mobile.data

import androidx.room.withTransaction
import java.util.UUID
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.contracts.EntityRegistry
import one.zephyr.mobile.data.db.BootstrapStagingRow
import one.zephyr.mobile.data.db.Converters
import one.zephyr.mobile.data.db.EntitySearchRow
import one.zephyr.mobile.data.db.MirrorEntityRow
import one.zephyr.mobile.data.db.SecretMutationRetention
import one.zephyr.mobile.data.db.TombstoneRow
import one.zephyr.mobile.data.db.ZephyrDatabase
import one.zephyr.mobile.model.SecretRef
import one.zephyr.mobile.model.SyncChange
import one.zephyr.mobile.model.sync.PushPrediction
import one.zephyr.mobile.security.ResidencyViolationException
import one.zephyr.mobile.security.SecretStore

/** Outcome of applying one page, used by the actor to decide the next phase. */
data class ApplyPageResult(
    val applied: Int,
    val skipped: Int,
    val deleted: Int,
    val appliedCursor: Long,
    /** Kept for wire/UI compatibility. Secret failures now abort the page, so this is always empty. */
    val envelopeFailures: List<String> = emptyList(),
)

/** Decrypts one envelope. Implemented in core-sync, where the device private key is reachable. */
fun interface EnvelopeOpener {
    /** @return plaintext, or null when the envelope is missing, invalid or cannot be opened. */
    fun open(change: SyncChange, fieldName: String): ByteArray?
}

enum class SecretReconciliationFailure {
    INVALID_SECRET_FIELD,
    INVALID_PRESENCE,
    MISSING_ENVELOPE,
    ENVELOPE_REJECTED,
    SECRET_STORE_FAILURE,
    SECRET_JOURNAL_UNAVAILABLE,
    SECRET_JOURNAL_FAILURE,
}

/** A fail-closed page error. The message deliberately contains no entity id or ciphertext. */
class SecretReconciliationException(
    val failure: SecretReconciliationFailure,
    cause: Throwable? = null,
    val entityType: String? = null,
    val entityId: String? = null,
    val fieldName: String? = null,
) : IllegalStateException("secret reconciliation failed: " + failure.name.lowercase(), cause) {
    fun withContext(
        entityType: String,
        entityId: String,
        fieldName: String? = null,
    ): SecretReconciliationException = SecretReconciliationException(
        failure = failure,
        entityType = this.entityType ?: entityType,
        entityId = this.entityId ?: entityId,
        fieldName = this.fieldName ?: fieldName,
        cause = cause,
    )
}

/**
 * Applies server changes to the account-scoped local mirror.
 *
 * Secret presence is authoritative. A present value must arrive with an envelope that opens,
 * or with a previously opened local secret when the change is a non-secret patch. An absent
 * value removes exactly the registry-derived ref. SecretStore lives outside SQLite, so every
 * mutation is committed through [SecretMutationJournal]. This also prevents a later bad
 * envelope, a Room rollback or a process death from leaving the mirror and encrypted store at
 * different revisions while the cursor stays put.
 */
class MirrorWriter(
    private val db: ZephyrDatabase,
    private val secretStore: SecretStore,
    private val clock: () -> Long = System::currentTimeMillis,
    private val secretJournal: SecretMutationJournal? = null,
    private val operationIdFactory: () -> String = { "inbound-secret-" + UUID.randomUUID() },
) {

    suspend fun applyPage(
        changes: List<SyncChange>,
        boundUserId: String,
        startCursor: Long,
        opener: EnvelopeOpener? = null,
    ): ApplyPageResult {
        requireSafeInboundChanges(changes)
        requireOwnedChanges(changes, boundUserId)

        // Only changes that can beat the current revision need envelopes. A stale malformed echo
        // remains skippable, while every page mutation is fully opened before the transaction.
        val page = prepareApplicablePage(changes, opener)
        val prepared = page.secrets
        var applied = 0
        var skipped = 0
        var deleted = 0
        var cursor = startCursor

        try {
            commitSecretMutations(
                operationId = operationIdFactory(),
                mutations = planPageSecretMutations(changes, page),
            ) {
                for ((index, change) in changes.withIndex()) {
                    val spec = EntityRegistry.byType[change.entityType]
                    if (spec == null || isSkippableInboundChange(change)) {
                        skipped += 1
                        cursor = maxOf(cursor, change.changeSeq)
                        continue
                    }

                    if (index !in page.applicableIndexes) {
                        skipped += 1
                        cursor = maxOf(cursor, change.changeSeq)
                        continue
                    }

                    if (change.isDelete) {
                        applyDelete(change)
                        deleted += 1
                    } else {
                        val secrets = prepared[index]
                            ?: throw SecretReconciliationException(
                                SecretReconciliationFailure.MISSING_ENVELOPE,
                            )
                        applyUpsert(change, boundUserId, secrets)
                        applied += 1
                    }
                    cursor = maxOf(cursor, change.changeSeq)
                }
                db.mirrorDao().clearPendingFlagForSyncedRows()
            }
        } finally {
            prepared.values.forEach(PreparedSecrets::close)
        }

        return ApplyPageResult(applied, skipped, deleted, cursor)
    }

    private suspend fun prepareApplicablePage(
        changes: List<SyncChange>,
        opener: EnvelopeOpener?,
    ): ApplicablePage {
        val revisions = mutableMapOf<EntityKey, Long?>()
        val prepared = LinkedHashMap<Int, PreparedSecrets>()
        val applicableIndexes = linkedSetOf<Int>()
        try {
            for ((index, change) in changes.withIndex()) {
                if (EntityRegistry.byType[change.entityType] == null) continue
                if (isSkippableInboundChange(change)) continue
                val key = EntityKey(change.entityType, change.entityId)
                val localRevision = if (revisions.containsKey(key)) {
                    revisions[key]
                } else {
                    // A tombstoned row has no mirror row to read a revision from. Reading the
                    // tombstone keeps the delete durable: an inbound UPSERT older than the tombstone
                    // revision must not resurrect the row (SYNC_STATE_MACHINE.md 7.4). UPSERTs newer
                    // than the delete still apply — a later server-side recreation is legitimate.
                    //
                    // Cache both branches. The previous code cached only the tombstone branch;
                    // an existing mirror row therefore left localRevision null, which made an
                    // already-mirrored name-only change require a new secret envelope after an
                    // app restart even though the change did not modify that secret.
                    val resolvedRevision = rememberResolvedRevision(
                        revisions = revisions,
                        key = key,
                        mirrorRevision = db.mirrorDao().revisionOf(change.entityType, change.entityId),
                        tombstoneRevision = db.tombstoneDao().find(change.entityType, change.entityId)?.revision,
                    )
                    resolvedRevision
                }
                if (!PushPrediction.shouldApplyChange(localRevision, change.action, change.revision)) continue
                applicableIndexes += index
                if (!change.isDelete) {
                    val retained = retainedSecretsFor(change)
                    try {
                        prepared[index] = prepareSecrets(
                            change,
                            opener,
                            retainedSecrets = retained,
                            // A change-feed patch of an already-mirrored row must not
                            // freeze the account when the page omits envelopes. Live
                            // v1.1.538 seq 50 was a name-only connection upsert with
                            // hasPassword=true and no password envelope; One pre65
                            // reported sync.pull: missing_envelope and stopped the cursor.
                            allowMissingEnvelope = localRevision != null,
                        )
                    } finally {
                        retained.values.forEach { it.fill(0) }
                    }
                }
                revisions[key] = change.revision
            }
            return ApplicablePage(applicableIndexes, prepared)
        } catch (failure: Throwable) {
            prepared.values.forEach(PreparedSecrets::close)
            throw failure
        }
    }

    private suspend fun applyUpsert(
        change: SyncChange,
        boundUserId: String,
        secrets: PreparedSecrets,
    ) {
        val ownerUserId = requireOwnedChange(change, boundUserId)
        val existing = db.mirrorDao().find(change.entityType, change.entityId)
        val storedPayload = existing?.let {
            SecretPayloadSanitizer.sanitizeForStorage(
                change.entityType,
                EntityCodec.parse(it.payloadJson),
            )
        } ?: JsonObject(emptyMap())
        val mergedPayload = if (change.fieldMask.isEmpty()) {
            change.payload
        } else {
            EntityCodec.merge(storedPayload, change.payload, change.fieldMask)
        }
        // Presence flags are control metadata, not editable field-mask members. Copy the validated
        // flags explicitly so a remote clear cannot be hidden by a partial editable mask.
        val nextPayload = SecretPayloadSanitizer.sanitizeForStorage(
            change.entityType,
            JsonObject(LinkedHashMap(mergedPayload).apply { putAll(secrets.presence) }),
        )

        db.mirrorDao().upsert(
            MirrorEntityRow(
                entityType = change.entityType,
                entityId = change.entityId,
                ownerUserId = ownerUserId,
                revision = change.revision,
                payloadJson = EntityCodec.encode(nextPayload),
                secretPresenceJson = Converters.jsonObjectToText(secrets.presence),
                deletedAt = null,
                serverUpdatedAt = change.changedAt,
                localUpdatedAt = clock(),
                sortKey = EntityCodec.sortKeyFor(change.entityType, nextPayload),
                hasPendingWrite = false,
            ),
        )
        reindex(change.entityType, change.entityId, nextPayload)
    }

    private suspend fun applyDelete(change: SyncChange) {
        val spec = EntityRegistry.require(change.entityType)
        if (spec.deleteMode == "soft-delete-then-tombstone") {
            db.mirrorDao().markDeleted(change.entityType, change.entityId, change.changedAt)
        } else {
            db.mirrorDao().hardDelete(change.entityType, change.entityId)
        }
        db.mirrorDao().deleteSearch(change.entityType, change.entityId)
        db.overlayDao().deleteForEntity(change.entityType, change.entityId)
        db.tombstoneDao().upsert(
            TombstoneRow(
                entityType = change.entityType,
                entityId = change.entityId,
                revision = change.revision,
                deletedAt = change.changedAt,
                authoritative = spec.deleteMode == "revocation-tombstone",
            ),
        )
        db.pendingOperationDao().deleteForEntity(change.entityType, change.entityId)
    }

    private suspend fun reindex(entityType: String, entityId: String, payload: JsonObject) {
        db.mirrorDao().deleteSearch(entityType, entityId)
        val text = EntityCodec.searchText(entityType, payload) ?: return
        db.mirrorDao().upsertSearch(
            EntitySearchRow(entityType = entityType, entityId = entityId, title = text.first, body = text.second),
        )
    }

    // ---- bootstrap staging -------------------------------------------------------------------

    /**
     * Stages rows and decrypted values under a generation-only ref namespace. The visible mirror
     * and its real refs are untouched until promotion, including across a process restart.
     */
    suspend fun stageBootstrapPage(
        generation: Long,
        entities: List<SyncChange>,
        boundUserId: String,
        opener: EnvelopeOpener? = null,
    ): Int {
        requireSafeInboundChanges(entities)
        requireOwnedChanges(entities, boundUserId)
        val prepared = LinkedHashMap<Int, PreparedSecrets>()
        try {
            val rows = entities.mapIndexedNotNull { index, change ->
                EntityRegistry.byType[change.entityType] ?: return@mapIndexedNotNull null
                val ownerUserId = requireOwnedChange(change, boundUserId)
                /* A bootstrap snapshot page carries a full-replacement fieldMask that happens
                 * to contain no secret fields, which isIncrementalSecretPatch would misread as
                 * an incremental patch and silently swallow an unopenable envelope until the
                 * mutation planner reported a misleading missing_envelope. The snapshot
                 * semantics are explicit instead: keep a retained local secret when the
                 * envelope cannot be opened or is absent, and fail closed with the true code
                 * only when neither the page nor the local mirror can supply the value. */
                val retained = retainedSecretsFor(change)
                val secrets = try {
                    prepareSecrets(change, opener, retainedSecrets = retained, snapshot = true)
                } finally {
                    retained.values.forEach { it.fill(0) }
                }
                prepared[index] = secrets
                BootstrapStagingRow(
                    generation = generation,
                    entityType = change.entityType,
                    entityId = change.entityId,
                    ownerUserId = ownerUserId,
                    revision = change.revision,
                    payloadJson = EntityCodec.encode(
                        JsonObject(LinkedHashMap(change.payload).apply { putAll(secrets.presence) }),
                    ),
                    secretPresenceJson = Converters.jsonObjectToText(secrets.presence),
                    deletedAt = null,
                    serverUpdatedAt = change.changedAt,
                )
            }

            val mutations = planBootstrapPageSecretMutations(generation, entities, prepared)
            commitSecretMutations(operationIdFactory(), mutations) {
                db.bootstrapDao().stage(rows)
            }
            return rows.size
        } finally {
            prepared.values.forEach(PreparedSecrets::close)
        }
    }

    /** Clears abandoned staging rows and only their generation-scoped temporary refs. */
    suspend fun resetBootstrap() {
        val staged = db.bootstrapDao().allStaged()
        val mutations = buildList {
            for (row in staged) {
                val spec = EntityRegistry.byType[row.entityType] ?: continue
                for (fieldName in spec.secretFields) {
                    add(
                        PlannedSecretMutation.Clear(
                            bootstrapSecretRef(row.generation, row.entityType, row.entityId, fieldName),
                        ),
                    )
                }
            }
        }.coalesced()
        commitSecretMutations(operationIdFactory(), mutations) {
            db.bootstrapDao().clearAll()
        }
    }

    /**
     * Promotes a complete snapshot and reconciles its real refs.
     *
     * Existing entities with pending operations retain their optimistic row and every secret ref;
     * a local write must not be erased just because the server snapshot predates its push. All other
     * registry secret refs outside the snapshot are removed, including hostile ids whose canonical
     * length-prefixed refs cannot alias a neighbouring entity.
     */
    suspend fun promoteBootstrap(generation: Long, boundUserId: String) {
        if (boundUserId.isBlank()) {
            throw ResidencyViolationException("refusing bootstrap promotion without a bound account owner")
        }
        val staged = db.bootstrapDao().staged(generation)
        val allStaged = db.bootstrapDao().allStaged()
        val pendingKeys = db.pendingOperationDao().all()
            .mapTo(linkedSetOf()) { EntityKey(it.entityType, it.entityId) }

        val rowsByKey = LinkedHashMap<EntityKey, MirrorEntityRow>()
        for (row in staged) {
            if (row.ownerUserId != boundUserId) {
                throw ResidencyViolationException("refusing foreign-owned bootstrap row")
            }
            val key = EntityKey(row.entityType, row.entityId)
            val pendingRow = if (key in pendingKeys) db.mirrorDao().find(row.entityType, row.entityId) else null
            rowsByKey[key] = pendingRow?.sanitizePayloadForStorage() ?: row.toMirror(clock())
        }
        // A locally-created entity is absent from the server snapshot until its first push.
        for (key in pendingKeys) {
            if (rowsByKey.containsKey(key)) continue
            val local = db.mirrorDao().find(key.entityType, key.entityId) ?: continue
            if (local.ownerUserId != boundUserId) {
                throw ResidencyViolationException("refusing foreign-owned pending row")
            }
            rowsByKey[key] = local.sanitizePayloadForStorage()
        }

        val desiredRefs = linkedSetOf<SecretRef>()
        for ((key, row) in rowsByKey) {
            val spec = EntityRegistry.byType[key.entityType] ?: continue
            val presence = EntityCodec.parse(row.secretPresenceJson)
            for (fieldName in spec.secretFields) {
                if (requirePresenceValue(presence, fieldName)) {
                    desiredRefs += SecretRef.of(key.entityType, key.entityId, fieldName)
                }
            }
        }

        val planned = mutableListOf<PlannedSecretMutation>()
        try {
            // Pending rows keep local values. Every other staged secret comes from the isolated
            // generation namespace and must exist before a real ref or mirror row can advance.
            for (row in staged) {
                val key = EntityKey(row.entityType, row.entityId)
                if (key in pendingKeys) continue
                val spec = EntityRegistry.require(row.entityType)
                val presence = EntityCodec.parse(row.secretPresenceJson)
                for (fieldName in spec.secretFields) {
                    val real = SecretRef.of(row.entityType, row.entityId, fieldName)
                    if (requirePresenceValue(presence, fieldName)) {
                        val temp = bootstrapSecretRef(generation, row.entityType, row.entityId, fieldName)
                        val plaintext = readSecret(temp)
                            ?: throw SecretReconciliationException(
                                SecretReconciliationFailure.MISSING_ENVELOPE,
                            )
                        planned += PlannedSecretMutation.Put(real, plaintext)
                    } else {
                        planned += PlannedSecretMutation.Clear(real)
                    }
                }
            }

            // Only registry business refs participate. Credentials, device identity and other
            // reserved stores are intentionally invisible to snapshot reconciliation.
            for (ref in ownedSecretRefs()) {
                if (shouldRemoveSnapshotSecret(ref, desiredRefs, pendingKeys)) {
                    planned += PlannedSecretMutation.Clear(ref)
                }
            }

            // Promotion consumes every staged generation. A prior abandoned generation can no
            // longer be resumed after the complete snapshot becomes visible.
            for (row in allStaged) {
                val spec = EntityRegistry.byType[row.entityType] ?: continue
                for (fieldName in spec.secretFields) {
                    planned += PlannedSecretMutation.Clear(
                        bootstrapSecretRef(row.generation, row.entityType, row.entityId, fieldName),
                    )
                }
            }

            commitSecretMutations(operationIdFactory(), planned.coalesced()) {
                val rows = rowsByKey.values.toList()
                db.mirrorDao().replaceWithSnapshot(rows)
                for (row in rows) {
                    reindex(row.entityType, row.entityId, EntityCodec.parse(row.payloadJson))
                }
                db.bootstrapDao().clearAll()
            }
        } finally {
            planned.close()
        }
    }

    private suspend fun <T> commitSecretMutations(
        operationId: String,
        mutations: List<PlannedSecretMutation>,
        roomCommit: suspend () -> T,
    ): T {
        if (mutations.isEmpty()) return db.withTransaction { roomCommit() }
        val journal = secretJournal
            ?: throw SecretReconciliationException(
                SecretReconciliationFailure.SECRET_JOURNAL_UNAVAILABLE,
            )
        val intents = try {
            mutations.map { mutation ->
                when (mutation) {
                    is PlannedSecretMutation.Put ->
                        journal.stagePut(mutation.ref, mutation.plaintext)
                    is PlannedSecretMutation.Clear -> journal.stageClear(mutation.ref)
                }
            }
        } catch (failure: Throwable) {
            throw SecretReconciliationException(
                SecretReconciliationFailure.SECRET_STORE_FAILURE,
                failure,
            )
        }
        return try {
            journal.commit(
                operationId = operationId,
                mutations = intents,
                retention = SecretMutationRetention.COMMIT_ONLY,
                roomCommit = roomCommit,
            )
        } catch (failure: SecretMutationJournalException) {
            throw SecretReconciliationException(
                SecretReconciliationFailure.SECRET_JOURNAL_FAILURE,
                failure,
            )
        }
    }

    private fun ownedSecretRefs(): List<SecretRef> = try {
        secretStore.ownedRefs()
    } catch (failure: Throwable) {
        throw SecretReconciliationException(SecretReconciliationFailure.SECRET_STORE_FAILURE, failure)
    }

    suspend fun pruneRetention(nowMs: Long = clock()) {
        val tombstoneCutoff = nowMs - DAY_MS * one.zephyr.mobile.contracts.SyncContract.TOMBSTONE_RETENTION_DAYS
        val appliedCutoff = nowMs - DAY_MS * one.zephyr.mobile.contracts.SyncContract.APPLIED_OP_RETENTION_DAYS
        db.withTransaction {
            db.tombstoneDao().pruneOlderThan(tombstoneCutoff)
            db.appliedOperationDao().pruneOlderThan(appliedCutoff)
        }
    }

    private fun readSecret(ref: SecretRef): ByteArray? = try {
        secretStore.get(ref)
    } catch (failure: Throwable) {
        throw SecretReconciliationException(SecretReconciliationFailure.SECRET_STORE_FAILURE, failure)
    }

    /**
     * Local plaintext already opened for this entity. Incremental name/host
     * edits keep hasPassword=true without a new envelope; the previous secret
     * is the source of truth until a later page actually reseals it.
     */
    private fun retainedSecretsFor(change: SyncChange): Map<String, ByteArray> {
        val spec = EntityRegistry.byType[change.entityType] ?: return emptyMap()
        if (spec.secretFields.isEmpty()) return emptyMap()
        val retained = LinkedHashMap<String, ByteArray>()
        for (fieldName in spec.secretFields) {
            val plaintext = readSecret(SecretRef.of(change.entityType, change.entityId, fieldName))
            if (plaintext != null && plaintext.isNotEmpty()) retained[fieldName] = plaintext
        }
        return retained
    }

    private companion object {
        const val DAY_MS = 24L * 60 * 60 * 1000
    }
}

internal data class ApplicablePage(
    val applicableIndexes: Set<Int>,
    val secrets: Map<Int, PreparedSecrets>,
)

internal sealed interface PlannedSecretMutation {
    val ref: SecretRef

    data class Put(
        override val ref: SecretRef,
        val plaintext: ByteArray,
    ) : PlannedSecretMutation

    data class Clear(override val ref: SecretRef) : PlannedSecretMutation
}

internal fun planPageSecretMutations(
    changes: List<SyncChange>,
    page: ApplicablePage,
): List<PlannedSecretMutation> = buildList {
    for (index in page.applicableIndexes) {
        val change = changes[index]
        val spec = EntityRegistry.require(change.entityType)
        if (change.isDelete) {
            for (fieldName in spec.secretFields) {
                add(PlannedSecretMutation.Clear(SecretRef.of(change.entityType, change.entityId, fieldName)))
            }
            continue
        }
        val secrets = page.secrets[index]
            ?: throw SecretReconciliationException(SecretReconciliationFailure.MISSING_ENVELOPE)
        for ((fieldName, hasValue) in secrets.states) {
            val ref = SecretRef.of(change.entityType, change.entityId, fieldName)
            if (!hasValue) {
                add(PlannedSecretMutation.Clear(ref))
                continue
            }
            val plaintext = secrets.values[fieldName]
            if (plaintext != null) {
                add(PlannedSecretMutation.Put(ref, plaintext))
            }
            // Presence true without new plaintext keeps the stored secret.
            // prepareSecrets is the gate for missing envelopes; this planner
            // must not undo an incremental keep by failing the whole page.
        }
    }
}.coalesced()

/** Incremental patches name only non-secret fields; they must not reseal or clear secrets. */
internal fun isIncrementalSecretPatch(change: SyncChange): Boolean {
    val spec = EntityRegistry.byType[change.entityType] ?: return false
    if (change.isDelete) return false
    val mask = change.fieldMask
    if (mask.isEmpty()) return false
    val secretFields = spec.secretFields.toSet()
    return mask.none { it in secretFields }
}

internal fun planBootstrapPageSecretMutations(
    generation: Long,
    changes: List<SyncChange>,
    prepared: Map<Int, PreparedSecrets>,
): List<PlannedSecretMutation> = buildList {
    for ((index, secrets) in prepared) {
        val change = changes[index]
        for ((fieldName, hasValue) in secrets.states) {
            val ref = bootstrapSecretRef(generation, change.entityType, change.entityId, fieldName)
            add(
                if (hasValue) {
                    PlannedSecretMutation.Put(
                        ref,
                        secrets.values[fieldName]
                            ?: throw SecretReconciliationException(
                                SecretReconciliationFailure.MISSING_ENVELOPE,
                            ),
                    )
                } else {
                    PlannedSecretMutation.Clear(ref)
                },
            )
        }
    }
}.coalesced()

internal fun List<PlannedSecretMutation>.coalesced(): List<PlannedSecretMutation> {
    val byRef = LinkedHashMap<SecretRef, PlannedSecretMutation>()
    for (mutation in this) byRef[mutation.ref.canonical()] = mutation
    return byRef.values.toList()
}

private fun Iterable<PlannedSecretMutation>.close() {
    for (mutation in this) if (mutation is PlannedSecretMutation.Put) mutation.plaintext.fill(0)
}

internal data class PreparedSecrets(
    val states: Map<String, Boolean>,
    val values: Map<String, ByteArray>,
) {
    val presence: JsonObject = JsonObject(
        states.mapKeys { (fieldName, _) -> presenceFlag(fieldName) }
            .mapValues { (_, hasValue) -> JsonPrimitive(hasValue) },
    )

    fun close() {
        values.values.forEach { it.fill(0) }
    }
}

/** Pure envelope/presence validation shared by change pages and bootstrap staging. */
internal fun prepareSecrets(
    change: SyncChange,
    opener: EnvelopeOpener?,
    retainedSecrets: Map<String, ByteArray> = emptyMap(),
    allowMissingEnvelope: Boolean = false,
    snapshot: Boolean = false,
): PreparedSecrets {
    val spec = EntityRegistry.require(change.entityType)
    if (change.secretEnvelopes.keys.any { it !in spec.secretFields }) {
        throw SecretReconciliationException(SecretReconciliationFailure.INVALID_SECRET_FIELD)
    }

    val states = LinkedHashMap<String, Boolean>()
    val values = LinkedHashMap<String, ByteArray>()
    var currentField: String? = null
    try {
        for (fieldName in spec.secretFields) {
            currentField = fieldName
            val element = change.payload[presenceFlag(fieldName)]
            val declared = when (element) {
                null -> throw SecretReconciliationException(
                    SecretReconciliationFailure.INVALID_PRESENCE,
                )
                else -> EntityCodec.booleanOrNull(element)
                    ?: throw SecretReconciliationException(
                        SecretReconciliationFailure.INVALID_PRESENCE,
                    )
            }
            states[fieldName] = declared
            if (declared) {
                val retained = retainedSecrets[fieldName]
                /* Snapshot pages are full replacements: the incremental-patch fallback never
                 * applies, and a rejected/absent envelope falls back to the retained local
                 * secret before failing closed with the true code. */
                val incrementalFallback = !snapshot && isIncrementalSecretPatch(change)
                val opened = if (change.secretEnvelopes.containsKey(fieldName)) {
                    val plaintext = try {
                        opener?.open(change, fieldName)
                    } catch (_: Throwable) {
                        /* DeviceEnvelopeOpener wraps AAD/unwrap failures as
                         * SecretReconciliationException. Rethrowing that here
                         * froze the second One pull: a rename still carried a
                         * password envelope bound to an older revision. */
                        null
                    }
                    when {
                        plaintext != null && plaintext.isNotEmpty() -> plaintext
                        retained != null && retained.isNotEmpty() -> retained.copyOf()
                        /* A name/host patch may still carry a stale envelope from
                         * an older main end. Incremental pages must keep the
                         * local secret and apply the non-secret fields instead
                         * of freezing the account cursor. */
                        incrementalFallback -> null
                        else -> throw SecretReconciliationException(
                            SecretReconciliationFailure.ENVELOPE_REJECTED,
                        )
                    }
                } else {
                    if (retained != null && retained.isNotEmpty()) {
                        retained.copyOf()
                    } else if (allowMissingEnvelope || incrementalFallback) {
                        null
                    } else {
                        throw SecretReconciliationException(
                            SecretReconciliationFailure.MISSING_ENVELOPE,
                        )
                    }
                }
                if (opened != null) values[fieldName] = opened
            } else if (change.secretEnvelopes.containsKey(fieldName)) {
                throw SecretReconciliationException(
                    SecretReconciliationFailure.INVALID_PRESENCE,
                )
            }
        }
        return PreparedSecrets(states, values)
    } catch (failure: Throwable) {
        values.values.forEach { it.fill(0) }
        if (failure is SecretReconciliationException && failure.entityType == null) {
            throw SecretReconciliationException(
                failure = failure.failure,
                entityType = change.entityType,
                entityId = change.entityId,
                fieldName = currentField,
                cause = failure.cause,
            )
        }
        throw failure
    }
}

/** Snapshot cleanup is limited to known business refs and never crosses a pending entity. */
internal fun shouldRemoveSnapshotSecret(
    ref: SecretRef,
    desiredRefs: Set<SecretRef>,
    pendingEntities: Set<EntityKey>,
): Boolean {
    val parts = ref.partsOrNull() ?: return false
    val spec = EntityRegistry.byType[parts.entityType] ?: return false
    if (parts.fieldName !in spec.secretFields) return false
    return ref !in desiredRefs && EntityKey(parts.entityType, parts.entityId) !in pendingEntities
}

internal data class EntityKey(val entityType: String, val entityId: String)

internal fun rememberResolvedRevision(
    revisions: MutableMap<EntityKey, Long?>,
    key: EntityKey,
    mirrorRevision: Long?,
    tombstoneRevision: Long?,
): Long? {
    val resolved = mirrorRevision ?: tombstoneRevision
    revisions[key] = resolved
    return resolved
}

private fun BootstrapStagingRow.toMirror(now: Long): MirrorEntityRow {
    val payload = SecretPayloadSanitizer.sanitizeForStorage(entityType, EntityCodec.parse(payloadJson))
    return MirrorEntityRow(
        entityType = entityType,
        entityId = entityId,
        ownerUserId = ownerUserId,
        revision = revision,
        payloadJson = EntityCodec.encode(payload),
        secretPresenceJson = secretPresenceJson,
        deletedAt = deletedAt,
        serverUpdatedAt = serverUpdatedAt,
        localUpdatedAt = now,
        sortKey = EntityCodec.sortKeyFor(entityType, payload),
        hasPendingWrite = false,
    )
}

private fun MirrorEntityRow.sanitizePayloadForStorage(): MirrorEntityRow {
    val payload = SecretPayloadSanitizer.sanitizeForStorage(entityType, EntityCodec.parse(payloadJson))
    return copy(
        payloadJson = EntityCodec.encode(payload),
        sortKey = EntityCodec.sortKeyFor(entityType, payload),
    )
}

internal fun presenceFlag(fieldName: String): String =
    "has" + fieldName.replaceFirstChar { it.uppercaseChar() }

internal fun requirePresenceValue(presence: JsonObject, fieldName: String): Boolean {
    val value = presence[presenceFlag(fieldName)] as? JsonPrimitive
        ?: throw SecretReconciliationException(SecretReconciliationFailure.INVALID_PRESENCE)
    // booleanOrNull accepts string content such as "false". Stored presence is control data, so
    // only a JSON boolean may authorize clearing a previously retained secret.
    if (value.isString) {
        throw SecretReconciliationException(SecretReconciliationFailure.INVALID_PRESENCE)
    }
    return EntityCodec.booleanOrNull(value)
        ?: throw SecretReconciliationException(SecretReconciliationFailure.INVALID_PRESENCE)
}

/** The nested component is never parsed; SecretRef's length framing keeps hostile ids unambiguous. */
internal fun bootstrapSecretRef(
    generation: Long,
    entityType: String,
    entityId: String,
    fieldName: String,
): SecretRef = SecretRef.of(
    BOOTSTRAP_SECRET_ENTITY,
    generation.toString() + "\u0000" + entityType + "\u0000" + entityId,
    fieldName,
)

private const val BOOTSTRAP_SECRET_ENTITY = "__bootstrapSecret"

/**
 * Enforces account residency before a page can mutate either Room or the external secret store.
 * Unknown future entity types remain skippable, but every known type must carry a typed owner.
 */
internal fun requireOwnedChanges(changes: List<SyncChange>, boundUserId: String) {
    if (boundUserId.isEmpty()) {
        throw ResidencyViolationException("refusing to mirror without a bound account owner")
    }
    for (change in changes) {
        if (EntityRegistry.byType[change.entityType] == null) continue
        if (isSkippableInboundChange(change)) continue
        requireOwnedChange(change, boundUserId)
    }
}

/** Preflights the complete inbound batch before a database read, envelope open or durable write. */
internal fun requireSafeInboundChanges(changes: List<SyncChange>) {
    for (change in changes) {
        if (EntityRegistry.byType[change.entityType] == null) continue
        if (isSkippableInboundChange(change)) continue
        val payload = if (change.isDelete) change.tombstone ?: change.payload else change.payload
        SecretPayloadSanitizer.requireSafe(change.entityType, payload)
    }
}

/**
 * A live change whose canonical row cannot be projected (legacy owner keys,
 * deleted-after-upsert). The server marks these skippable so one bad row
 * cannot freeze the account cursor.
 */
internal fun isSkippableInboundChange(change: SyncChange): Boolean = change.unsupported

internal fun requireOwnedChange(change: SyncChange, boundUserId: String): String {
    val spec = EntityRegistry.require(change.entityType)
    val ownerPayload = if (change.isDelete) change.tombstone else change.payload
    val owner = (ownerPayload?.get(spec.ownerField) as? JsonPrimitive)
        ?.takeIf { it.isString }
        ?.content
        ?.takeIf { it.isNotEmpty() }
        ?: throw ResidencyViolationException(
            "refusing " + change.entityType + "/" + change.entityId +
                ": missing or invalid " + spec.ownerField,
        )
    if (owner != boundUserId) {
        throw ResidencyViolationException(
            "refusing foreign-owned " + change.entityType + "/" + change.entityId,
        )
    }
    return owner
}
