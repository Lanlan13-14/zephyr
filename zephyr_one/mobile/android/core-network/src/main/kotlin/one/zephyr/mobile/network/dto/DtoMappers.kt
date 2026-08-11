package one.zephyr.mobile.network.dto

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import one.zephyr.mobile.contracts.EntityRegistry
import one.zephyr.mobile.contracts.PushStatus
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.model.BootstrapPage
import one.zephyr.mobile.model.ChangePage
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.MobileAuthCapabilities
import one.zephyr.mobile.model.PendingOperation
import one.zephyr.mobile.model.PushResponse
import one.zephyr.mobile.model.PushResult
import one.zephyr.mobile.model.SecretEnvelope
import one.zephyr.mobile.model.ServerEncryptionCapabilities
import one.zephyr.mobile.model.ServerCapabilities
import one.zephyr.mobile.model.SyncChange
import one.zephyr.mobile.model.WakeTransportCapabilities
import one.zephyr.mobile.model.sync.FieldMask

/**
 * Wire <-> domain conversion.
 *
 * Kept separate from the DTOs so the wire shape can only ever be changed together with the
 * OpenAPI mirror in contracts/. An unknown enum value is rejected here rather than coerced: a
 * server that invents a new action must not be silently reinterpreted as an upsert.
 */
object DtoMappers {

    fun syncAction(wire: String): SyncAction? = when (wire) {
        "upsert" -> SyncAction.UPSERT
        "delete" -> SyncAction.DELETE
        "restore" -> SyncAction.RESTORE
        else -> null
    }

    fun pushStatus(wire: String): PushStatus? = when (wire) {
        "accepted" -> PushStatus.ACCEPTED
        "duplicate" -> PushStatus.DUPLICATE
        "conflict" -> PushStatus.CONFLICT
        "rejected" -> PushStatus.REJECTED
        "dependency_missing" -> PushStatus.DEPENDENCY_MISSING
        else -> null
    }

    /** Reject malformed server data before a page can reach durable storage or advance its cursor. */
    fun change(dto: SyncChangeDto): SyncChange {
        val action = syncAction(dto.action)
            ?.takeIf { it == SyncAction.UPSERT || it == SyncAction.DELETE }
            ?: throw IllegalArgumentException("sync change has an unsupported action")
        val spec = EntityRegistry.byType[dto.entityType]
            ?: throw IllegalArgumentException("sync change has an unknown entity type")
        if (FieldMask.sanitize(dto.entityType, dto.fieldMask).hasRejections) {
            throw IllegalArgumentException("sync change has an invalid field mask")
        }
        if ((dto.secretEnvelopes ?: emptyMap()).keys.any { it !in spec.secretFields }) {
            throw IllegalArgumentException("sync change has an unknown secret envelope field")
        }
        if (dto.payload.keys.any { it in spec.secretFields }) {
            throw IllegalArgumentException("sync change carries a plaintext secret")
        }
        return SyncChange(
            changeSeq = dto.changeSeq,
            entityType = dto.entityType,
            entityId = dto.entityId,
            action = action,
            revision = dto.revision,
            changedAt = dto.changedAt,
            actorDeviceId = dto.actorDeviceId,
            fieldMask = dto.fieldMask,
            payload = dto.payload,
            secretEnvelopes = dto.secretEnvelopes ?: emptyMap(),
            tombstone = dto.tombstone,
        )
    }

    fun changePage(dto: ChangePageDto): ChangePage {
        require(dto.ok) { "change page response ok must be true" }
        require(dto.fromCursor >= 0L && dto.nextCursor >= dto.fromCursor) {
            "change page has an invalid cursor range"
        }
        val changes = dto.changes.map(::change)
        if (changes.isEmpty()) {
            require(!dto.hasMore && dto.nextCursor == dto.fromCursor) {
                "an empty change page must not advance or continue"
            }
        } else {
            var expected = dto.fromCursor + 1L
            for (change in changes) {
                require(change.changeSeq == expected) {
                    "change page sequence is not contiguous"
                }
                expected += 1L
            }
            require(dto.nextCursor == changes.last().changeSeq) {
                "change page next cursor does not match its final change"
            }
        }
        return ChangePage(
            fromCursor = dto.fromCursor,
            nextCursor = dto.nextCursor,
            hasMore = dto.hasMore,
            changes = changes,
        )
    }

