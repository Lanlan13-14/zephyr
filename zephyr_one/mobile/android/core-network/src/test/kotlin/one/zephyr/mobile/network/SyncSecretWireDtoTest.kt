package one.zephyr.mobile.network

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.model.Base64Codec
import one.zephyr.mobile.model.PendingOperation
import one.zephyr.mobile.model.SecretEnvelope
import one.zephyr.mobile.model.TlsPolicy
import one.zephyr.mobile.model.persistedDiagnosticText
import one.zephyr.mobile.network.dto.toDto
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class SyncSecretWireDtoTest {

    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `pure clear is explicit and does not require a field mask or envelope`() {
        val dto = operation(clearSecretFields = listOf("password")).toDto(envelopes = null)

        assertEquals(emptyList<String>(), dto.fieldMask)
        assertEquals(listOf("password"), dto.clearSecretFields)
        assertNull(dto.secretEnvelopes)
    }

    @Test
    fun `replacement requires exactly its envelopes and cannot mix with clear`() {
        val replacement = operation(secretFields = listOf("password"))
        val envelope = envelope()

        assertEquals(
            setOf("password"),
            replacement.toDto(mapOf("password" to envelope)).secretEnvelopes!!.keys,
        )
        assertRejected { replacement.toDto(emptyMap()) }
        assertRejected {
            replacement.copy(clearSecretFields = listOf("privateKey"))
                .toDto(mapOf("password" to envelope))
        }
    }

    @Test
    fun `unknown envelope fields and plaintext secrets fail closed`() = runTest {
        assertRejected { operation().toDto(mapOf("notASecret" to envelope())) }
        assertRejected {
            operation(payload = JsonObject(mapOf("password" to JsonPrimitive("plaintext"))))
                .toDto(emptyMap())
        }
        assertMalformedInboundChange(
            extraFields = ",\"secretEnvelopes\":{\"notASecret\":${envelopeJson()}}",
        )
        assertMalformedInboundChange(payloadJson = "{\"password\":\"plaintext\"}")
    }

    private fun operation(
        payload: JsonObject = JsonObject(emptyMap()),
        secretFields: List<String> = emptyList(),
        clearSecretFields: List<String> = emptyList(),
    ) = PendingOperation(
        opId = "op-1",
        entityType = "connection",
        entityId = "c-1",
        action = SyncAction.UPSERT,
        baseRevision = 1,
        fieldMask = emptyList(),
        payload = payload,
        createdAt = 1,
        secretFields = secretFields,
        clearSecretFields = clearSecretFields,
    )

    private fun envelope() = SecretEnvelope(
        v = 1,
        alg = "ML-KEM-768+AES-256-GCM",
        kem = "ML-KEM-768",
        aead = "AES-256-GCM",
        ct = "ct",
        iv = "iv",
        tag = "tag",
        data = "data",
        aad = "aad",
        keyVersion = 1,
        entityRevision = 2,
    )

    private fun assertRejected(block: () -> Unit) {
        val failure = runCatching(block).exceptionOrNull()
        assertTrue("expected a fail-closed wire rejection", failure is IllegalArgumentException)
    }

    private suspend fun assertMalformedInboundChange(
        payloadJson: String = "{}",
        extraFields: String = "",
    ) {
        server.enqueue(challengeResponse())
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "application/json")
                .setBody(
                    """
                    {"ok":true,"fromCursor":0,"nextCursor":1,"hasMore":false,"changes":[{
                      "changeSeq":1,"entityType":"connection","entityId":"c-1","action":"upsert",
                      "revision":2,"changedAt":3,"fieldMask":[],"payload":$payloadJson$extraFields
                    }]}
                    """.trimIndent(),
                ),
        )

        val result = api().changes(sinceCursor = 0, limit = null)

        assertTrue(result is ApiResult.Failure)
        val error = (result as ApiResult.Failure).error
        assertEquals("malformed_response", error.code)
        assertTrue(
            error.persistedDiagnosticText().startsWith("sync.changes map: sync change "),
        )
    }

    private fun api(): MobileApi {
        val credentials = CredentialStore(WireCredentialPersistence(), CredentialScope("server/user/device", "1:1"))
            .apply { replaceBindingCredentials("access", null, "refresh") }
        val client = MobileApiClient(
            endpoint = ApiEndpoint("https://example.test/", TlsPolicy.SystemTrust),
            credentials = credentials,
            refresher = MobileApiClient.AccessRefresher { false },
            appVersion = "test",
            proofSigner = DeviceProofSigner { Base64Codec.encode(ByteArray(64)) },
            clientBuilder = OkHttpClient.Builder().addInterceptor { chain ->
                val original = chain.request()
                val localUrl = server.url("/").newBuilder()
                    .encodedPath(original.url.encodedPath)
                    .encodedQuery(original.url.encodedQuery)
                    .build()
                chain.proceed(original.newBuilder().url(localUrl).build())
            },
        )
        return MobileApi(client)
    }

    private fun challengeResponse(): MockResponse = MockResponse()
        .setHeader("Content-Type", "application/json")
        .setBody(
            """
            {"ok":true,"challenge":{
              "nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
              "timestamp":1700000000,"expiresAt":1700000030000,
              "method":"GET","canonicalPath":"/api/mobile/v1/sync/changes?sinceCursor=0",
              "bodySha256":"47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
              "usage":"sync.changes","algorithm":"ES256","signatureFormat":"P1363",
              "proofVersion":"zephyr-one-device-proof-v2"
            }}
            """.trimIndent(),
        )

    private fun envelopeJson(): String =
        "{\"v\":1,\"alg\":\"ML-KEM-768+AES-256-GCM\",\"kem\":\"ML-KEM-768\"," +
            "\"aead\":\"AES-256-GCM\",\"ct\":\"ct\",\"iv\":\"iv\",\"tag\":\"tag\"," +
            "\"data\":\"data\",\"aad\":\"aad\",\"keyVersion\":1,\"entityRevision\":2}"

    private class WireCredentialPersistence : CredentialPersistence {
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
}
