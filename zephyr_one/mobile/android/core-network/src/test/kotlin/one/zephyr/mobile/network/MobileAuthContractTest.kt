package one.zephyr.mobile.network

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import one.zephyr.mobile.model.Base64Codec
import one.zephyr.mobile.model.TlsPolicy
import one.zephyr.mobile.network.dto.AuthCapabilitiesDto
import one.zephyr.mobile.network.dto.BindRequestDto
import one.zephyr.mobile.network.dto.BindResponseDto
import one.zephyr.mobile.network.dto.CapabilitiesDto
import one.zephyr.mobile.network.dto.DeviceEncryptionKeyDto
import one.zephyr.mobile.network.dto.DeviceKeysDto
import one.zephyr.mobile.network.dto.DeviceSigningKeyDto
import one.zephyr.mobile.network.dto.FeatureCapabilitiesDto
import one.zephyr.mobile.network.dto.LoginRequestDto
import one.zephyr.mobile.network.dto.LoginResponseDto
import one.zephyr.mobile.network.dto.RefreshRequestDto
import one.zephyr.mobile.network.dto.RefreshResponseDto
import one.zephyr.mobile.network.dto.ServerEncryptionDto
import one.zephyr.mobile.network.dto.TotpRequestDto
import one.zephyr.mobile.network.dto.WakeCapabilitiesDto
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class MobileAuthContractTest {

    private lateinit var server: MockWebServer
    private lateinit var api: MobileApi

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        val credentials = CredentialStore(AuthTestCredentialPersistence(), CREDENTIAL_SCOPE).apply {
            storeSid(SID)
            replaceBindingCredentials("data-access", null, "data-refresh")
        }
        val client = MobileApiClient(
            endpoint = ApiEndpoint("https://example.test/", TlsPolicy.SystemTrust),
            credentials = credentials,
            refresher = MobileApiClient.AccessRefresher { false },
            appVersion = "test",
            proofSigner = DeviceProofSigner { error("authentication calls must not request device proof") },
            clientBuilder = OkHttpClient.Builder().addInterceptor { chain ->
                val original = chain.request()
                val localUrl = server.url("/").newBuilder()
                    .encodedPath(original.url.encodedPath)
                    .encodedQuery(original.url.encodedQuery)
                    .build()
                chain.proceed(original.newBuilder().url(localUrl).build())
            },
        )
        api = MobileApi(client)
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `login and TOTP continue with the real server field names`() = runTest {
        server.enqueue(jsonResponse(TOTP_REQUIRED_FIXTURE))
        server.enqueue(jsonResponse(AUTHENTICATED_FIXTURE))

        val login = api.login("alice", "correct horse battery staple")
        assertTrue(login is ApiResult.Success)
        val challenge = (login as ApiResult.Success).value
        assertEquals(true, challenge.requireTotp)
        assertEquals(TEMP_TOKEN, challenge.tempToken)
        assertNull(challenge.sid)

        val loginRequest = server.takeRequest()
        val loginJson = MobileJson.instance.parseToJsonElement(loginRequest.body.readUtf8()).jsonObject
        assertEquals(setOf("username", "password", "returnSid"), loginJson.keys)
        assertEquals(true, loginJson.getValue("returnSid").jsonPrimitive.content.toBoolean())
        assertNull(loginRequest.getHeader("Authorization"))
        assertNull(loginRequest.getHeader("X-Zephyr-Sid"))

        val verified = api.verifyTotp(TEMP_TOKEN, "123456")
        assertTrue(verified is ApiResult.Success)
        val session = (verified as ApiResult.Success).value
        assertEquals(SID, session.sid)
        assertEquals("user-1", session.user?.userId)
        assertEquals("alice", session.user?.username)
        assertEquals(true, session.mustChangePassword)

        val totpRequest = server.takeRequest()
        val totpJson = MobileJson.instance.parseToJsonElement(totpRequest.body.readUtf8()).jsonObject
        assertEquals(setOf("tempToken", "code", "returnSid"), totpJson.keys)
        assertEquals(TEMP_TOKEN, totpJson.getValue("tempToken").jsonPrimitive.content)
        assertNull(totpRequest.getHeader("Authorization"))
        assertNull(totpRequest.getHeader("X-Zephyr-Sid"))
    }

    @Test
    fun `stale flattened login response fails instead of defaulting critical fields`() = runTest {
        server.enqueue(
            jsonResponse(
                """{"ok":true,"sid":"$SID","totpRequired":false,"userId":"user-1","username":"alice"}""",
            ),
        )

        val result = api.login("alice", "password")

        assertTrue(result is ApiResult.Failure)
        assertEquals("malformed_response", (result as ApiResult.Failure).error.code)
        assertFalse(result.error.message.contains(SID))
    }

    @Test
    fun `capabilities preserve server encryption proof feature and wake metadata`() = runTest {
        server.enqueue(jsonResponse(capabilitiesFixture()))

        val result = api.capabilities()

        assertTrue(result is ApiResult.Success)
        val capabilities = (result as ApiResult.Success).value
        assertEquals("server-1", capabilities.serverId)
        assertEquals("zephyr-one-device-proof-v2", capabilities.auth.proofVersion)
        assertEquals("X-Zephyr-Device-Proof", capabilities.auth.proofHeader)
        assertEquals("/api/mobile/v1/devices/proof-challenge", capabilities.auth.challengePath)
        assertEquals("ML-KEM-768", capabilities.serverEncryption?.alg)
        assertEquals(3, capabilities.serverEncryption?.keyVersion)
        assertEquals(true, capabilities.feature("nearRealtimeWake"))
        assertEquals("sse", capabilities.wake.transport)
        assertEquals(listOf("cursor", "epoch", "reason"), capabilities.wake.payloadFields)
        assertTrue(capabilities.wake.requiresDeviceProof)
    }

    @Test
    fun `missing required-nullable server encryption field is malformed`() = runTest {
        server.enqueue(jsonResponse(capabilitiesFixture(includeServerEncryption = false)))

        val result = api.capabilities()

        assertTrue(result is ApiResult.Failure)
        assertEquals("malformed_response", (result as ApiResult.Failure).error.code)
    }

    @Test
    fun `bind and refresh fixtures require their distinct response fields`() {
        val bind = MobileJson.instance.decodeFromString(BindResponseDto.serializer(), BIND_FIXTURE)
        assertTrue(bind.bootstrapRequired)
        assertEquals(1_700_000_060_000L, bind.accessExpiresAt)

        val refresh = MobileJson.instance.decodeFromString(RefreshResponseDto.serializer(), REFRESH_FIXTURE)
        assertEquals("access-2", refresh.accessCredential)
        assertEquals(1_700_000_120_000L, refresh.accessExpiresAt)

        assertDecodeFails(BindResponseDto.serializer(), REFRESH_FIXTURE)
        assertDecodeFails(
            RefreshResponseDto.serializer(),
            REFRESH_FIXTURE.replace(",\"accessExpiresAt\":1700000120000", ""),
        )
    }

    @Test
    fun `bind sends sensitive grant only as a validated header`() = runTest {
        server.enqueue(jsonResponse(BIND_FIXTURE))

        val result = api.bind(bindRequest(), VALID_SENSITIVE_GRANT)

        assertTrue(result is ApiResult.Success)
        val request = server.takeRequest()
        val body = request.body.readUtf8()
        assertEquals(VALID_SENSITIVE_GRANT, request.getHeader("X-Zephyr-Sensitive-Grant"))
        assertFalse(body.contains(VALID_SENSITIVE_GRANT))
        assertFalse(body.contains("sensitiveGrant"))
        assertEquals(
            setOf("deviceId", "deviceName", "platform", "appVersion", "tokenId", "keys", "syncIntervalSec"),
            MobileJson.instance.parseToJsonElement(body).jsonObject.keys,
        )
    }

    @Test
    fun `bind rejects blank malformed and header injection grants without sending`() = runTest {
        val rejected = listOf(
            "",
            " ",
            "A".repeat(42),
            VALID_SENSITIVE_GRANT + "\r\nX-Injected: secret-value",
        )

        for (grant in rejected) {
            val result = api.bind(bindRequest(), grant)
            assertTrue(result is ApiResult.Failure)
            val error = (result as ApiResult.Failure).error
            assertEquals("invalid_request", error.code)
            assertEquals("sensitive grant has an invalid format", error.message)
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `sensitive verification uses management SID without bearer or device proof`() = runTest {
        server.enqueue(
            jsonResponse(
                """{"ok":true,"grant":"$VALID_SENSITIVE_GRANT","expiresAt":1700000060000,"action":"device.bind","targetHash":"$VALID_TARGET_HASH"}""",
            ),
        )

        val result = api.verifySensitive(
            action = "device.bind",
            secret = "password-or-totp",
            targetIds = listOf("device-1234567890"),
        )

        assertTrue(result is ApiResult.Success)
        val request = server.takeRequest()
        assertEquals(SID, request.getHeader("X-Zephyr-Sid"))
        assertNull(request.getHeader("Authorization"))
        assertNull(request.getHeader(HEADER_DEVICE_PROOF))
        assertNull(request.getHeader(HEADER_SERVER_NONCE))
        assertNull(request.getHeader(HEADER_PROOF_TIMESTAMP))
    }

    @Test
    fun `serializer descriptors pin auth capability bind and refresh contract names`() {
        assertFieldNames(
            LoginRequestDto.serializer(),
            "username", "password", "captchaToken", "remember", "returnSid",
        )
        assertFieldNames(
            LoginResponseDto.serializer(),
            "ok", "requireTotp", "tempToken", "sid", "user", "mustChangePassword",
        )
        assertFieldNames(TotpRequestDto.serializer(), "tempToken", "code", "returnSid")
        assertFieldNames(
            BindRequestDto.serializer(),
            "deviceId", "deviceName", "platform", "appVersion", "tokenId", "keys", "syncIntervalSec",
        )
        assertFieldNames(
            BindResponseDto.serializer(),
            "ok", "device", "accessCredential", "accessExpiresAt", "refreshCredential", "registryHash",
            "bootstrapRequired", "username", "userId",
        )
        assertFieldNames(RefreshRequestDto.serializer(), "deviceId", "refreshCredential")
        assertFieldNames(
            RefreshResponseDto.serializer(),
            "ok", "device", "accessCredential", "accessExpiresAt", "refreshCredential", "registryHash",
        )
        assertFieldNames(
            CapabilitiesDto.serializer(),
            "ok", "protocolVersions", "registryHash", "minimumAppVersions", "limits", "serverId", "auth",
            "serverEncryption", "features", "wake",
        )
        assertFieldNames(
            AuthCapabilitiesDto.serializer(),
            "sidHeader", "accessScheme", "proofHeader", "nonceHeader", "timestampHeader", "challengePath",
            "proofVersion", "proofSkewSec", "challengeTtlSec", "challengeMaxActivePerDevice",
            "challengeMaxIssuesPerMinute", "signatureFormat", "encryptionAlg", "signingAlg",
        )
        assertFieldNames(ServerEncryptionDto.serializer(), "alg", "keyVersion", "publicKey")
        assertFieldNames(
            FeatureCapabilitiesDto.serializer(),
            "bidirectionalSync", "sharedResources", "fileBridge", "blobTransfer", "nearRealtimeWake",
            "linkEnrollment",
        )
        assertFieldNames(
            WakeCapabilitiesDto.serializer(),
            "enabled", "transport", "path", "event", "payloadFields", "heartbeatSec", "retryMs",
            "supportsLastEventId", "requiresDeviceAccess", "requiresDeviceProof", "maxConnections",
            "maxConnectionsPerOwner", "maxBufferedBytes",
        )
    }

    private fun capabilitiesFixture(includeServerEncryption: Boolean = true): String {
        val template = if (includeServerEncryption) {
            CAPABILITIES_TEMPLATE
        } else {
            CAPABILITIES_TEMPLATE.replace(SERVER_ENCRYPTION_FIELD, "")
        }
        return template.replace("PUBLIC_KEY", Base64Codec.encode(ByteArray(1184) { 7 }))
    }

    private fun bindRequest(): BindRequestDto = BindRequestDto(
        deviceId = "device-1234567890",
        deviceName = "Pixel",
        platform = "android",
        appVersion = "0.1.0",
        tokenId = "token-1",
        keys = DeviceKeysDto(
            encryption = DeviceEncryptionKeyDto(
                alg = "ML-KEM-768",
                publicKey = Base64Codec.encode(ByteArray(1184) { 3 }),
            ),
            signing = DeviceSigningKeyDto(
                alg = "ES256",
                jwk = buildJsonObject {
                    put("kty", "EC")
                    put("crv", "P-256")
                    put("x", "x-coordinate")
                    put("y", "y-coordinate")
                },
            ),
        ),
        syncIntervalSec = 300,
    )

    private fun jsonResponse(body: String): MockResponse = MockResponse()
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    @OptIn(ExperimentalSerializationApi::class)
    private fun assertFieldNames(serializer: KSerializer<*>, vararg expected: String) {
        val descriptor = serializer.descriptor
        val actual = (0 until descriptor.elementsCount).map(descriptor::getElementName)
        assertEquals(expected.toList(), actual)
    }

    private fun <T> assertDecodeFails(serializer: KSerializer<T>, body: String) {
        val failed = runCatching { MobileJson.instance.decodeFromString(serializer, body) }.isFailure
        assertTrue("expected response to fail strict decoding", failed)
    }

    private companion object {
        val CREDENTIAL_SCOPE = CredentialScope("server/user/device", "1:1")
        const val TEMP_TOKEN = "11111111-2222-4333-8444-555555555555"
        const val SID = "session-id-from-server"
        const val VALID_SENSITIVE_GRANT = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"
        const val VALID_TARGET_HASH = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        const val TOTP_REQUIRED_FIXTURE =
            """{"ok":true,"requireTotp":true,"tempToken":"$TEMP_TOKEN"}"""
        const val AUTHENTICATED_FIXTURE =
            """{"ok":true,"user":{"username":"alice","userId":"user-1"},"mustChangePassword":true,"sid":"$SID"}"""
        const val DEVICE_FIXTURE =
            """{"deviceId":"device-1234567890","ownerUserId":"user-1","deviceName":"Pixel", """ +
                """"platform":"android","appVersion":"0.1.0","tokenId":"token-1","enabled":true,"automaticEnabled":true,"syncIntervalSec":300,"createdAt":1700000000000}"""
        const val BIND_FIXTURE =
            """{"ok":true,"device":$DEVICE_FIXTURE,"accessCredential":"access-1","accessExpiresAt":1700000060000,"refreshCredential":"refresh-1","registryHash":"registry-1","bootstrapRequired":true}"""
        const val REFRESH_FIXTURE =
            """{"ok":true,"device":$DEVICE_FIXTURE,"accessCredential":"access-2","accessExpiresAt":1700000120000,"refreshCredential":"refresh-2","registryHash":"registry-1"}"""
        const val SERVER_ENCRYPTION_FIELD =
            """"serverEncryption":{"alg":"ML-KEM-768","keyVersion":3,"publicKey":"PUBLIC_KEY"},"""
        const val CAPABILITIES_TEMPLATE = """
            {
              "ok": true,
              "protocolVersions": [1],
              "registryHash": "registry-1",
              "minimumAppVersions": {"android":"0.1.0","ios":"0.1.0"},
              "limits": {
                "maxOpsPerBatch": 100,
                "maxPageSize": 500,
                "defaultPageSize": 100,
                "minIntervalSec": 30,
                "maxIntervalSec": 86400,
                "blobChunkBytes": 262144,
                "maxBlobBytes": 33554432,
                "tombstoneRetentionDays": 30,
                "appliedOpRetentionDays": 30
              },
              "serverId": "server-1",
              "auth": {
                "sidHeader":"X-Zephyr-Sid",
                "accessScheme":"Bearer",
                "proofHeader":"X-Zephyr-Device-Proof",
                "nonceHeader":"X-Zephyr-Server-Nonce",
                "timestampHeader":"X-Zephyr-Proof-Timestamp",
                "challengePath":"/api/mobile/v1/devices/proof-challenge",
                "proofVersion":"zephyr-one-device-proof-v2",
                "proofSkewSec":30,
                "challengeTtlSec":30,
                "challengeMaxActivePerDevice":8,
                "challengeMaxIssuesPerMinute":30,
                "signatureFormat":"P1363",
                "encryptionAlg":"ML-KEM-768",
                "signingAlg":"ES256"
              },
              $SERVER_ENCRYPTION_FIELD
              "features": {
                "bidirectionalSync":true,
                "sharedResources":true,
                "fileBridge":false,
                "blobTransfer":true,
                "nearRealtimeWake":true
              },
              "wake": {
                "enabled":true,
                "transport":"sse",
                "path":"/api/mobile/v1/sync/wake",
                "event":"wake",
                "payloadFields":["cursor","epoch","reason"],
                "heartbeatSec":15,
                "retryMs":3000,
                "supportsLastEventId":true,
                "requiresDeviceAccess":true,
                "requiresDeviceProof":true,
                "maxConnections":512,
                "maxConnectionsPerOwner":8,
                "maxBufferedBytes":65536
              }
            }
        """
    }
}

private class AuthTestCredentialPersistence : CredentialPersistence {
    private var record: ByteArray? = null

    override fun read(): ByteArray? = record?.copyOf()

    override fun replace(record: ByteArray) {
        this.record?.fill(0)
        this.record = record.copyOf()
    }

    override fun delete() {
        record?.fill(0)
        record = null
    }
}
