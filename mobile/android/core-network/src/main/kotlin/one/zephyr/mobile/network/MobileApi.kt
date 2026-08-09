package one.zephyr.mobile.network

import one.zephyr.mobile.contracts.MobileApiPaths
import one.zephyr.mobile.model.BootstrapPage
import one.zephyr.mobile.model.ChangePage
import one.zephyr.mobile.model.PendingOperation
import one.zephyr.mobile.model.PushResponse
import one.zephyr.mobile.model.SecretEnvelope
import one.zephyr.mobile.model.SensitiveGrant
import one.zephyr.mobile.model.ServerCapabilities
import one.zephyr.mobile.network.dto.AckRequestDto
import one.zephyr.mobile.network.dto.BindRequestDto
import one.zephyr.mobile.network.dto.BindResponseDto
import one.zephyr.mobile.network.dto.BootstrapPageDto
import one.zephyr.mobile.network.dto.CapabilitiesDto
import one.zephyr.mobile.network.dto.ChangePageDto
import one.zephyr.mobile.network.dto.DeviceListDto
import one.zephyr.mobile.network.dto.DevicePatchDto
import one.zephyr.mobile.network.dto.DeviceDto
import one.zephyr.mobile.network.dto.FileBridgeLeaseRequestDto
import one.zephyr.mobile.network.dto.FileBridgeLeaseResponseDto
import one.zephyr.mobile.network.dto.LoginRequestDto
import one.zephyr.mobile.network.dto.LoginResponseDto
import one.zephyr.mobile.network.dto.PushRequestDto
import one.zephyr.mobile.network.dto.PushResponseDto
import one.zephyr.mobile.network.dto.SensitiveGrantDto
import one.zephyr.mobile.network.dto.SensitiveVerifyRequestDto
import one.zephyr.mobile.network.dto.SyncStatusDto
import one.zephyr.mobile.network.dto.TotpRequestDto
import one.zephyr.mobile.network.dto.toDomain
import one.zephyr.mobile.network.dto.toDto

/**
 * Typed mobile v1 API.
 *
 * Paths come from the generated [MobileApiPaths] rather than string literals, so an OpenAPI change
 * that is not mirrored into mobile/contracts fails the drift gate instead of 404ing at runtime.
 *
 * Every method returns [ApiResult] instead of throwing: the sync actor has to branch on the error
 * code to pick the next binding state, and an exception would lose the requestId needed for the
 * diagnostics copy.
 */
class MobileApi(private val client: MobileApiClient) {

    // ---- management plane (SID) ---------------------------------------------------------------

    suspend fun login(username: String, password: String): ApiResult<LoginResponseDto> =
        client.post(
            path = MobileApiPaths.POST_AUTH_LOGIN,
            body = LoginRequestDto(username = username, password = password),
            bodySerializer = LoginRequestDto.serializer(),
            responseSerializer = LoginResponseDto.serializer(),
            authenticated = false,
        )

    suspend fun verifyTotp(code: String): ApiResult<LoginResponseDto> =
        client.post(
            path = MobileApiPaths.POST_AUTH_TOTP_VERIFY,
            body = TotpRequestDto(code = code),
            bodySerializer = TotpRequestDto.serializer(),
            responseSerializer = LoginResponseDto.serializer(),
        )

    /**
     * Capabilities is unauthenticated on purpose: the pairing screen has to be able to detect an
     * incompatible protocol version before asking the user for a password.
     */
    suspend fun capabilities(): ApiResult<ServerCapabilities> =
        client.get(
            path = MobileApiPaths.GET_MOBILE_V1_CAPABILITIES,
            responseSerializer = CapabilitiesDto.serializer(),
            authenticated = false,
        ).map { it.toDomain() }

    suspend fun bind(request: BindRequestDto): ApiResult<BindResponseDto> =
        client.post(
            path = MobileApiPaths.POST_MOBILE_V1_DEVICES_BIND,
            body = request,
            bodySerializer = BindRequestDto.serializer(),
            responseSerializer = BindResponseDto.serializer(),
        )

    /**
     * Rotates access and refresh together.
     *
     * [MobileApiClient.AccessRefresher] calls this, and the refresh credential travels in the body
     * rather than as a bearer header so it can never be replayed from a captured Authorization line.
     */
    suspend fun refresh(deviceId: String, refreshCredential: String): ApiResult<BindResponseDto> =
        client.post(
            path = MobileApiPaths.POST_MOBILE_V1_DEVICES_REFRESH,
            body = RefreshRequestDto(deviceId = deviceId, refreshCredential = refreshCredential),
            bodySerializer = RefreshRequestDto.serializer(),
            responseSerializer = BindResponseDto.serializer(),
            authenticated = false,
        )

    suspend fun devices(): ApiResult<List<DeviceDto>> =
        client.get(MobileApiPaths.GET_MOBILE_V1_DEVICES, DeviceListDto.serializer())
            .map { it.devices }

    suspend fun patchDevice(deviceId: String, patch: DevicePatchDto): ApiResult<DeviceDto> =
        client.patch(
            path = MobileApiPaths.deviceById(deviceId),
            body = patch,
            bodySerializer = DevicePatchDto.serializer(),
            responseSerializer = DeviceDto.serializer(),
        )

