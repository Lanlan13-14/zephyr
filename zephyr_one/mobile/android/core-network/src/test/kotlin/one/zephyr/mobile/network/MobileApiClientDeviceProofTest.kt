package one.zephyr.mobile.network

import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.Serializable
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import one.zephyr.mobile.model.Base64Codec
import one.zephyr.mobile.model.TlsPolicy
import one.zephyr.mobile.model.persistedDiagnosticText
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class MobileApiClientDeviceProofTest {

    private lateinit var server: MockWebServer
    private lateinit var credentials: CredentialStore

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        credentials = CredentialStore(TestCredentialPersistence(), CREDENTIAL_SCOPE).apply {
            replaceBindingCredentials("access-old", null, "refresh-old")
        }
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `challenge includes canonical target and both requests carry bearer`() = runTest {
        val canonicalPath = "/api/mobile/v1/sync/changes?a=%7E&z=two+words"
        val seenChallenges = mutableListOf<DeviceProofChallenge>()
        server.enqueue(challengeResponse(NONCE_A, "GET", canonicalPath, EMPTY_SHA256, "sync.changes"))
        server.enqueue(successResponse())
        val client = client(DeviceProofSigner { challenge ->
            seenChallenges += challenge
            proofFor(challenge)
        })

        val result = client.get(
            path = "/api/mobile/v1/sync/changes",
            query = linkedMapOf("z" to "two words", "a" to "~"),
            responseSerializer = TestReply.serializer(),
        )

        assertTrue(result is ApiResult.Success)
        val challengeRequest = server.takeRequest()
        val dataRequest = server.takeRequest()
        val challengeBody = MobileJson.instance.decodeFromString(
            DeviceProofChallengeRequestDto.serializer(),
            challengeRequest.body.readUtf8(),
        )
        assertEquals("Bearer access-old", challengeRequest.getHeader("Authorization"))
        assertEquals("Bearer access-old", dataRequest.getHeader("Authorization"))
        assertEquals(dataRequest.path, challengeBody.path)
        assertEquals("GET", challengeBody.method)
        assertEquals(EMPTY_SHA256, challengeBody.bodySha256)
        assertEquals("sync.changes", challengeBody.usage)
        assertEquals(canonicalPath, seenChallenges.single().canonicalPath)
        assertEquals(NONCE_A, dataRequest.getHeader(HEADER_SERVER_NONCE))
        assertEquals(TIMESTAMP.toString(), dataRequest.getHeader(HEADER_PROOF_TIMESTAMP))
        assertEquals(proofFor(seenChallenges.single()), dataRequest.getHeader(HEADER_DEVICE_PROOF))
    }

    @Test
    fun `body digest covers the exact serialized bytes sent on the wire`() = runTest {
        val body = TestPushBody(message = "body-secret", sequence = 7)
        val encodedBody = MobileJson.instance.encodeToString(TestPushBody.serializer(), body)
        val expectedHash = sha256(encodedBody.toByteArray(Charsets.UTF_8))
        server.enqueue(
            challengeResponse(
                NONCE_A,
                "POST",
                "/api/mobile/v1/sync/push",
                expectedHash,
                "sync.push",
            ),
        )
        server.enqueue(successResponse())
        val client = client(DeviceProofSigner(::proofFor))

        val result = client.post(
            path = "/api/mobile/v1/sync/push",
            body = body,
            bodySerializer = TestPushBody.serializer(),
            responseSerializer = TestReply.serializer(),
        )

        assertTrue(result is ApiResult.Success)
        val challengeRequest = server.takeRequest()
        val dataRequest = server.takeRequest()
        val challengeBody = MobileJson.instance.decodeFromString(
            DeviceProofChallengeRequestDto.serializer(),
            challengeRequest.body.readUtf8(),
        )
        val transmitted = dataRequest.body.readByteArray()
        assertEquals(encodedBody, String(transmitted, Charsets.UTF_8))
        assertEquals(sha256(transmitted), challengeBody.bodySha256)
        assertEquals(expectedHash, challengeBody.bodySha256)
    }

    @Test
    fun `blob chunk proof hashes exact binary bytes`() = runTest {
        val bytes = ByteArray(1024) { index -> (index and 0xff).toByte() }
        val digest = sha256(bytes)
        val path = "/api/mobile/v1/blobs/uploads/upload-1/chunks/2"
        server.enqueue(challengeResponse(NONCE_A, "PUT", path, digest, "blob.chunk.upload"))
        server.enqueue(successResponse())
        val client = client(DeviceProofSigner(::proofFor))

        val result = client.putBytes(path, bytes, TestReply.serializer())

        assertTrue(result is ApiResult.Success)
        val challengeRequest = server.takeRequest()
        val dataRequest = server.takeRequest()
        val challengeBody = MobileJson.instance.decodeFromString(
            DeviceProofChallengeRequestDto.serializer(),
            challengeRequest.body.readUtf8(),
        )
        assertEquals(digest, challengeBody.bodySha256)
        assertEquals("application/octet-stream", dataRequest.getHeader("Content-Type"))
        assertTrue(bytes.contentEquals(dataRequest.body.readByteArray()))
    }

    @Test
    fun `blob download is challenge protected and returned as bytes`() = runTest {
        val path = "/api/mobile/v1/blobs/abc123/chunks/0"
        val bytes = byteArrayOf(0, 1, 2, 0x7f, 0xff.toByte())
        server.enqueue(challengeResponse(NONCE_A, "GET", path, EMPTY_SHA256, "blob.chunk.download"))
        server.enqueue(MockResponse().setBody(okio.Buffer().write(bytes)))
        val client = client(DeviceProofSigner(::proofFor))

        val result = client.getBytes(path)

        assertTrue(result is ApiResult.Success)
        assertTrue(bytes.contentEquals((result as ApiResult.Success).value))
        server.takeRequest()
        val dataRequest = server.takeRequest()
        assertEquals("Bearer access-old", dataRequest.getHeader("Authorization"))
        assertEquals(NONCE_A, dataRequest.getHeader(HEADER_SERVER_NONCE))
    }

    @Test
    fun `two calls never replay a challenge or proof`() = runTest {
        server.enqueue(challengeResponse(NONCE_A, "GET", SYNC_STATUS_PATH, EMPTY_SHA256, "sync.status"))
        server.enqueue(successResponse())
        server.enqueue(challengeResponse(NONCE_B, "GET", SYNC_STATUS_PATH, EMPTY_SHA256, "sync.status"))
        server.enqueue(successResponse())
        val client = client(DeviceProofSigner(::proofFor))

        assertTrue(client.get(SYNC_STATUS_PATH, TestReply.serializer()) is ApiResult.Success)
        assertTrue(client.get(SYNC_STATUS_PATH, TestReply.serializer()) is ApiResult.Success)

        server.takeRequest()
        val firstData = server.takeRequest()
        server.takeRequest()
        val secondData = server.takeRequest()
        assertEquals(NONCE_A, firstData.getHeader(HEADER_SERVER_NONCE))
        assertEquals(NONCE_B, secondData.getHeader(HEADER_SERVER_NONCE))
        assertNotEquals(firstData.getHeader(HEADER_DEVICE_PROOF), secondData.getHeader(HEADER_DEVICE_PROOF))
    }

    @Test
    fun `401 retry refreshes access and obtains a fresh challenge`() = runTest {
        server.enqueue(challengeResponse(NONCE_A, "GET", SYNC_STATUS_PATH, EMPTY_SHA256, "sync.status"))
        server.enqueue(
            MockResponse().setResponseCode(401).setBody(
                """{"ok":false,"error":{"code":"access_expired","message":"expired","retryable":false}}""",
            ),
        )
        server.enqueue(challengeResponse(NONCE_B, "GET", SYNC_STATUS_PATH, EMPTY_SHA256, "sync.status"))
        server.enqueue(successResponse())
        var refreshes = 0
        val client = client(
            signer = DeviceProofSigner(::proofFor),
            refresher = MobileApiClient.AccessRefresher {
                refreshes += 1
                credentials.replaceBindingCredentials("access-new", null, "refresh-new")
                true
            },
        )

        val result = client.get(SYNC_STATUS_PATH, TestReply.serializer())

        assertTrue(result is ApiResult.Success)
        assertEquals(1, refreshes)
        val challengeOne = server.takeRequest()
        val dataOne = server.takeRequest()
        val challengeTwo = server.takeRequest()
        val dataTwo = server.takeRequest()
        assertEquals("Bearer access-old", challengeOne.getHeader("Authorization"))
        assertEquals("Bearer access-old", dataOne.getHeader("Authorization"))
        assertEquals("Bearer access-new", challengeTwo.getHeader("Authorization"))
        assertEquals("Bearer access-new", dataTwo.getHeader("Authorization"))
        assertEquals(NONCE_A, dataOne.getHeader(HEADER_SERVER_NONCE))
        assertEquals(NONCE_B, dataTwo.getHeader(HEADER_SERVER_NONCE))
    }

    @Test
    fun `mismatched challenge fails closed before protected request`() = runTest {
        server.enqueue(
            challengeResponse(
                NONCE_A,
                "GET",
                "/api/mobile/v1/sync/changes",
                EMPTY_SHA256,
                "sync.status",
            ),
        )
        val client = client(DeviceProofSigner(::proofFor))

        val result = client.get(SYNC_STATUS_PATH, TestReply.serializer())

        assertTrue(result is ApiResult.Failure)
        val error = (result as ApiResult.Failure).error
        assertEquals("malformed_response", error.code)
        assertTrue(
            error.persistedDiagnosticText().startsWith("device-proof validate: challenge fields do not match request binding"),
        )
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `signer failure never exposes exception secret in diagnostics`() = runTest {
        val signerSecret = "private-key-provider-secret"
        server.enqueue(challengeResponse(NONCE_A, "GET", SYNC_STATUS_PATH, EMPTY_SHA256, "sync.status"))
        val client = client(DeviceProofSigner { throw IllegalStateException(signerSecret) })

        val result = client.get(SYNC_STATUS_PATH, TestReply.serializer())

        assertTrue(result is ApiResult.Failure)
        val error = (result as ApiResult.Failure).error
        assertEquals("device_key_unavailable", error.code)
        assertFalse(error.message.contains(signerSecret))
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `challenge diagnostic text redacts nonce and canonical query`() {
        val challenge = DeviceProofChallenge(
            nonce = NONCE_A,
            timestamp = TIMESTAMP,
            expiresAt = TIMESTAMP * 1000L + 30_000L,
            method = "GET",
            canonicalPath = "/api/mobile/v1/sync/bootstrap?pageToken=sensitive-token",
            bodySha256 = EMPTY_SHA256,
            usage = "sync.bootstrap",
        )

        val diagnostic = challenge.toString()

        assertFalse(diagnostic.contains(NONCE_A))
        assertFalse(diagnostic.contains("sensitive-token"))
        assertTrue(diagnostic.contains("[redacted]"))
    }

    @Test
    fun `cancellation from signer propagates unchanged`() = runTest {
        server.enqueue(challengeResponse(NONCE_A, "GET", SYNC_STATUS_PATH, EMPTY_SHA256, "sync.status"))
        val cancelled = CancellationException("cancel proof")
        val client = client(DeviceProofSigner { throw cancelled })

        var observed: CancellationException? = null
        try {
            client.get(SYNC_STATUS_PATH, TestReply.serializer())
        } catch (failure: CancellationException) {
            observed = failure
        }

        assertTrue(observed === cancelled)
        assertEquals(1, server.requestCount)
    }

    private fun client(
        signer: DeviceProofSigner,
        refresher: MobileApiClient.AccessRefresher = MobileApiClient.AccessRefresher { false },
    ): MobileApiClient = MobileApiClient(
        endpoint = ApiEndpoint("https://example.test/", TlsPolicy.SystemTrust),
        credentials = credentials,
        refresher = refresher,
        appVersion = "test",
        proofSigner = signer,
        clientBuilder = OkHttpClient.Builder().addInterceptor { chain ->
            val original = chain.request()
            val localUrl = server.url("/").newBuilder()
                .encodedPath(original.url.encodedPath)
                .encodedQuery(original.url.encodedQuery)
                .build()
            chain.proceed(original.newBuilder().url(localUrl).build())
        },
    )

    private fun challengeResponse(
        nonce: String,
        method: String,
        canonicalPath: String,
        bodySha256: String,
        usage: String,
    ): MockResponse {
        val payload = DeviceProofChallengeResponseDto(
            ok = true,
            challenge = DeviceProofChallengeDto(
                nonce = nonce,
                timestamp = TIMESTAMP,
                expiresAt = TIMESTAMP * 1000L + 30_000L,
                method = method,
                canonicalPath = canonicalPath,
                bodySha256 = bodySha256,
                usage = usage,
                algorithm = "ES256",
                signatureFormat = "P1363",
                proofVersion = PROOF_VERSION,
            ),
        )
        return MockResponse()
            .setHeader("Content-Type", "application/json")
            .setBody(MobileJson.instance.encodeToString(DeviceProofChallengeResponseDto.serializer(), payload))
    }

    private fun successResponse(): MockResponse = MockResponse()
        .setHeader("Content-Type", "application/json")
        .setBody("""{"ok":true}""")

    private fun proofFor(challenge: DeviceProofChallenge): String =
        Base64Codec.encode(ByteArray(64) { challenge.nonce.first().code.toByte() })

    private fun sha256(bytes: ByteArray): String =
        Base64Codec.encode(MessageDigest.getInstance("SHA-256").digest(bytes))

    @Serializable
    private data class TestReply(val ok: Boolean)

    @Serializable
    private data class TestPushBody(val message: String, val sequence: Int)

    private companion object {
        val CREDENTIAL_SCOPE = CredentialScope("server/user/device", "1:1")
        const val TIMESTAMP = 1_700_000_000L
        const val NONCE_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        const val NONCE_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
        const val EMPTY_SHA256 = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="
        const val SYNC_STATUS_PATH = "/api/mobile/v1/sync/status"
    }
}

private class TestCredentialPersistence : CredentialPersistence {
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
