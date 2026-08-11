package one.zephyr.mobile.network

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.builtins.serializer
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.Source
import okio.Timeout
import okio.buffer
import one.zephyr.mobile.model.SecretRef
import one.zephyr.mobile.model.TlsPolicy
import one.zephyr.mobile.security.SecretBlobStore
import one.zephyr.mobile.security.SecretStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileApiClientResponseLimitTest {

    @Test
    fun `oversized error response maps to stable local error without body bytes`() = runTest {
        val responseBody = LimitFailingResponseBody()
        val client = MobileApiClient(
            endpoint = ApiEndpoint("https://example.test/", TlsPolicy.SystemTrust),
            credentials = CredentialStore(
                secretStore = SecretStore(
                    blobs = EmptySecretBlobStore,
                    scope = SecretStore.SecretScope("server", "user", "device"),
                ),
                scope = CredentialScope("server/user/device", "1:1"),
            ),
            refresher = MobileApiClient.AccessRefresher { false },
            appVersion = "test",
            proofSigner = DeviceProofSigner { error("proof signer must not run") },
            clientBuilder = OkHttpClient.Builder().addInterceptor { chain ->
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(500)
                    .message("Server Error")
                    .header(RequestIdInterceptor.HEADER_REQUEST_ID, "request-1")
                    .body(responseBody)
                    .build()
            },
        )

        val result = client.get(
            path = "/error",
            responseSerializer = String.serializer(),
            authenticated = false,
        )

        assertTrue(result is ApiResult.Failure)
        val error = (result as ApiResult.Failure).error
        assertEquals("response_too_large", error.code)
        assertEquals("response exceeds the 33554432 byte limit", error.message)
        assertEquals(500, error.httpStatus)
        assertEquals("request-1", error.requestId)
        assertFalse(error.message.contains(SENSITIVE_BODY))
        assertTrue(responseBody.closed)
    }

    private class LimitFailingResponseBody : ResponseBody() {

        private val failingSource = object : Source {
            private val timeout = Timeout()

            var closed = false

            override fun read(sink: Buffer, byteCount: Long): Long {
                sink.writeUtf8(SENSITIVE_BODY)
                throw ResponseSizeLimitExceededException(ResponseSizeLimitInterceptor.DEFAULT_MAX_BYTES)
            }

            override fun timeout(): Timeout = timeout

            override fun close() {
                closed = true
            }
        }
        private val bufferedSource: BufferedSource = failingSource.buffer()

        val closed: Boolean get() = failingSource.closed

        override fun contentType(): MediaType? = null

        override fun contentLength(): Long = -1L

        override fun source(): BufferedSource = bufferedSource
    }

    private object EmptySecretBlobStore : SecretBlobStore {
        override fun read(ref: SecretRef): ByteArray? = null

        override fun write(ref: SecretRef, blob: ByteArray) = Unit

        override fun delete(ref: SecretRef) = Unit

        override fun listRefs(): List<SecretRef> = emptyList()

        override fun deleteAll() = Unit
    }

    private companion object {
        const val SENSITIVE_BODY = "server-secret-that-must-not-escape"
    }
}
