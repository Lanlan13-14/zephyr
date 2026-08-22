package one.zephyr.mobile.app.binding

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.SensitiveGrant
import one.zephyr.mobile.model.ServerCapabilities
import one.zephyr.mobile.model.ServerProfile
import one.zephyr.mobile.network.ApiEndpoint
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.network.CredentialStore
import one.zephyr.mobile.network.DeviceProofSigner
import one.zephyr.mobile.network.MobileApi
import one.zephyr.mobile.network.MobileApiClient
import one.zephyr.mobile.network.dto.BindRequestDto
import one.zephyr.mobile.network.dto.BindResponseDto
import one.zephyr.mobile.network.dto.DeviceEncryptionKeyDto
import one.zephyr.mobile.network.dto.DeviceKeysDto
import one.zephyr.mobile.network.dto.DeviceSigningKeyDto
import one.zephyr.mobile.network.dto.LoginResponseDto

/** Typed subset of [MobileApi] used by the prebinding flow. */
internal interface BindingMobileApi {
    suspend fun capabilities(): ApiResult<ServerCapabilities>
    suspend fun login(username: String, password: String): ApiResult<LoginResponseDto>
    suspend fun verifyTotp(tempToken: String, code: String): ApiResult<LoginResponseDto>
    suspend fun verifySensitive(
        action: String,
        secret: String,
        targetIds: List<String>,
    ): ApiResult<SensitiveGrant>

    suspend fun bind(request: BindRequestDto, sensitiveGrant: String): ApiResult<BindResponseDto>
    suspend fun createEnrollment(
        request: one.zephyr.mobile.network.dto.LinkEnrollmentCreateRequestDto,
    ): ApiResult<one.zephyr.mobile.network.dto.LinkEnrollmentCreateResponseDto>
    suspend fun enrollmentStatus(
        bindId: String,
        userCode: String,
    ): ApiResult<one.zephyr.mobile.network.dto.LinkEnrollmentStatusDto>
    suspend fun consumeEnrollment(
        bindId: String,
        request: one.zephyr.mobile.network.dto.LinkEnrollmentConsumeRequestDto,
    ): ApiResult<BindResponseDto>
}

/** Dedicated SID store for an authentication attempt that has not produced an account graph yet. */
internal interface PendingBindingSession {
    fun storeSid(sid: String)
    fun clear()
}

/**
 * Production S02 adapter.
 *
 * The SID lives in the prebinding [CredentialStore], while the access/refresh pair returned by bind
 * is handed to the new account graph. Sensitive grants are passed through the dedicated
 * [MobileApi.bind] argument, so they can only become the validated request header and never a DTO
 * field.
 */