    fun bootstrapPage(dto: BootstrapPageDto): BootstrapPage = BootstrapPage(
        bootstrapId = dto.bootstrapId,
        snapshotCursor = dto.snapshotCursor,
        nextPageToken = dto.nextPageToken,
        complete = dto.complete,
        entities = dto.entities.map(::change),
    )

    /**
     * The conflict object carries the server's view so the conflict card can be built without a
     * second round trip.
     */
    fun pushResult(dto: PushResultDto): PushResult {
        require(dto.opId.isNotBlank()) { "push result is missing its operation id" }
        val status = requireNotNull(pushStatus(dto.status)) { "push result has an unsupported status" }
        dto.entityId?.let { require(it.isNotBlank()) { "push result has a blank entity id" } }
        dto.revision?.let { require(it > 0L) { "push result has an invalid revision" } }
        dto.changeSeq?.let { require(it > 0L) { "push result has an invalid change sequence" } }
        dto.error?.let { envelope ->
            require(!envelope.ok && envelope.error.code.isNotBlank()) { "push result has an invalid error" }
        }
        val conflict = dto.conflict
        when (status) {
            PushStatus.ACCEPTED -> {
                require(dto.error == null && conflict == null) { "accepted result carries an error or conflict" }
                require(!dto.entityId.isNullOrBlank() && dto.revision != null && dto.changeSeq != null) {
                    "accepted result is missing its receipt"
                }
            }
            PushStatus.DUPLICATE -> {
                require(dto.error == null && conflict == null) { "duplicate result carries an error or conflict" }
                require(!dto.entityId.isNullOrBlank() && dto.revision != null) {
                    "duplicate result is missing its receipt"
                }
            }
            PushStatus.CONFLICT -> {
                require(!dto.entityId.isNullOrBlank() && dto.revision != null) {
                    "conflict result is missing its receipt"
                }
                requireNotNull(conflict) { "conflict result is missing its conflict payload" }
                require((conflict["reason"] as? JsonPrimitive)?.content == "field_overlap") {
                    "conflict result has an invalid reason"
                }
                require(((conflict["currentRevision"] as? JsonPrimitive)?.longOrNull ?: 0L) > 0L) {
                    "conflict result has an invalid current revision"
                }
                val fields = conflict["serverChangedFields"] as? kotlinx.serialization.json.JsonArray
                    ?: throw IllegalArgumentException("conflict result is missing changed fields")
                require(fields.all { it is JsonPrimitive && it.isString && it.content.isNotBlank() }) {
                    "conflict result has invalid changed fields"
                }
                require(fields.map { (it as JsonPrimitive).content }.distinct().size == fields.size) {
                    "conflict result has duplicate changed fields"
                }
                // A missing server projection is handled by SyncActor's residency preflight. It
                // must remain a fail-closed bootstrap signal rather than a generic parse failure.
            }
            PushStatus.REJECTED, PushStatus.DEPENDENCY_MISSING -> {
                require(dto.error != null && conflict == null) { "rejected result has an invalid detail" }
            }
        }
        return PushResult(
            opId = dto.opId,
            status = status,
            entityId = dto.entityId,
            revision = dto.revision,
            changeSeq = dto.changeSeq,
            error = dto.error?.let { envelope ->
                MobileError(
                    code = envelope.error.code,
                    message = envelope.error.message,
                    retryable = envelope.error.retryable,
                    requestId = envelope.error.requestId,
                    details = envelope.error.details
                        ?.mapValues { (_, value) ->
                            (value as? JsonPrimitive)?.content ?: value.toString()
                        }
                        ?: emptyMap(),
                )
            },
            serverPayload = conflict?.get("serverPayload") as? JsonObject,
            serverChangedFields = (conflict?.get("serverChangedFields") as? kotlinx.serialization.json.JsonArray)
                ?.mapNotNull { (it as? JsonPrimitive)?.content }
                ?: emptyList(),
        )
    }

