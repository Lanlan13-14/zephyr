package one.zephyr.mobile.network

import java.util.UUID
import okhttp3.Interceptor
import okhttp3.Response
import one.zephyr.mobile.contracts.MobileApiPaths

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

        /** The bind and account endpoints are SID-authenticated; everything else uses device access. */
        val DEFAULT_MANAGEMENT_PATHS: Set<String> = setOf(
            "/api/auth/",
            MobileApiPaths.POST_MOBILE_V1_DEVICES_BIND,
        )
    }
}

/**
 * Signs the request with the ES256 device key.
 *
 * The proof covers method, path, a digest of the body and a timestamp (DATA_AND_MIGRATION.md 5.6),
 * so a captured request cannot be replayed against a different route or with a mutated body even if
 * the access credential leaks.
 */
class DeviceProofInterceptor(private val signer: DeviceProofSigner) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val bodyBytes = request.body?.let { body ->
            val buffer = okio.Buffer()
            body.writeTo(buffer)
            buffer.readByteArray()
        } ?: ByteArray(0)

        val proof = signer.sign(
            method = request.method,
            path = request.url.encodedPath,
            body = bodyBytes,
            nonce = request.header(HEADER_SERVER_NONCE),
        ) ?: return chain.proceed(request)

        return chain.proceed(request.newBuilder().header("X-Zephyr-Device-Proof", proof).build())
    }

    companion object {
        const val HEADER_SERVER_NONCE = "X-Zephyr-Server-Nonce"
    }
}

/** Implemented by core-security's DeviceIdentity; null means the device has no signing key yet. */
fun interface DeviceProofSigner {
    fun sign(method: String, path: String, body: ByteArray, nonce: String?): String?
}

/**
 * Refuses an oversized response before it is buffered.
 *
 * A change page or bootstrap page is bounded by the server, but a compromised or misconfigured
 * endpoint must not be able to drive One out of memory on a low-end device.
 */
class ResponseSizeLimitInterceptor(private val maxBytes: Long = DEFAULT_MAX_BYTES) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val response = chain.proceed(chain.request())
        val declared = response.header("Content-Length")?.toLongOrNull()
        if (declared != null && declared > maxBytes) {
            response.close()
            throw java.io.IOException("response exceeds the " + maxBytes + " byte limit")
        }
        return response
    }

    companion object {
        /** Generous enough for a full bootstrap page, far below an OOM on a 2 GB device. */
        const val DEFAULT_MAX_BYTES: Long = 32L * 1024 * 1024
    }
}
