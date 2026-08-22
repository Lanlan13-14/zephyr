package one.zephyr.mobile.app.binding

import kotlinx.coroutines.test.runTest
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.SensitiveGrant
import one.zephyr.mobile.model.ServerCapabilities
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.network.MobileJson
import one.zephyr.mobile.network.dto.AuthUserDto
import one.zephyr.mobile.network.dto.BindRequestDto
import one.zephyr.mobile.network.dto.BindResponseDto
import one.zephyr.mobile.network.dto.DeviceDto
import one.zephyr.mobile.network.dto.LoginResponseDto
import one.zephyr.mobile.security.DeviceIdentity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileBindingGatewayTest {

    @Test
    fun `authenticated login maps password change and clearing drops the SID`() = runTest {
        val api = FakeBindingMobileApi().apply {
            loginResult = ApiResult.Success(authenticatedLogin(mustChangePassword = true), "request-login")
        }
        val session = FakePendingBindingSession()
        val gateway = gateway(api, session)

        val result = gateway.login("alice", "password".toCharArray())

        result as ApiResult.Success
        val reply = result.value as BindingLoginReply.Authenticated
        assertTrue(reply.account.mustChangePassword)
        assertEquals("sid-1", session.sid)

        gateway.clearAuthentication()
        assertNull(session.sid)
        assertEquals(1, session.clearCalls)
    }

    @Test
    fun `TOTP uses the login temp token and stores SID only after verification`() = runTest {
        val api = FakeBindingMobileApi().apply {
            loginResult = ApiResult.Success(
                LoginResponseDto(ok = true, requireTotp = true, tempToken = "temp-login-token"),
                "request-login",
            )
            totpResult = ApiResult.Success(authenticatedLogin(mustChangePassword = false), "request-totp")
        }
        val session = FakePendingBindingSession()
        val gateway = gateway(api, session)

        val login = gateway.login("alice", "password".toCharArray()) as ApiResult.Success
        val challenge = login.value as BindingLoginReply.TotpRequired
        assertEquals("temp-login-token", String(challenge.tempToken))
        assertNull(session.sid)

        val verified = gateway.verifyTotp(challenge.tempToken, "123456".toCharArray())

        assertTrue(verified is ApiResult.Success)
        assertEquals("temp-login-token" to "123456", api.totpCall)
        assertEquals("sid-1", session.sid)
    }

    @Test
    fun `sensitive bind keeps the grant out of the request DTO`() = runTest {
        val grant = "A".repeat(43)
        val targets = listOf("token-1", "device-1")
        val api = FakeBindingMobileApi().apply {
            sensitiveResult = ApiResult.Success(
                SensitiveGrant(
                    grantId = grant,
                    action = "device.bind",
                    targetId = "token-1",
                    expiresAt = 20_000L,
                ),
                "request-sensitive",
            )
            bindResult = ApiResult.Success(bindResponse(), "request-bind")
        }
        val gateway = gateway(api, FakePendingBindingSession())

        val verified = gateway.verifySensitive("device.bind", "123456".toCharArray(), targets)
            as ApiResult.Success
        val result = gateway.bind(bindingCommand(), verified.value.value)

        assertTrue(result is ApiResult.Success)
        assertEquals(Triple("device.bind", "123456", targets), api.sensitiveCall)
        assertEquals(grant, api.bindGrant)
        val body = MobileJson.instance.encodeToString(
            BindRequestDto.serializer(),
            checkNotNull(api.bindRequest),
        )
        assertFalse(body.contains(grant))
        assertFalse(body.contains("sensitiveGrant"))
        assertEquals("android", checkNotNull(api.bindRequest).platform)
        assertEquals("1.2.3", checkNotNull(api.bindRequest).appVersion)
    }

    @Test
    fun `process restart cleanup invalidates a persisted prebinding SID`() {
        val session = FakePendingBindingSession().apply { storeSid("sid-from-dead-process") }
        val recreatedGateway = gateway(FakeBindingMobileApi(), session)

        recreatedGateway.clearAuthentication()

        assertNull(session.sid)
    }

    private fun gateway(
        api: BindingMobileApi,
        session: PendingBindingSession,
    ) = MobileBindingGateway(
        api = api,
        session = session,
        appVersion = "1.2.3",
        now = { 10_000L },
    )

    private fun authenticatedLogin(mustChangePassword: Boolean) = LoginResponseDto(
        ok = true,
        sid = "sid-1",
        user = AuthUserDto(userId = "user-1", username = "alice"),
        mustChangePassword = mustChangePassword,
    )

    private fun bindingCommand() = DeviceBindingCommand(
        deviceId = "device-1",
        deviceName = "Phone",
        tokenId = "token-1",
        publicKeys = DeviceIdentity.PublicKeys(
            encryptionAlg = "ML-KEM-768",
            encryptionPublicKeyBase64 = "public-key",
            signingAlg = "ES256",
            signingJwk = mapOf("kty" to "EC", "crv" to "P-256", "x" to "x", "y" to "y"),
        ),
        syncIntervalSec = 300,
    )

    private fun bindResponse() = BindResponseDto(
        ok = true,
        device = DeviceDto(
            deviceId = "device-1",
            ownerUserId = "user-1",
            deviceName = "Phone",
            platform = "android",
            appVersion = "1.2.3",
            tokenId = "token-1",
            enabled = true,
            automaticEnabled = true,
            syncIntervalSec = 300,
            createdAt = 9_000L,
        ),
        accessCredential = "access-1",
        accessExpiresAt = 30_000L,
        refreshCredential = "refresh-1",
        registryHash = "registry-1",
        bootstrapRequired = true,
    )
}

