package one.zephyr.mobile.network.dto

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import one.zephyr.mobile.contracts.PushStatus
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.model.BootstrapPage
import one.zephyr.mobile.model.ChangePage
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.PendingOperation
import one.zephyr.mobile.model.PushResponse
import one.zephyr.mobile.model.PushResult
import one.zephyr.mobile.model.SecretEnvelope
import one.zephyr.mobile.model.ServerCapabilities
import one.zephyr.mobile.model.SyncChange

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

    /** @return null when the change cannot be interpreted; the caller skips it and advances. */
    fun change(dto: SyncChangeDto): SyncChange? {
        val action = syncAction(dto.action) ?: return null
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

    fun changePage(dto: ChangePageDto): ChangePage = ChangePage(
        fromCursor = dto.fromCursor,
        nextCursor = dto.nextCursor,
        hasMore = dto.hasMore,
        changes = dto.changes.mapNotNull(::change),
    )

    fun bootstrapPage(dto: BootstrapPageDto): BootstrapPage = BootstrapPage(
        bootstrapId = dto.bootstrapId,
        snapshotCursor = dto.snapshotCursor,
        nextPageToken = dto.nextPageToken,
        complete = dto.complete,
        entities = dto.entities.mapNotNull(::change),
    )

    /**
     * The conflict object carries the server's view so the conflict card can be built without a
     * second round trip.
     */
    fun pushResult(dto: PushResultDto): PushResult {
        val conflict = dto.conflict
        return PushResult(
            opId = dto.opId,
            status = pushStatus(dto.status) ?: PushStatus.REJECTED,
            entityId = dto.entityId,
            revision = dto.revision,
            changeSeq = dto.changeSeq,
            error = dto.error?.let { envelope ->
                MobileError(
                    code = envelope.error.code,
                    message = envelope.error.message,
                    retryable = envelope.error.retryable,
                    requestId = envelope.error.requestId,
                )
            },
            serverPayload = conflict?.get("serverPayload") as? JsonObject,
            serverChangedFields = (conflict?.get("serverChangedFields") as? kotlinx.serialization.json.JsonArray)
                ?.mapNotNull { (it as? JsonPrimitive)?.content }
                ?: emptyList(),
        )
    }

    fun pushResponse(dto: PushResponseDto): PushResponse = PushResponse(
        batchId = dto.batchId,
        serverCursor = dto.serverCursor,
        results = dto.results.map(::pushResult),
        changesAvailable = dto.changesAvailable,
    )

    fun capabilities(dto: CapabilitiesDto): ServerCapabilities = ServerCapabilities(
        protocolVersions = dto.protocolVersions,
        registryHash = dto.registryHash,
        minimumAppVersions = (dto.minimumAppVersions ?: JsonObject(emptyMap()))
            .mapValues { it.value.jsonPrimitive.content },
        limits = dto.limits.mapNotNull { entry ->
            (entry.value as? JsonPrimitive)?.longOrNull?.let { entry.key to it }
        }.toMap(),
        authModes = (dto.auth["modes"] as? kotlinx.serialization.json.JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.content }
            ?: emptyList(),
        features = (dto.features ?: JsonObject(emptyMap()))
            .mapNotNull { entry -> (entry.value as? JsonPrimitive)?.booleanOrNull?.let { entry.key to it } }
            .toMap(),
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
    ): SyncOperationDto = SyncOperationDto(
        opId = operation.opId,
        entityType = operation.entityType,
        entityId = operation.entityId,
        action = operation.action.name.lowercase(),
        baseRevision = operation.baseRevision,
        clientModifiedAt = operation.createdAt,
        fieldMask = operation.fieldMask,
        payload = operation.payload,
        secretEnvelopes = envelopes.takeIf { it.isNotEmpty() },
    )
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