    fun pushResponse(dto: PushResponseDto): PushResponse {
        require(dto.ok && dto.batchId.isNotBlank() && dto.serverCursor >= 0L) {
            "push response has invalid metadata"
        }
        return PushResponse(
            batchId = dto.batchId,
            serverCursor = dto.serverCursor,
            results = dto.results.map(::pushResult),
            changesAvailable = dto.changesAvailable,
        )
    }

    fun capabilities(dto: CapabilitiesDto): ServerCapabilities = ServerCapabilities(
        protocolVersions = dto.protocolVersions,
        registryHash = dto.registryHash,
        minimumAppVersions = dto.minimumAppVersions?.let {
            mapOf("android" to it.android, "ios" to it.ios)
        } ?: emptyMap(),
        limits = mapOf(
            "maxOpsPerBatch" to dto.limits.maxOpsPerBatch,
            "maxPageSize" to dto.limits.maxPageSize,
            "defaultPageSize" to dto.limits.defaultPageSize,
            "minIntervalSec" to dto.limits.minIntervalSec,
            "maxIntervalSec" to dto.limits.maxIntervalSec,
            "blobChunkBytes" to dto.limits.blobChunkBytes,
            "maxBlobBytes" to dto.limits.maxBlobBytes,
            "tombstoneRetentionDays" to dto.limits.tombstoneRetentionDays,
            "appliedOpRetentionDays" to dto.limits.appliedOpRetentionDays,
        ),
        serverId = dto.serverId,
        auth = MobileAuthCapabilities(
            sidHeader = dto.auth.sidHeader,
            accessScheme = dto.auth.accessScheme,
            proofHeader = dto.auth.proofHeader,
            nonceHeader = dto.auth.nonceHeader,
            timestampHeader = dto.auth.timestampHeader,
            challengePath = dto.auth.challengePath,
            proofVersion = dto.auth.proofVersion,
            proofSkewSec = dto.auth.proofSkewSec,
            challengeTtlSec = dto.auth.challengeTtlSec,
            challengeMaxActivePerDevice = dto.auth.challengeMaxActivePerDevice,
            challengeMaxIssuesPerMinute = dto.auth.challengeMaxIssuesPerMinute,
            signatureFormat = dto.auth.signatureFormat,
            encryptionAlg = dto.auth.encryptionAlg,
            signingAlg = dto.auth.signingAlg,
        ),
        serverEncryption = when (val encryption = dto.serverEncryption) {
            ServerEncryptionCapabilityDto.Unavailable -> null
            is ServerEncryptionCapabilityDto.Available -> ServerEncryptionCapabilities(
                alg = encryption.value.alg,
                keyVersion = encryption.value.keyVersion,
                publicKey = encryption.value.publicKey,
            )
        },
        features = mapOf(
            "bidirectionalSync" to dto.features.bidirectionalSync,
            "sharedResources" to dto.features.sharedResources,
            "fileBridge" to dto.features.fileBridge,
            "blobTransfer" to dto.features.blobTransfer,
            "nearRealtimeWake" to dto.features.nearRealtimeWake,
        ),
        wake = WakeTransportCapabilities(
            enabled = dto.wake.enabled,
            transport = dto.wake.transport,
            path = dto.wake.path,
            event = dto.wake.event,
            payloadFields = dto.wake.payloadFields,
            heartbeatSec = dto.wake.heartbeatSec,
            retryMs = dto.wake.retryMs,
            supportsLastEventId = dto.wake.supportsLastEventId,
            requiresDeviceAccess = dto.wake.requiresDeviceAccess,
            requiresDeviceProof = dto.wake.requiresDeviceProof,
            maxConnections = dto.wake.maxConnections,
            maxConnectionsPerOwner = dto.wake.maxConnectionsPerOwner,
            maxBufferedBytes = dto.wake.maxBufferedBytes,
        ),
    )