internal class MobileBindingGateway(
    private val api: BindingMobileApi,
    private val session: PendingBindingSession,
    private val appVersion: String,
    private val now: () -> Long = System::currentTimeMillis,
) : BindingGateway {

    override suspend fun capabilities(): ApiResult<ServerCapabilities> = api.capabilities()

    override suspend fun login(username: String, password: CharArray): ApiResult<BindingLoginReply> =
        when (val result = api.login(username, String(password))) {
            is ApiResult.Failure -> result
            is ApiResult.Success -> mapLogin(result.value, result.requestId, allowTotp = true)
        }

    override suspend fun verifyTotp(
        tempToken: CharArray,
        code: CharArray,
    ): ApiResult<AuthenticatedBindingAccount> =
        when (val result = api.verifyTotp(String(tempToken), String(code))) {
            is ApiResult.Failure -> result
            is ApiResult.Success -> {
                val response = result.value
                if (response.requireTotp == true) {
                    malformedResponse("TOTP verification returned another challenge", result.requestId)
                } else {
                    mapAuthenticatedAccount(response, result.requestId)
                }
            }
        }

    override suspend fun verifySensitive(
        action: String,
        secret: CharArray,
        targetIds: List<String>,
    ): ApiResult<SensitiveBindingGrant> =
        when (val result = api.verifySensitive(action, String(secret), targetIds)) {
            is ApiResult.Failure -> result
            is ApiResult.Success -> {
                val grant = result.value
                if (!grant.matches(action, targetIds.firstOrNull()) || !grant.isValidAt(now())) {
                    malformedResponse("sensitive grant does not match the requested action", result.requestId)
                } else {
                    ApiResult.Success(SensitiveBindingGrant(grant.grantId), result.requestId)
                }
            }
        }

    override suspend fun bind(
        command: DeviceBindingCommand,
        sensitiveGrant: CharArray,
    ): ApiResult<DeviceBindingReply> {
        val request = BindRequestDto(
            deviceId = command.deviceId,
            deviceName = command.deviceName,
            platform = PLATFORM_ANDROID,
            appVersion = appVersion,
            tokenId = command.tokenId,
            keys = deviceKeys(command),
            syncIntervalSec = command.syncIntervalSec,
        )
        return when (val result = api.bind(request, String(sensitiveGrant))) {
            is ApiResult.Failure -> result
            is ApiResult.Success -> mapBindReply(result.value, result.requestId)
        }
    }

    override suspend fun createEnrollment(
        command: DeviceBindingCommand,
    ): ApiResult<one.zephyr.mobile.network.dto.LinkEnrollmentCreateResponseDto> =
        api.createEnrollment(enrollmentCreateRequest(command))

    override suspend fun enrollmentStatus(
        bindId: String,
        userCode: String,
    ): ApiResult<one.zephyr.mobile.network.dto.LinkEnrollmentStatusDto> =
        api.enrollmentStatus(bindId, userCode)

    override suspend fun consumeEnrollment(
        bindId: String,
        userCode: String,
        enrollmentSecret: CharArray,
        proof: String,
        command: DeviceBindingCommand,
    ): ApiResult<DeviceBindingReply> {
        val request = one.zephyr.mobile.network.dto.LinkEnrollmentConsumeRequestDto(
            userCode = userCode,
            enrollmentSecret = String(enrollmentSecret),
            proof = proof,
            keys = deviceKeys(command),
            syncIntervalSec = command.syncIntervalSec,
        )
        return when (val result = api.consumeEnrollment(bindId, request)) {
            is ApiResult.Failure -> result
            is ApiResult.Success -> mapBindReply(result.value, result.requestId)
        }
    }

    override fun clearAuthentication() = session.clear()

    private fun enrollmentCreateRequest(
        command: DeviceBindingCommand,
    ) = one.zephyr.mobile.network.dto.LinkEnrollmentCreateRequestDto(
        deviceId = command.deviceId,
        deviceName = command.deviceName,
        platform = PLATFORM_ANDROID,
        appVersion = appVersion,
        keys = deviceKeys(command),
    )

    private fun deviceKeys(command: DeviceBindingCommand) = DeviceKeysDto(
        encryption = DeviceEncryptionKeyDto(
            alg = command.publicKeys.encryptionAlg,
            publicKey = command.publicKeys.encryptionPublicKeyBase64,
        ),
        signing = DeviceSigningKeyDto(
            alg = command.publicKeys.signingAlg,
            jwk = JsonObject(command.publicKeys.signingJwk.mapValues { JsonPrimitive(it.value) }),
        ),
    )

    private fun mapBindReply(response: BindResponseDto, requestId: String?): ApiResult<DeviceBindingReply> =
        ApiResult.Success(
            DeviceBindingReply(
                deviceId = response.device.deviceId,
                deviceName = response.device.deviceName,
                tokenId = response.device.tokenId,
                accessCredential = response.accessCredential,
                accessExpiresAt = response.accessExpiresAt,
                refreshCredential = response.refreshCredential,
                registryHash = response.registryHash,
                boundAt = response.device.createdAt,
                instanceEpoch = 0L,
                userId = response.userId ?: response.device.ownerUserId,
                username = response.username,
            ),
            requestId,
        )

    private fun mapLogin(
        response: LoginResponseDto,
        requestId: String?,
        allowTotp: Boolean,
    ): ApiResult<BindingLoginReply> {
        if (response.requireTotp == true) {
            val token = response.tempToken
            return if (allowTotp && !token.isNullOrBlank()) {
                ApiResult.Success(BindingLoginReply.TotpRequired(token), requestId)
            } else {
                malformedResponse("login response contains an invalid TOTP challenge", requestId)
            }
        }
        return when (val account = mapAuthenticatedAccount(response, requestId)) {
            is ApiResult.Failure -> account
            is ApiResult.Success -> ApiResult.Success(BindingLoginReply.Authenticated(account.value), requestId)
        }
    }

    private fun mapAuthenticatedAccount(
        response: LoginResponseDto,
        requestId: String?,
    ): ApiResult<AuthenticatedBindingAccount> {
        val sid = response.sid
        val user = response.user
        val mustChangePassword = response.mustChangePassword
        if (sid.isNullOrBlank() || user == null || mustChangePassword == null) {
            return malformedResponse("authenticated response is incomplete", requestId)
        }
        return try {
            session.storeSid(sid)
            ApiResult.Success(
                AuthenticatedBindingAccount(
                    userId = user.userId,
                    username = user.username,
                    mustChangePassword = mustChangePassword,
                ),
                requestId,
            )
        } catch (_: Exception) {
            runCatching(session::clear)
            ApiResult.Failure(
                MobileError.local("binding_material_missing", "session credential could not be retained"),
            )
        }
    }

    private fun <T> malformedResponse(message: String, requestId: String?): ApiResult<T> =
        ApiResult.Failure(
            MobileError.local("malformed_response", message).copy(requestId = requestId),
        )

    companion object {
        fun create(
            profile: ServerProfile,
            credentials: CredentialStore,
            appVersion: String,
        ): MobileBindingGateway {
            val client = MobileApiClient(
                endpoint = ApiEndpoint(profile.baseUrl, profile.tlsPolicy),
                credentials = credentials,
                refresher = MobileApiClient.AccessRefresher { false },
                appVersion = appVersion,
                proofSigner = DeviceProofSigner {
                    error("prebinding management calls must not request a device proof")
                },
            )
            return MobileBindingGateway(
                api = RealBindingMobileApi(MobileApi(client)),
                session = CredentialPendingBindingSession(credentials),
                appVersion = appVersion,
            )
        }

        private const val PLATFORM_ANDROID = "android"
    }
}

