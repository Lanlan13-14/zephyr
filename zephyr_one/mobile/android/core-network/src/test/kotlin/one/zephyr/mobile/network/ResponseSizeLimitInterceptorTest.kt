package one.zephyr.mobile.network

import java.util.concurrent.TimeUnit
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.ResponseBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import okio.BufferedSource
import okio.Source
import okio.Timeout
import okio.buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ResponseSizeLimitInterceptorTest {

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
    fun `chunked 33 MiB response is cancelled and its connection is closed`() {
        val chunkedBody = Buffer().write(ByteArray(OVERSIZED_BYTES.toInt()))
        server.enqueue(
            MockResponse()
                .setResponseCode(500)
                .setChunkedBody(chunkedBody, 64 * 1024),
        )
        server.enqueue(MockResponse().setBody("next response"))
        val client = OkHttpClient.Builder()
            .addInterceptor(ResponseSizeLimitInterceptor())
            .build()

        val oversizedCall = client.newCall(Request.Builder().url(server.url("/oversized")).build())
        val response = oversizedCall.execute()
        val failure = assertThrows(ResponseSizeLimitExceededException::class.java) {
            response.use { it.body!!.string() }
        }

        assertEquals(
            "response exceeds the 33554432 byte limit",
            failure.message,
        )
        assertTrue(oversizedCall.isCanceled())

        client.newCall(Request.Builder().url(server.url("/next")).build()).execute().use {
            assertEquals("next response", it.body!!.string())
        }
        assertEquals(0, server.takeRequest(5, TimeUnit.SECONDS)!!.sequenceNumber)
        assertEquals(0, server.takeRequest(5, TimeUnit.SECONDS)!!.sequenceNumber)
    }

    @Test
    fun `declared one byte cannot bypass the actual 33 MiB limit`() {
        val body = GeneratedResponseBody(declaredLength = 1L, actualLength = OVERSIZED_BYTES)
        var cancellationCount = 0
        val limited = body.withResponseSizeLimit(ResponseSizeLimitInterceptor.DEFAULT_MAX_BYTES) {
            cancellationCount += 1
        }

        val failure = assertThrows(ResponseSizeLimitExceededException::class.java) {
            limited.string()
        }

        assertEquals(ResponseSizeLimitInterceptor.DEFAULT_MAX_BYTES, failure.limitBytes)
        assertEquals(1, cancellationCount)
        assertTrue(body.closed)
    }

    @Test
    fun `body exactly equal to the limit is accepted`() {
        val limit = ResponseSizeLimitInterceptor.DEFAULT_MAX_BYTES
        val body = GeneratedResponseBody(declaredLength = limit, actualLength = limit)
        val limited = body.withResponseSizeLimit(limit) {
            throw AssertionError("an exact-limit response must not be cancelled")
        }

        var consumed = 0L
        val scratch = Buffer()
        limited.use {
            while (true) {
                val read = it.source().read(scratch, 64 * 1024L)
                if (read == -1L) break
                consumed += read
                scratch.clear()
            }
        }

        assertEquals(limit, consumed)
        assertTrue(body.closed)
    }

    @Test
    fun `limit exception never contains response bytes`() {
        val secret = "server-secret-that-must-not-escape"
        val body = GeneratedResponseBody(
            declaredLength = -1L,
            actualLength = 2_048L,
            prefix = secret.toByteArray(),
        )
        val limited = body.withResponseSizeLimit(1_024L) {}

        val failure = assertThrows(ResponseSizeLimitExceededException::class.java) {
            limited.string()
        }

        assertFalse(failure.message.orEmpty().contains(secret))
        assertEquals("response exceeds the 1024 byte limit", failure.message)
    }

    private class GeneratedResponseBody(
        private val declaredLength: Long,
        actualLength: Long,
        prefix: ByteArray = ByteArray(0),
    ) : ResponseBody() {

        private val generatedSource = GeneratedSource(actualLength, prefix)
        private val bufferedSource: BufferedSource = generatedSource.buffer()

        val closed: Boolean get() = generatedSource.closed

        override fun contentType(): MediaType? = null

        override fun contentLength(): Long = declaredLength

        override fun source(): BufferedSource = bufferedSource
    }

    private class GeneratedSource(
        actualLength: Long,
        prefix: ByteArray,
    ) : Source {

        private val timeout = Timeout()
        private var remaining = actualLength
        private var prefixOffset = 0
        private val prefixBytes = prefix.copyOf()
        var closed = false
            private set

        override fun read(sink: Buffer, byteCount: Long): Long {
            check(!closed) { "source is closed" }
            if (remaining == 0L) return -1L
            val count = minOf(byteCount, remaining, GENERATED_CHUNK.size.toLong()).toInt()
            val prefixCount = minOf(count, prefixBytes.size - prefixOffset)
            if (prefixCount > 0) {
                sink.write(prefixBytes, prefixOffset, prefixCount)
                prefixOffset += prefixCount
            }
            if (prefixCount < count) {
                sink.write(GENERATED_CHUNK, 0, count - prefixCount)
            }
            remaining -= count
            return count.toLong()
        }

        override fun timeout(): Timeout = timeout

        override fun close() {
            closed = true
        }
    }

    private companion object {
        const val OVERSIZED_BYTES = 33L * 1024 * 1024
        val GENERATED_CHUNK = ByteArray(8 * 1024)
    }
}
