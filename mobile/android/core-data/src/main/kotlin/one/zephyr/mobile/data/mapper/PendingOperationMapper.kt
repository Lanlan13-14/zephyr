package one.zephyr.mobile.data.mapper

import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.data.EntityCodec
import one.zephyr.mobile.data.db.Converters
import one.zephyr.mobile.data.db.PendingOperationRow
import one.zephyr.mobile.model.PendingOperation

/**
 * Row <-> model for queued operations.
 *
 * The row stores the mask and payload as JSON text because Room cannot index a JsonObject, while
 * the model carries the parsed form because the folding algebra in core-model merges payloads
 * key-by-key. Keeping the conversion in one place stops the two representations from drifting.
 */
object PendingOperationMapper {

    fun toModel(row: PendingOperationRow): PendingOperation = PendingOperation(
        opId = row.opId,
        batchId = row.batchId,
        entityType = row.entityType,
        entityId = row.entityId,
        action = SyncAction.valueOf(row.action.uppercase()),
        baseRevision = row.baseRevision,
        fieldMask = Converters.textToStringList(row.fieldMaskJson),
        payload = EntityCodec.parse(row.payloadJson),
        createdAt = row.createdAt,
        attemptCount = row.attemptCount,
        lastError = row.lastError,
        createdLocally = row.createdLocally,
        secretFields = Converters.textToStringList(row.secretFieldsJson),
        dispatchedAt = row.dispatchedAt,
    )

    fun toRow(model: PendingOperation): PendingOperationRow = PendingOperationRow(
        opId = model.opId,
        batchId = model.batchId,
        entityType = model.entityType,
        entityId = model.entityId,
        action = model.action.name.lowercase(),
        baseRevision = model.baseRevision,
        fieldMaskJson = Converters.stringListToText(model.fieldMask),
        payloadJson = EntityCodec.encode(model.payload),
        createdAt = model.createdAt,
        attemptCount = model.attemptCount,
        lastError = model.lastError,
        createdLocally = model.createdLocally,
        secretFieldsJson = Converters.stringListToText(model.secretFields),
        dispatchedAt = model.dispatchedAt,
    )
}
