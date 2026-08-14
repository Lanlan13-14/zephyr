package one.zephyr.mobile.network

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import one.zephyr.mobile.model.TlsPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ClientTokenManagementApiTest {

    private lateinit var server: MockWebServer
    private lateinit var api: ClientTokenManagementApi

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        val credentials = CredentialStore(TokenManagementCredentialPersistence(), CREDENTIAL_SCOPE).apply {
            storeSid(SID)
            replaceBindingCredentials("access-credential", null, "refresh-credential")
        }
        api = ClientTokenManagementApi(
            MobileApiClient(
                endpoint = ApiEndpoint("https://example.test/", TlsPolicy.SystemTrust),
                credentials = credentials,
                refresher = MobileApiClient.AccessRefresher { false },
                appVersion = "test",
                proofSigner = DeviceProofSigner { error("management calls must not request device proof") },
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
    fun `rotate uses canonical management route and SID without bearer or device proof`() = runTest {
        server.enqueue(tokenResponse(id = "token-1", secret = TOKEN_SECRET, revision = 7))

        val result = api.rotate("token-1", "password-or-totp")

        assertTrue(result is ApiResult.Success)
        val token = (result as ApiResult.Success).value
        assertEquals("token-1", token.id)
        assertEquals(TOKEN_SECRET, token.secret)
        assertFalse(token.toString().contains(TOKEN_SECRET))

        val request = server.takeRequest()
        assertEquals("/api/rdp/file-agent-tokens/token-1/regenerate", request.path)
        assertEquals(SID, request.getHeader("X-Zephyr-Sid"))
        assertNull(request.getHeader("Authorization"))
        assertNull(request.getHeader(HEADER_DEVICE_PROOF))
        val body = MobileJson.instance.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("password-or-totp", body.getValue("secret").jsonPrimitive.content)
        assertEquals(setOf("secret"), body.keys)
    }

    @Test
    fun `reset all returns only the minted token and keeps verification out of diagnostics`() = runTest {
        server.enqueue(tokenResponse(id = "token-fresh", secret = TOKEN_SECRET, revision = 1))

        val result = api.resetAll("One Android", "123456")

        assertTrue(result is ApiResult.Success)
        val request = server.takeRequest()
        assertEquals("/api/rdp/file-agent-tokens/reset-all", request.path)
        val bodyText = request.body.readUtf8()
        val body = MobileJson.instance.parseToJsonElement(bodyText).jsonObject
        assertEquals("123456", body.getValue("secret").jsonPrimitive.content)
        assertEquals("One Android", body.getValue("name").jsonPrimitive.content)
        assertEquals(setOf("secret", "name"), body.keys)
    }

    @Test
    fun `delete uses the JSON body route and rejects path injection locally`() = runTest {
        server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("""{"ok":true}"""))

        val deleted = api.delete("legacy.token:2", "password")

        assertTrue(deleted is ApiResult.Success)
        assertEquals("/api/rdp/file-agent-tokens/legacy.token:2/delete", server.takeRequest().path)
        assertThrows(IllegalArgumentException::class.java) {
            ClientTokenManagementPaths.rotate("../other")
        }
        assertThrows(IllegalArgumentException::class.java) {
            ClientTokenManagementPaths.rotate("..")
        }
    }

    private fun tokenResponse(id: String, secret: String, revision: Long): MockResponse = MockResponse()
        .setHeader("Content-Type", "application/json")
        .setBody(
            """{"ok":true,"token":{"id":"$id","name":"One Android","token":"$secret","revision":$revision,"createdAt":100,"updatedAt":200,"lastUsedAt":null}}""",
        )

    private companion object {
        val CREDENTIAL_SCOPE = CredentialScope("server/user/device", "1:1")
        const val SID = "session-id-from-server"
        const val TOKEN_SECRET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"
    }
}

private class TokenManagementCredentialPersistence : CredentialPersistence {
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
