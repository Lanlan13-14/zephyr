package one.zephyr.mobile.sync

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import one.zephyr.mobile.model.BootstrapPage
import one.zephyr.mobile.model.ChangePage
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.PendingOperation
import one.zephyr.mobile.model.PushResponse
import one.zephyr.mobile.model.SecretEnvelope
import one.zephyr.mobile.model.ServerCapabilities
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.contracts.MobileApiPaths
import one.zephyr.mobile.network.MobileJson
import one.zephyr.mobile.network.ValidatedAck
import one.zephyr.mobile.network.dto.AckRequestDto
import one.zephyr.mobile.network.dto.ChangePageDto
import one.zephyr.mobile.network.dto.PushRequestDto
import one.zephyr.mobile.network.dto.PushResponseDto
import one.zephyr.mobile.network.dto.toDomain
import one.zephyr.mobile.network.dto.toDto

/**
 * The narrow channel a Link-backed transport needs. The app layer implements this over the
 * embedded Go Link process (dial + push on an established ZSL/2 session). core-sync depends only
 * on this abstraction, so the dependency direction stays app -> core-sync, never the reverse.
 *
 * Wire shape: one SYNC_OP frame whose body carries an `op` discriminator plus the operation
 * payload, answered by a sealed SYNC_ACK carrying the business result. Every client (browser,
 * mobile, desktop) runs the same op vocabulary against the same server-side sync core, so the
 * interface stays standard.
 */
/**
 * The Link v2 wire kind registry values this transport uses. These are business frame kinds, not
 * cryptographic primitives — the Kotlin side names the lane, the embedded Go core owns sealing.
 * The integers must match zephyr-link/internal/codec/codec.go and link-v2-codec.js exactly.
 */
object LinkKinds {
    const val SYNC_OP = 1
    const val SYNC_ACK = 2
}

interface LinkChannel {
    /** Whether a ZSL/2 session to the server is currently established. */
    val isEstablished: Boolean

    /**
     * Push one owned-sync verb and return the business ack body. Throws [LinkChannelException] on a
     * transport/sealing failure; a business rejection arrives as a normal ack body the transport
     * maps onto [ApiResult.Failure].
     */
    suspend fun syncOp(op: String, body: JsonObject): JsonObject
}

class LinkChannelException(message: String) : Exception(message)

/**
 * [SyncTransport] over the Zephyr Link channel (ZSL/2). One clients carry data sync on the
 * encrypted channel end to end rather than plaintext HTTPS, satisfying the security model: the
 * browser is the only client that falls back to HTTPS. The [SyncActor] state machine is reused
 * unchanged — only the transport differs — and every verb encodes/decodes the SAME DTO wire shape
 * as the HTTP path, so there is exactly one sync implementation and one wire contract.
 *
 * capabilities and bootstrap still delegate to the HTTP transport: capabilities is the
 * unauthenticated discovery call that precedes any session, and bootstrap is the resumable paged
 * backfill whose payloads are already envelope-sealed, so neither carries plaintext secrets.
 */
class LinkSyncTransport(
    private val channel: LinkChannel,
    private val deviceId: String,
    private val httpFallback: SyncTransport,
) : SyncTransport {

    private val json get() = MobileJson.instance

    override suspend fun capabilities(): ApiResult<ServerCapabilities> = httpFallback.capabilities()

    override suspend fun bootstrap(pageToken: String?, pageSize: Int?): ApiResult<BootstrapPage> =
        httpFallback.bootstrap(pageToken, pageSize)

    override suspend fun changes(sinceCursor: Long, limit: Int?): ApiResult<ChangePage> = runLink {
        val body = buildJsonObject {
            put("sinceCursor", sinceCursor)
            if (limit != null) put("limit", limit)
        }
        val ack = channel.syncOp("changes", wireBody("changes", body))
        json.decodeFromJsonElement(ChangePageDto.serializer(), ack).toDomain()
    }

    override suspend fun push(
        batchId: String,
        baseCursor: Long,
        registryHash: String,
        operations: List<PendingOperation>,
        envelopes: Map<String, Map<String, SecretEnvelope>>,
    ): ApiResult<PushResponse> {
        val operationDtos = try {
            operations.map { op -> op.toDto(envelopes[op.opId]) }
        } catch (_: IllegalArgumentException) {
            return ApiResult.Failure(
                MobileError.local(
                    code = "invalid_request",
                    message = "queued sync operation violates the secret wire contract",
                    retryable = false,
                ),
            )
        }
        return runLink {
            val request = PushRequestDto(
                protocolVersion = MobileApiPaths.PROTOCOL_VERSION,
                deviceId = deviceId,
                batchId = batchId,
                baseCursor = baseCursor,
                registryHash = registryHash,
                operations = operationDtos,
            )
            /* wireBody injects the op discriminator for every verb. The remaining body is the
             * exact PushRequestDto the HTTP route would get. */
            val body = buildJsonObject {
                json.encodeToJsonElement(PushRequestDto.serializer(), request).jsonObject
                    .forEach { (k, v) -> put(k, v) }
            }
            val ack = channel.syncOp("push", wireBody("push", body))
            json.decodeFromJsonElement(PushResponseDto.serializer(), ack).toDomain()
        }
    }

    override suspend fun ack(cursor: Long, appliedOpIds: List<String>): ApiResult<ValidatedAck> = runLink {
        val request = AckRequestDto(deviceId = deviceId, cursor = cursor, appliedOpIds = appliedOpIds)
        val body = buildJsonObject {
            json.encodeToJsonElement(AckRequestDto.serializer(), request).jsonObject
                .forEach { (k, v) -> put(k, v) }
        }
        channel.syncOp("ack", wireBody("ack", body))
        ValidatedAck
    }

    private fun wireBody(op: String, body: JsonObject): JsonObject = buildJsonObject {
        put("op", JsonPrimitive(op))
        body.forEach { (key, value) ->
            require(key != "op" || value == JsonPrimitive(op)) {
                "Link sync body op does not match the requested operation"
            }
            put(key, value)
        }
    }

    private suspend fun <T> runLink(block: suspend () -> T): ApiResult<T> = try {
        // Do NOT gate on channel.isEstablished here. The channel dials lazily inside syncOp —
        // checking isEstablished before calling it would reject the first-ever sync round
        // (session starts as null) and the Link transport would never dial at all.
        ApiResult.Success(block(), requestId = null)
    } catch (e: LinkChannelException) {
        ApiResult.Failure(linkError(e.message ?: "Link 通道失败"))
    } catch (e: IllegalArgumentException) {
        ApiResult.Failure(linkError("Link 返回了无法解析的响应", retryable = false))
    }

    private fun linkError(message: String, retryable: Boolean = true) = MobileError.local(
        code = "link_unavailable",
        message = message,
        retryable = retryable,
    )

}
