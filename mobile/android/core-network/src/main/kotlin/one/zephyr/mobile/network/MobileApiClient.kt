package one.zephyr.mobile.network

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationStrategy
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.TlsPolicy

/** Everything the client needs to address one server profile. */
data class ApiEndpoint(
    val baseUrl: String,
    val tlsPolicy: TlsPolicy,
) {
    init {
        require(baseUrl.startsWith("https://")) { "Zephyr One only talks to HTTPS endpoints" }
    }

    val host: String get() = baseUrl.toHttpUrl().host
}

/**
 * The single HTTP stack.
 *
 * DEVELOPMENT.md 215 mandates one network stack rather than a per-feature client, so connection
 * reuse, timeouts, TLS policy and the credential rules are decided in exactly one place.
 *
 * Two behaviours here are correctness requirements rather than tuning:
 *
 *  1. **Exactly one refresh per 401.** A 401 triggers at most one refresh attempt, serialised by
 *     [refreshMutex]. Without the mutex a burst of parallel requests would each spend the
 *     single-use refresh credential and every one after the first would fail, cascading the binding
 *     into REAUTH_REQUIRED even though the credential was still valid.
 *
 *  2. **Redirects are not followed.** OkHttp would otherwise replay the Authorization header at the
 *     redirect target. The mobile API never legitimately redirects, so a 3xx is surfaced as an
 *     error instead of quietly forwarding a bearer token to another host.
 */