    /**
     * @param sensitiveGrant required. PRODUCT_REQUIREMENTS.md 12 lists bypassing the password/TOTP
     *   gate for a device delete as a release blocker, so the grant is not optional here.
     */
    suspend fun deleteDevice(deviceId: String, sensitiveGrant: String): ApiResult<Boolean> =
        client.delete(
            path = MobileApiPaths.deviceById(deviceId),
            responseSerializer = OkResponseDto.serializer(),
            sensitiveGrant = sensitiveGrant,
        ).map { it.ok }

    suspend fun verifySensitive(
        action: String,
        secret: String,
        targetIds: List<String>,
    ): ApiResult<SensitiveGrant> =
        client.post(
            path = MobileApiPaths.POST_MOBILE_V1_SENSITIVE_VERIFY,
            body = SensitiveVerifyRequestDto(action = action, secret = secret, targetIds = targetIds),
            bodySerializer = SensitiveVerifyRequestDto.serializer(),
            responseSerializer = SensitiveGrantDto.serializer(),
        ).map { dto ->
            SensitiveGrant(
                grantId = dto.grant,
                action = dto.action,
                targetId = targetIds.firstOrNull(),
                expiresAt = dto.expiresAt,
            )
        }

    // ---- data plane (device access credential) ------------------------------------------------

    suspend fun bootstrap(pageToken: String?, pageSize: Int?): ApiResult<BootstrapPage> =
        client.get(
            path = MobileApiPaths.GET_MOBILE_V1_SYNC_BOOTSTRAP,
            responseSerializer = BootstrapPageDto.serializer(),
            query = buildMap {
                pageToken?.let { put("pageToken", it) }
                pageSize?.let { put("pageSize", it.toString()) }
            },
        ).map { it.toDomain() }

    suspend fun changes(sinceCursor: Long, limit: Int?): ApiResult<ChangePage> =
        client.get(
            path = MobileApiPaths.GET_MOBILE_V1_SYNC_CHANGES,
            responseSerializer = ChangePageDto.serializer(),
            query = buildMap {
                put("sinceCursor", sinceCursor.toString())
                limit?.let { put("limit", it.toString()) }
            },
        ).map { it.toDomain() }

    suspend fun push(
        deviceId: String,
        batchId: String,
        baseCursor: Long,
        registryHash: String,
        operations: List<PendingOperation>,
        envelopes: Map<String, Map<String, SecretEnvelope>> = emptyMap(),
    ): ApiResult<PushResponse> =
        client.post(
            path = MobileApiPaths.POST_MOBILE_V1_SYNC_PUSH,
            body = PushRequestDto(
                protocolVersion = MobileApiPaths.PROTOCOL_VERSION,
                deviceId = deviceId,
                batchId = batchId,
                baseCursor = baseCursor,
                registryHash = registryHash,
                operations = operations.map { op -> op.toDto(envelopes[op.opId]) },
            ),
            bodySerializer = PushRequestDto.serializer(),
            responseSerializer = PushResponseDto.serializer(),
        ).map { it.toDomain() }

    /**
     * Acknowledges an applied cursor.
     *
     * Sent only after the page has been committed locally (SYNC_STATE_MACHINE.md 6.4): acking first
     * would let a crash skip changes permanently, because the server would never resend them.
     */
    suspend fun ack(deviceId: String, cursor: Long, appliedOpIds: List<String>): ApiResult<Boolean> =
        client.post(
            path = MobileApiPaths.POST_MOBILE_V1_SYNC_ACK,
            body = AckRequestDto(deviceId = deviceId, cursor = cursor, appliedOpIds = appliedOpIds),
            bodySerializer = AckRequestDto.serializer(),
            responseSerializer = OkResponseDto.serializer(),
        ).map { it.ok }

    suspend fun syncStatus(): ApiResult<SyncStatusDto> =
        client.get(MobileApiPaths.GET_MOBILE_V1_SYNC_STATUS, SyncStatusDto.serializer())

    /** Server-side nudge so the main end can mark the device as awake. */
    suspend fun syncNow(deviceId: String): ApiResult<Boolean> =
        client.post(
            path = MobileApiPaths.POST_MOBILE_V1_SYNC_NOW,
            body = SyncNowRequestDto(deviceId = deviceId),
            bodySerializer = SyncNowRequestDto.serializer(),
            responseSerializer = OkResponseDto.serializer(),
        ).map { it.ok }

    suspend fun fileBridgeLease(
        connectionId: String,
        rootLabel: String,
        readOnly: Boolean,
        ttlSeconds: Int,
    ): ApiResult<FileBridgeLeaseResponseDto> =
        client.post(
            path = MobileApiPaths.POST_MOBILE_V1_FILE_BRIDGE_LEASE,
            body = FileBridgeLeaseRequestDto(
                connectionId = connectionId,
                rootLabel = rootLabel,
                readOnly = readOnly,
                ttlSeconds = ttlSeconds,
            ),
            bodySerializer = FileBridgeLeaseRequestDto.serializer(),
            responseSerializer = FileBridgeLeaseResponseDto.serializer(),
        )
}

@kotlinx.serialization.Serializable
data class SyncNowRequestDto(val deviceId: String)

@kotlinx.serialization.Serializable
data class RefreshRequestDto(val deviceId: String, val refreshCredential: String)

@kotlinx.serialization.Serializable
data class OkResponseDto(val ok: Boolean = false)
