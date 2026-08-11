package one.zephyr.mobile.network

import java.security.MessageDigest
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import one.zephyr.mobile.model.Base64Codec
import one.zephyr.mobile.model.TlsPolicy
import one.zephyr.mobile.network.dto.AckRequestDto
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class AckResponseIntegrityTest {

    private lateinit var server: MockWebServer
    private lateinit var api: MobileApi

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        val credentials = CredentialStore(
            persistence = AckCredentialPersistence(),
            scope = CredentialScope("server/user/$DEVICE_ID", "generation-1"),
        ).apply {
            replaceBindingCredentials("access", null, "refresh")
        }
        api = MobileApi(
            MobileApiClient(
                endpoint = ApiEndpoint("https://example.test/", TlsPolicy.SystemTrust),
                credentials = credentials,
                refresher = MobileApiClient.AccessRefresher { false },
                appVersion = "test",
                proofSigner = DeviceProofSigner { Base64Codec.encode(ByteArray(64) { 7 }) },
                clientBuilder = OkHttpClient.Builder().addInterceptor { chain ->
                    val original = chain.request()
                    val localUrl = server.url("/").newBuilder()
                        .encodedPath(original.url.encodedPath)
                        .encodedQuery(original.url.encodedQuery)
                        .build()
                    chain.proceed(original.newBuilder().url(localUrl).build())
                },
            ),
        )
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `only the exact literal success receipt validates ACK`() = runTest {
        val invalidBodies = listOf(
            "",
            "{}",
            "null",
            "[]",
            """{"ok":false}""",
            """{"ok":null}""",
            """{"ok":"true"}""",
            """{"ok":1}""",
            """{"ok":true,"cursor":7}""",
        )

        for (body in invalidBodies) {
            val result = ack(MockResponse().setHeader("Content-Type", "application/json").setBody(body))

            assertTrue("body must not validate: $body", result is ApiResult.Failure)
            val error = (result as ApiResult.Failure).error
            assertEquals("malformed_response", error.code)
            assertTrue("ACK protocol failures must retry", error.retryable)
        }
    }

    @Test
    fun `a valid ACK is typed and duplicate valid receipts remain idempotent`() = runTest {
        repeat(2) {
            val result = ack(jsonResponse("""{"ok":true}"""))
            assertTrue(result is ApiResult.Success)
            assertTrue((result as ApiResult.Success).value === ValidatedAck)
        }

        server.takeRequest()
        val firstAck = server.takeRequest()
        val request = MobileJson.instance.decodeFromString(AckRequestDto.serializer(), firstAck.body.readUtf8())
        assertEquals(DEVICE_ID, request.deviceId)
        assertEquals(CURSOR, request.cursor)
        assertEquals(APPLIED_OP_IDS, request.appliedOpIds)
    }

    @Test
    fun `oversized ACK receipt is retryable and never validates`() = runTest {
        val response = jsonResponse("{}")
            .setHeader("Content-Length", ResponseSizeLimitInterceptor.DEFAULT_MAX_BYTES + 1L)

        val result = ack(response)

        assertTrue(result is ApiResult.Failure)
        val error = (result as ApiResult.Failure).error
        assertEquals("response_too_large", error.code)
        assertTrue(error.retryable)
    }

    private suspend fun ack(response: MockResponse): ApiResult<ValidatedAck> {
        val body = AckRequestDto(DEVICE_ID, CURSOR, APPLIED_OP_IDS)
        val encoded = MobileJson.instance.encodeToString(AckRequestDto.serializer(), body)
        server.enqueue(challengeResponse(sha256(encoded.toByteArray(Charsets.UTF_8))))
        server.enqueue(response)
        return api.ack(DEVICE_ID, CURSOR, APPLIED_OP_IDS)
    }

    private fun challengeResponse(bodySha256: String): MockResponse {
        val payload = DeviceProofChallengeResponseDto(
            ok = true,
            challenge = DeviceProofChallengeDto(
                nonce = NONCE,
                timestamp = TIMESTAMP,
                expiresAt = TIMESTAMP * 1_000L + 30_000L,
                method = "POST",
                canonicalPath = "/api/mobile/v1/sync/ack",
                bodySha256 = bodySha256,
                usage = "sync.ack",
                algorithm = "ES256",
                signatureFormat = "P1363",
                proofVersion = PROOF_VERSION,
            ),
        )
        return jsonResponse(
            MobileJson.instance.encodeToString(DeviceProofChallengeResponseDto.serializer(), payload),
        )
    }

    private fun jsonResponse(body: String): MockResponse = MockResponse()
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    private fun sha256(bytes: ByteArray): String =
        Base64Codec.encode(MessageDigest.getInstance("SHA-256").digest(bytes))

    private companion object {
        const val DEVICE_ID = "device-1"
        const val CURSOR = 7L
        val APPLIED_OP_IDS = listOf("op-1")
        const val TIMESTAMP = 1_700_000_000L
        const val NONCE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    }
}

private class AckCredentialPersistence : CredentialPersistence {
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
