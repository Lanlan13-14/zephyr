package one.zephyr.mobile.network

import java.io.IOException
import java.util.UUID
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.Response
import okhttp3.ResponseBody
import one.zephyr.mobile.contracts.MobileApiPaths
import okio.Buffer
import okio.BufferedSource
import okio.ForwardingSource
import okio.buffer

/**
 * Request identity.
 *
 * Every request carries a client-generated requestId so a support log can be correlated with the
 * server without logging a host, a path or a credential (MobileError.diagnosticText is built from
 * exactly this plus the code).
 */
class RequestIdInterceptor(private val idFactory: () -> String = { UUID.randomUUID().toString() }) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (request.header(HEADER_REQUEST_ID) != null) return chain.proceed(request)
        return chain.proceed(request.newBuilder().header(HEADER_REQUEST_ID, idFactory()).build())
    }

    companion object {
        const val HEADER_REQUEST_ID = "X-Zephyr-Request-Id"
    }
}

/**
 * Marks the caller as a native client.
 *
 * ZEPHYR_PARITY.md 68: the main end only returns the SID in JSON when the request declares itself
 * a native client, because the browser flow relies on a cookie instead.
 */
class ClientHeaderInterceptor(private val appVersion: String, private val platform: String = "android") : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request().newBuilder()
            .header("X-Zephyr-One-Client", "1")
            .header("X-Zephyr-One-Platform", platform)
            .header("X-Zephyr-One-Version", appVersion)
            .header("X-Zephyr-Protocol-Version", MobileApiPaths.PROTOCOL_VERSION.toString())
            .build()
        return chain.proceed(request)
    }
}

/**
 * Attaches the correct credential for the plane being addressed.
 *
 * The refresh credential is never attached here. It is single-use and is only ever sent in the body
 * of the refresh call, so a leaked bearer header cannot be replayed to mint new access credentials.
 */
class AuthInterceptor(
    private val credentials: CredentialStore,
    private val managementPaths: Set<String> = DEFAULT_MANAGEMENT_PATHS,
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (request.header(HEADER_SKIP_AUTH) != null) {
            return chain.proceed(request.newBuilder().removeHeader(HEADER_SKIP_AUTH).build())
        }

        val builder = request.newBuilder()
        val path = request.url.encodedPath
        if (managementPaths.any { path.startsWith(it) }) {
            credentials.sid()?.let { builder.header("X-Zephyr-Sid", it) }
        } else {
            credentials.accessCredential()?.let { builder.header("Authorization", "Bearer " + it) }
        }
        return chain.proceed(builder.build())
    }

    companion object {
        const val HEADER_SKIP_AUTH = "X-Zephyr-Skip-Auth"

        /** Account, bind and sensitive-verification endpoints use SID; data-plane paths use access. */
        val DEFAULT_MANAGEMENT_PATHS: Set<String> = setOf(
            "/api/auth/",
            MobileApiPaths.POST_MOBILE_V1_DEVICES_BIND,
            MobileApiPaths.POST_MOBILE_V1_SENSITIVE_VERIFY,
            ClientTokenManagementPaths.TOKENS,
        )
    }
}

/** Raised without including any response bytes so an error body cannot enter diagnostics. */
internal class ResponseSizeLimitExceededException(val limitBytes: Long) :
    IOException("response exceeds the " + limitBytes + " byte limit")

/**
 * Refuses an oversized response before or while it is buffered.
 *
 * Content-Length is only a fast rejection path. Chunked, decompressed, missing-length and falsely
 * declared bodies are all bounded by [LimitedResponseBody] as the caller consumes their source.
 */
class ResponseSizeLimitInterceptor(private val maxBytes: Long = DEFAULT_MAX_BYTES) : Interceptor {

    init {
        require(maxBytes >= 0L) { "response size limit must not be negative" }
    }

    override fun intercept(chain: Interceptor.Chain): Response {
        val response = chain.proceed(chain.request())
        val body = response.body ?: return response
        val declared = body.contentLength()
        if (declared > maxBytes) {
            chain.call().cancel()
            response.close()
            throw ResponseSizeLimitExceededException(maxBytes)
        }
        return response.newBuilder()
            .body(body.withResponseSizeLimit(maxBytes) { chain.call().cancel() })
            .build()
    }

    companion object {
        /** Generous enough for a full bootstrap page, far below an OOM on a 2 GB device. */
        const val DEFAULT_MAX_BYTES: Long = 32L * 1024 * 1024
    }
}

internal fun ResponseBody.withResponseSizeLimit(
    maxBytes: Long,
    onLimitExceeded: () -> Unit,
): ResponseBody {
    require(maxBytes >= 0L) { "response size limit must not be negative" }
    return LimitedResponseBody(this, maxBytes, onLimitExceeded)
}

private class LimitedResponseBody(
    private val delegate: ResponseBody,
    maxBytes: Long,
    onLimitExceeded: () -> Unit,
) : ResponseBody() {

    private val limitedSource: BufferedSource by lazy {
        LimitedSource(delegate.source(), maxBytes, onLimitExceeded).buffer()
    }

    override fun contentType(): MediaType? = delegate.contentType()

    override fun contentLength(): Long = delegate.contentLength()

    override fun source(): BufferedSource = limitedSource
}

private class LimitedSource(
    delegate: BufferedSource,
    private val maxBytes: Long,
    private val onLimitExceeded: () -> Unit,
) : ForwardingSource(delegate) {

    private val probe = Buffer()
    private var totalBytesRead = 0L
    private var failure: ResponseSizeLimitExceededException? = null

    override fun read(sink: Buffer, byteCount: Long): Long {
        failure?.let { throw it }
        if (byteCount == 0L) return 0L

        val remaining = maxBytes - totalBytesRead
        val probeByteCount = if (remaining == Long.MAX_VALUE) {
            byteCount
        } else {
            minOf(byteCount, remaining + 1L)
        }
        val read = super.read(probe, probeByteCount)
        if (read == -1L) return -1L
        if (read > remaining) failLimit()

        totalBytesRead += read
        sink.write(probe, read)
        return read
    }

    private fun failLimit(): Nothing {
        val exception = ResponseSizeLimitExceededException(maxBytes)
        failure = exception
        runCatching { onLimitExceeded() }
        runCatching { super.close() }
        throw exception
    }
}