private class RealBindingMobileApi(private val api: MobileApi) : BindingMobileApi {
    override suspend fun capabilities(): ApiResult<ServerCapabilities> = api.capabilities()

    override suspend fun login(username: String, password: String): ApiResult<LoginResponseDto> =
        api.login(username, password)

    override suspend fun verifyTotp(tempToken: String, code: String): ApiResult<LoginResponseDto> =
        api.verifyTotp(tempToken, code)

    override suspend fun verifySensitive(
        action: String,
        secret: String,
        targetIds: List<String>,
    ): ApiResult<SensitiveGrant> = api.verifySensitive(action, secret, targetIds)

    override suspend fun bind(request: BindRequestDto, sensitiveGrant: String): ApiResult<BindResponseDto> =
        api.bind(request, sensitiveGrant)

    override suspend fun createEnrollment(
        request: one.zephyr.mobile.network.dto.LinkEnrollmentCreateRequestDto,
    ) = api.createEnrollment(request)

    override suspend fun enrollmentStatus(bindId: String, userCode: String) =
        api.enrollmentStatus(bindId, userCode)

    override suspend fun consumeEnrollment(
        bindId: String,
        request: one.zephyr.mobile.network.dto.LinkEnrollmentConsumeRequestDto,
    ) = api.consumeEnrollment(bindId, request)
}

private class CredentialPendingBindingSession(
    private val credentials: CredentialStore,
) : PendingBindingSession {
    override fun storeSid(sid: String) = credentials.storeSid(sid)

    override fun clear() = credentials.clearAll()
}