private class FakePendingBindingSession : PendingBindingSession {
    var sid: String? = null
    var clearCalls = 0

    override fun storeSid(sid: String) {
        this.sid = sid
    }

    override fun clear() {
        sid = null
        clearCalls += 1
    }
}

private class FakeBindingMobileApi : BindingMobileApi {
    var loginResult: ApiResult<LoginResponseDto> = failure()
    var totpResult: ApiResult<LoginResponseDto> = failure()
    var sensitiveResult: ApiResult<SensitiveGrant> = failure()
    var bindResult: ApiResult<BindResponseDto> = failure()
    var totpCall: Pair<String, String>? = null
    var sensitiveCall: Triple<String, String, List<String>>? = null
    var bindRequest: BindRequestDto? = null
    var bindGrant: String? = null

    override suspend fun capabilities(): ApiResult<ServerCapabilities> =
        ApiResult.Success(ServerCapabilities(listOf(1), "registry-1"), null)

    override suspend fun login(username: String, password: String): ApiResult<LoginResponseDto> = loginResult

    override suspend fun verifyTotp(tempToken: String, code: String): ApiResult<LoginResponseDto> {
        totpCall = tempToken to code
        return totpResult
    }

    override suspend fun verifySensitive(
        action: String,
        secret: String,
        targetIds: List<String>,
    ): ApiResult<SensitiveGrant> {
        sensitiveCall = Triple(action, secret, targetIds)
        return sensitiveResult
    }

    override suspend fun bind(
        request: BindRequestDto,
        sensitiveGrant: String,
    ): ApiResult<BindResponseDto> {
        bindRequest = request
        bindGrant = sensitiveGrant
        return bindResult
    }

    override suspend fun createEnrollment(
        request: one.zephyr.mobile.network.dto.LinkEnrollmentCreateRequestDto,
    ) = failure()

    override suspend fun enrollmentStatus(bindId: String, userCode: String) = failure()

    override suspend fun consumeEnrollment(
        bindId: String,
        request: one.zephyr.mobile.network.dto.LinkEnrollmentConsumeRequestDto,
    ) = failure()

    private companion object {
        fun failure(): ApiResult.Failure = ApiResult.Failure(MobileError.local("test_unconfigured", "unconfigured"))
    }
}