class MobileApiClient(
    private val endpoint: ApiEndpoint,
    private val credentials: CredentialStore,
    private val refresher: AccessRefresher,
    appVersion: String,
    proofSigner: DeviceProofSigner? = null,
    clientBuilder: OkHttpClient.Builder = OkHttpClient.Builder(),
) {

    /** Refreshes the access credential. Implemented over the typed API in [MobileApi]. */
    fun interface AccessRefresher {
        suspend fun refresh(): Boolean
    }

    private val refreshMutex = Mutex()

    private val client: OkHttpClient = TlsConfigurator
        .apply(clientBuilder, endpoint.tlsPolicy, endpoint.host)
        .connectTimeout(CONNECT_TIMEOUT_SEC, TimeUnit.SECONDS)
        .readTimeout(READ_TIMEOUT_SEC, TimeUnit.SECONDS)
        .writeTimeout(WRITE_TIMEOUT_SEC, TimeUnit.SECONDS)
        .callTimeout(CALL_TIMEOUT_SEC, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        // See the class comment: never replay credentials at a redirect target.
        .followRedirects(false)
        .followSslRedirects(false)
        .addInterceptor(RequestIdInterceptor())
        .addInterceptor(ClientHeaderInterceptor(appVersion))
        .addInterceptor(AuthInterceptor(credentials))
        .apply { proofSigner?.let { addInterceptor(DeviceProofInterceptor(it)) } }
        .addInterceptor(ResponseSizeLimitInterceptor())
        .build()

    suspend fun <R> get(
        path: String,
        responseSerializer: DeserializationStrategy<R>,
        query: Map<String, String> = emptyMap(),
        authenticated: Boolean = true,
    ): ApiResult<R> = execute(
        builder = { urlBuilder(path, query).let { Request.Builder().url(it).get() } },
        responseSerializer = responseSerializer,
        authenticated = authenticated,
    )

    suspend fun <B, R> post(
        path: String,
        body: B,
        bodySerializer: SerializationStrategy<B>,
        responseSerializer: DeserializationStrategy<R>,
        authenticated: Boolean = true,
    ): ApiResult<R> = execute(
        builder = {
            Request.Builder()
                .url(urlBuilder(path, emptyMap()))
                .post(jsonBody(MobileJson.instance.encodeToString(bodySerializer, body)))
        },
        responseSerializer = responseSerializer,
        authenticated = authenticated,
    )

    suspend fun <B, R> patch(
        path: String,
        body: B,
        bodySerializer: SerializationStrategy<B>,
        responseSerializer: DeserializationStrategy<R>,
    ): ApiResult<R> = execute(
        builder = {
            Request.Builder()
                .url(urlBuilder(path, emptyMap()))
                .patch(jsonBody(MobileJson.instance.encodeToString(bodySerializer, body)))
        },
        responseSerializer = responseSerializer,
        authenticated = true,
    )

    suspend fun <R> delete(
        path: String,
        responseSerializer: DeserializationStrategy<R>,
        sensitiveGrant: String? = null,
    ): ApiResult<R> = execute(
        builder = {
            Request.Builder()
                .url(urlBuilder(path, emptyMap()))
                .apply { sensitiveGrant?.let { header("X-Zephyr-Sensitive-Grant", it) } }
                .delete()
        },
        responseSerializer = responseSerializer,
        authenticated = true,
    )

    /**
     * Runs a request, refreshing once on a 401.
     *
     * [attemptedRefresh] is the recursion guard: a 401 that survives a successful refresh is a real
     * authentication failure and must reach the caller so the binding can move to REAUTH_REQUIRED,
     * not spin.
     */
    private suspend fun <R> execute(
        builder: () -> Request.Builder,
        responseSerializer: DeserializationStrategy<R>,
        authenticated: Boolean,
        attemptedRefresh: Boolean = false,
    ): ApiResult<R> {
        val request = builder()
            .apply { if (!authenticated) header(AuthInterceptor.HEADER_SKIP_AUTH, "1") }
            .build()

        val response = try {
            withContext(Dispatchers.IO) { client.newCall(request).execute() }
        } catch (io: IOException) {
            return ApiResult.Failure(
                MobileError.local(
                    code = "network_unreachable",
                    message = io.message ?: "network error",
                    retryable = true,
                ),
            )
        }

        response.use {
            val requestId = it.header(RequestIdInterceptor.HEADER_REQUEST_ID)
                ?: request.header(RequestIdInterceptor.HEADER_REQUEST_ID)

            if (it.isRedirect) {
                // Deliberate: see the class comment. A redirect is a misconfiguration, not a hop.
                return ApiResult.Failure(
                    MobileError.local("unexpected_redirect", "server attempted a redirect", retryable = false)
                        .copy(httpStatus = it.code, requestId = requestId),
                )
            }

            if (it.code == 401 && authenticated && !attemptedRefresh) {
                val refreshed = refreshOnce()
                if (refreshed) {
                    return execute(builder, responseSerializer, authenticated, attemptedRefresh = true)
                }
            }

            val bodyText = it.body?.string()

            if (!it.isSuccessful) {
                return ApiResult.Failure(
                    ErrorDecoder.decode(
                        status = it.code,
                        body = bodyText,
                        requestId = requestId,
                        retryAfterSeconds = retryAfterSeconds(it),
                    ),
                )
            }

            return try {
                ApiResult.Success(
                    MobileJson.instance.decodeFromString(responseSerializer, bodyText ?: ""),
                    requestId,
                )
            } catch (parse: Exception) {
                ApiResult.Failure(
                    MobileError.local("malformed_response", parse.message ?: "unparseable response")
                        .copy(httpStatus = it.code, requestId = requestId),
                )
            }
        }
    }

    /**
     * Serialises refresh attempts.
     *
     * A caller that arrives while another refresh is in flight waits, then re-checks whether the
     * credential it was missing now exists. This is what keeps a burst of 401s from spending the
     * single-use refresh credential more than once.
     */
    private suspend fun refreshOnce(): Boolean {
        val before = credentials.accessCredential()
        return refreshMutex.withLock {
            val current = credentials.accessCredential()
            if (current != null && current != before) return@withLock true
            refresher.refresh()
        }
    }

    /**
     * 429 and 503 may carry Retry-After, which SYNC_STATE_MACHINE.md 9 says to prefer over the local
     * backoff table. Both the seconds and the HTTP-date form are accepted.
     */
    private fun retryAfterSeconds(response: Response): Long? {
        val header = response.header("Retry-After") ?: return null
        header.trim().toLongOrNull()?.let { return it }
        return runCatching {
            val target = java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME
                .parse(header, java.time.Instant::from)
            val delta = java.time.Duration.between(java.time.Instant.now(), target).seconds
            if (delta > 0) delta else null
        }.getOrNull()
    }

    private fun urlBuilder(path: String, query: Map<String, String>): HttpUrl {
        val builder = endpoint.baseUrl.toHttpUrl().newBuilder()
        for (segment in path.trim('/').split('/')) {
            if (segment.isNotEmpty()) builder.addPathSegment(segment)
        }
        for ((key, value) in query) builder.addQueryParameter(key, value)
        return builder.build()
    }

    private fun jsonBody(text: String): RequestBody = text.toRequestBody(JSON_MEDIA)

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

        /** Long enough for a slow mobile link, short enough that the UI can show a failure. */
        const val CONNECT_TIMEOUT_SEC = 15L
        const val READ_TIMEOUT_SEC = 30L
        const val WRITE_TIMEOUT_SEC = 30L

        /** Bounds a whole call including retries so a hung socket cannot pin a sync round forever. */
        const val CALL_TIMEOUT_SEC = 120L
    }
}
