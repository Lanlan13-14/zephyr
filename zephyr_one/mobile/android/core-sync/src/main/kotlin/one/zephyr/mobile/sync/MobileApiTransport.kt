package one.zephyr.mobile.sync

import one.zephyr.mobile.model.BootstrapPage
import one.zephyr.mobile.model.ChangePage
import one.zephyr.mobile.model.PendingOperation
import one.zephyr.mobile.model.PushResponse
import one.zephyr.mobile.model.SecretEnvelope
import one.zephyr.mobile.model.ServerCapabilities
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.network.MobileApi
import one.zephyr.mobile.network.ValidatedAck

/**
 * [SyncTransport] over the real HTTP client.
 *
 * Thin on purpose: the deviceId is bound once here so no phase in [SyncActor] can accidentally
 * push or ack under a different device, which the server would reject as a proof mismatch.
 */
class MobileApiTransport(
    private val api: MobileApi,
    private val deviceId: String,
) : SyncTransport {

    override suspend fun capabilities(): ApiResult<ServerCapabilities> = api.capabilities()

    override suspend fun bootstrap(pageToken: String?, pageSize: Int?): ApiResult<BootstrapPage> =
        api.bootstrap(pageToken, pageSize)

    override suspend fun changes(sinceCursor: Long, limit: Int?): ApiResult<ChangePage> =
        api.changes(sinceCursor, limit)

    override suspend fun push(
        batchId: String,
        baseCursor: Long,
        registryHash: String,
        operations: List<PendingOperation>,
        envelopes: Map<String, Map<String, SecretEnvelope>>,
    ): ApiResult<PushResponse> = api.push(
        deviceId = deviceId,
        batchId = batchId,
        baseCursor = baseCursor,
        registryHash = registryHash,
        operations = operations,
        envelopes = envelopes,
    )

    override suspend fun ack(cursor: Long, appliedOpIds: List<String>): ApiResult<ValidatedAck> =
        api.ack(deviceId = deviceId, cursor = cursor, appliedOpIds = appliedOpIds)
}
