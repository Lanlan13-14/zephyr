package one.zephyr.mobile.network

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import one.zephyr.mobile.model.Base64Codec
import one.zephyr.mobile.model.TlsPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class WakeStreamTransportTest {
    private lateinit var server: MockWebServer
    private lateinit var credentials: CredentialStore

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        credentials = CredentialStore(WakeCredentialPersistence(), CREDENTIAL_SCOPE).apply {
            replaceBindingCredentials("wake-access", null, "wake-refresh")
        }
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `wake stream uses bearer single use device proof and last event id`() = runTest {
        server.enqueue(challengeResponse())
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream; charset=utf-8")
                .setBody(
                    "retry: 7000\n\n" +
                        "id: epoch-a:9\n" +
                        "event: wake\n" +
                        "data: {\"cursor\":9,\"epoch\":\"epoch-a\",\"reason\":\"change\"}\n\n",
                ),
        )
        val client = client()
        val events = mutableListOf<WakeStreamEvent>()

        val outcome = MobileWakeStreamTransport(client, WakeProofSigner(::proofFor))
            .open("epoch-a:7", events::add)

        assertTrue(outcome.connected)
        assertEquals(7_000L, outcome.serverRetryMillis)
        assertEquals(listOf(WakeStreamEvent(9, "epoch-a", "change", "epoch-a:9")), events)
        val challenge = server.takeRequest()
        val stream = server.takeRequest()
        val challengeBody = MobileJson.instance.decodeFromString(
            DeviceProofChallengeRequestDto.serializer(),
            challenge.body.readUtf8(),
        )
        assertEquals("/api/mobile/v1/devices/proof-challenge", challenge.requestUrl?.encodedPath)
        assertEquals("sync.wake", challengeBody.usage)
        assertEquals("GET", challengeBody.method)
        assertEquals("/api/mobile/v1/sync/wake", challengeBody.path)
        assertEquals("Bearer wake-access", challenge.getHeader("Authorization"))
        assertEquals("Bearer wake-access", stream.getHeader("Authorization"))
        assertEquals("epoch-a:7", stream.getHeader("Last-Event-ID"))
        assertEquals(NONCE, stream.getHeader(HEADER_SERVER_NONCE))
        assertEquals(TIMESTAMP.toString(), stream.getHeader(HEADER_PROOF_TIMESTAMP))
        assertEquals(proofFor(challengeDto().toChallengeForTest()), stream.getHeader(HEADER_DEVICE_PROOF))
    }

    @Test
    fun `terminal response remains disconnected and exposes only error code`() = runTest {
        server.enqueue(challengeResponse())
        server.enqueue(
            MockResponse()
                .setResponseCode(403)
                .setHeader("Content-Type", "application/json")
                .setBody(
                    """{"ok":false,"error":{"code":"device_revoked","message":"gone","retryable":false}}""",
                ),
        )

        val outcome = MobileWakeStreamTransport(client(), WakeProofSigner(::proofFor))
            .open(null) { error("terminal response cannot contain a wake") }

        assertEquals(false, outcome.connected)
        assertEquals("device_revoked", outcome.failureCode)
    }

    private fun client(): MobileApiClient = MobileApiClient(
        endpoint = ApiEndpoint("https://example.test/", TlsPolicy.SystemTrust),
        credentials = credentials,
        refresher = MobileApiClient.AccessRefresher { false },
        appVersion = "test",
        proofSigner = DeviceProofSigner(::proofFor),
        clientBuilder = OkHttpClient.Builder().addInterceptor { chain ->
            val original = chain.request()
            val localUrl = server.url("/").newBuilder()
                .encodedPath(original.url.encodedPath)
                .encodedQuery(original.url.encodedQuery)
                .build()
            chain.proceed(original.newBuilder().url(localUrl).build())
        },
    )

    private fun challengeResponse(): MockResponse {
        val body = DeviceProofChallengeResponseDto(ok = true, challenge = challengeDto())
        return MockResponse()
            .setHeader("Content-Type", "application/json")
            .setBody(MobileJson.instance.encodeToString(DeviceProofChallengeResponseDto.serializer(), body))
    }

    private fun challengeDto() = DeviceProofChallengeDto(
        nonce = NONCE,
        timestamp = TIMESTAMP,
        expiresAt = TIMESTAMP * 1_000L + 30_000L,
        method = "GET",
        canonicalPath = "/api/mobile/v1/sync/wake",
        bodySha256 = EMPTY_SHA256,
        usage = "sync.wake",
        algorithm = "ES256",
        signatureFormat = "P1363",
        proofVersion = PROOF_VERSION,
    )

    private fun DeviceProofChallengeDto.toChallengeForTest() = DeviceProofChallenge(
        nonce = nonce,
        timestamp = timestamp,
        expiresAt = expiresAt,
        method = method,
        canonicalPath = canonicalPath,
        bodySha256 = bodySha256,
        usage = usage,
    )

    private fun proofFor(challenge: DeviceProofChallenge): String =
        Base64Codec.encode(ByteArray(64) { challenge.nonce.first().code.toByte() })

    private companion object {
        val CREDENTIAL_SCOPE = CredentialScope("server/account/device", "generation")
        const val TIMESTAMP = 1_700_000_000L
        const val NONCE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        const val EMPTY_SHA256 = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="
    }
}

private class WakeCredentialPersistence : CredentialPersistence {
    private var value: ByteArray? = null

    override fun read(): ByteArray? = value?.copyOf()

    override fun replace(record: ByteArray) {
        value?.fill(0)
        value = record.copyOf()
    }

    override fun delete() {
        value?.fill(0)
        value = null
    }
}