    /**
     * Outbound operation.
     *
     * fieldMask and payload are already sanitised by the write gateway; the envelopes are attached
     * by the sync actor immediately before the push so plaintext never sits in the queue table.
     */
    fun operation(
        operation: PendingOperation,
        envelopes: Map<String, SecretEnvelope>,
    ): SyncOperationDto {
        validateOperation(operation, envelopes)
        return SyncOperationDto(
            opId = operation.opId,
            entityType = operation.entityType,
            entityId = operation.entityId,
            action = operation.action.name.lowercase(),
            baseRevision = operation.baseRevision,
            clientModifiedAt = operation.createdAt,
            fieldMask = operation.fieldMask,
            payload = operation.payload,
            secretEnvelopes = envelopes.takeIf { it.isNotEmpty() },
            clearSecretFields = operation.clearSecretFields.takeIf { it.isNotEmpty() },
        )
    }

    private fun validateOperation(
        operation: PendingOperation,
        envelopes: Map<String, SecretEnvelope>,
    ) {
        val spec = EntityRegistry.byType[operation.entityType]
            ?: throw IllegalArgumentException("sync operation has an unknown entity type")
        require(operation.opId.isNotBlank() && operation.entityId.isNotBlank()) {
            "sync operation is missing an identifier"
        }
        require(operation.baseRevision >= 0L) { "sync operation has an invalid base revision" }
        require(!FieldMask.sanitize(operation.entityType, operation.fieldMask).hasRejections) {
            "sync operation has an invalid field mask"
        }
        require(operation.payload.keys.none { it in spec.secretFields }) {
            "sync operation carries a plaintext secret"
        }
        val maskRoots = operation.fieldMask.mapTo(hashSetOf(), FieldMask::rootOf)
        require(operation.payload.keys.all { it in maskRoots }) {
            "sync operation payload is outside its field mask"
        }
        require(operation.secretFields.distinct().size == operation.secretFields.size) {
            "sync operation repeats a replacement secret field"
        }
        require(operation.clearSecretFields.distinct().size == operation.clearSecretFields.size) {
            "sync operation repeats a clear secret field"
        }
        require(operation.secretFields.all { it in spec.secretFields }) {
            "sync operation names an unknown replacement secret field"
        }
        require(operation.clearSecretFields.all { it in spec.secretFields }) {
            "sync operation names an unknown clear secret field"
        }
        require(operation.secretFields.isEmpty() || operation.clearSecretFields.isEmpty()) {
            "sync operation mixes secret replacement and clear"
        }
        require(envelopes.keys == operation.secretFields.toSet()) {
            "sync operation replacement secrets are not fully enveloped"
        }
        when (operation.action) {
            SyncAction.UPSERT -> require(
                operation.fieldMask.isNotEmpty() || envelopes.isNotEmpty() ||
                    operation.clearSecretFields.isNotEmpty(),
            ) { "sync upsert has no explicit mutation" }

            SyncAction.DELETE, SyncAction.RESTORE -> require(
                operation.fieldMask.isEmpty() && operation.payload.isEmpty() && envelopes.isEmpty() &&
                    operation.clearSecretFields.isEmpty(),
            ) { "delete or restore carries mutation fields" }
        }
    }
}

// ---- call-site sugar ---------------------------------------------------------------------------
//
// The conversion logic stays in [DtoMappers] so it can only change together with the OpenAPI
// mirror; these are the extension forms the API surface reads with. Declared here rather than in a
// separate file so a new DTO cannot get a mapper without getting its extension.

fun CapabilitiesDto.toDomain(): ServerCapabilities = DtoMappers.capabilities(this)

fun BootstrapPageDto.toDomain(): BootstrapPage = DtoMappers.bootstrapPage(this)

fun ChangePageDto.toDomain(): ChangePage = DtoMappers.changePage(this)

fun PushResponseDto.toDomain(): PushResponse = DtoMappers.pushResponse(this)

/** @param envelopes null when this operation carries no secret, which is the common case. */
fun PendingOperation.toDto(envelopes: Map<String, SecretEnvelope>?): SyncOperationDto =
    DtoMappers.operation(this, envelopes ?: emptyMap())
