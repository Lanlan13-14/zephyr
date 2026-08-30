package one.zephyr.mobile.network

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationStrategy
import okhttp3.HttpUrl
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.TlsPolicy
import one.zephyr.mobile.model.withLocalDiagnostic
import one.zephyr.mobile.contracts.MobileApiPaths
import kotlin.coroutines.resume

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
    private val proofSigner: DeviceProofSigner,
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
        // A transparent transport retry would replay a single-use proof below this client.
        .retryOnConnectionFailure(false)
        // See the class comment: never replay credentials at a redirect target.
        .followRedirects(false)
        .followSslRedirects(false)
        .addInterceptor(RequestIdInterceptor())
        .addInterceptor(ClientHeaderInterceptor(appVersion))
        .addInterceptor(AuthInterceptor(credentials))
        .addInterceptor(ResponseSizeLimitInterceptor())
        .build()

    /** Same interceptors and pool, with timeouts disabled only for the heartbeat-backed SSE call. */
    private val streamingClient: OkHttpClient by lazy {
        client.newBuilder()
            .readTimeout(0L, TimeUnit.MILLISECONDS)
            .callTimeout(0L, TimeUnit.MILLISECONDS)
            .build()
    }

    suspend fun openWakeStream(
        lastEventId: String?,
        proofSigner: WakeProofSigner,
        onWake: (WakeStreamEvent) -> Unit,
    ): WakeStreamOutcome {
        val path = MobileApiPaths.GET_MOBILE_V1_SYNC_WAKE
        val unsignedRequest = Request.Builder()
            .url(urlBuilder(path, emptyMap()))
            .get()
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
            .apply {
                lastEventId?.takeIf { it.isNotBlank() }?.let { header(HEADER_LAST_EVENT_ID, it) }
            }
            .build()
        val binding = unsignedRequest.deviceProofBinding()
            ?: return WakeStreamOutcome(failureCode = "device_proof_not_supported")
        val challenge = when (val result = requestProofChallenge(binding)) {
            is ApiResult.Success -> result.value
            is ApiResult.Failure -> return WakeStreamOutcome(
                retryAfterMillis = result.error.retryAfterSeconds?.times(1000L),
                failureCode = result.error.code,
            )
        }

        val proof = try {
            proofSigner.sign(challenge)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return WakeStreamOutcome(failureCode = "device_key_unavailable")
        }
        if (!isStrictP1363Proof(proof)) {
            return WakeStreamOutcome(failureCode = "device_key_unavailable")
        }
        val request = unsignedRequest.newBuilder()
            .header(HEADER_SERVER_NONCE, challenge.nonce)
            .header(HEADER_PROOF_TIMESTAMP, challenge.timestamp.toString())
            .header(HEADER_DEVICE_PROOF, proof)
            .build()
        return awaitWake(request, onWake)
    }

    private suspend fun awaitWake(
        request: Request,
        onWake: (WakeStreamEvent) -> Unit,
    ): WakeStreamOutcome = suspendCancellableCoroutine { continuation ->
        val call = streamingClient.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) {
                if (continuation.isActive) continuation.resume(WakeStreamOutcome())
            }

            override fun onResponse(call: Call, response: Response) {
                val outcome = response.use { current ->
                    val retryAfterMillis = retryAfterSeconds(current)?.times(1000L)
                    if (current.isRedirect) {
                        return@use WakeStreamOutcome(
                            retryAfterMillis = retryAfterMillis,
                            failureCode = "unexpected_redirect",
                        )
                    }
                    if (!current.isSuccessful) {
                        val requestId = current.header(RequestIdInterceptor.HEADER_REQUEST_ID)
                            ?: request.header(RequestIdInterceptor.HEADER_REQUEST_ID)
                        val body = runCatching { current.body?.string() }.getOrNull()
                        val error = ErrorDecoder.decode(current.code, body, requestId, retryAfterSeconds(current))
                        return@use WakeStreamOutcome(
                            retryAfterMillis = error.retryAfterSeconds?.times(1000L),
                            failureCode = error.code,
                        )
                    }
                    val contentType = current.header("Content-Type").orEmpty().lowercase()
                    if (!contentType.startsWith("text/event-stream")) {
                        return@use WakeStreamOutcome(failureCode = "malformed_wake_stream")
                    }
                    val body = current.body
                        ?: return@use WakeStreamOutcome(failureCode = "malformed_wake_stream")
                    val parser = WakeSseParser(onWake)
                    try {
                        while (true) {
                            val line = readBoundedSseLine(body.source()) ?: break
                            parser.accept(line)
                        }
                        WakeStreamOutcome(
                            connected = true,
                            retryAfterMillis = retryAfterMillis,
                            serverRetryMillis = parser.retryMillis,
                        )
                    } catch (_: IOException) {
                        WakeStreamOutcome(
                            connected = true,
                            retryAfterMillis = retryAfterMillis,
                            serverRetryMillis = parser.retryMillis,
                        )
                    }
                }
                if (continuation.isActive) continuation.resume(outcome)
            }
        })
    }

    suspend fun <R> get(
        path: String,
        responseSerializer: DeserializationStrategy<R>,
        query: Map<String, String> = emptyMap(),
        authenticated: Boolean = true,
        responseDiagnosticPhase: String? = null,
    ): ApiResult<R> = execute(
        builder = { urlBuilder(path, query).let { Request.Builder().url(it).get() } },
        responseSerializer = responseSerializer,
        authenticated = authenticated,
        responseDiagnosticPhase = responseDiagnosticPhase,
    )

    suspend fun <B, R> post(
        path: String,
        body: B,
        bodySerializer: SerializationStrategy<B>,
        responseSerializer: DeserializationStrategy<R>,
        authenticated: Boolean = true,
        sensitiveGrant: String? = null,
        responseDiagnosticPhase: String? = null,
    ): ApiResult<R> {
        val grant = when (val validated = validateSensitiveGrant(sensitiveGrant)) {
            is SensitiveGrantValidation.Valid -> validated.value
            SensitiveGrantValidation.Absent -> null
            SensitiveGrantValidation.Invalid -> return invalidSensitiveGrantFailure()
        }
        return execute(
            builder = {
                Request.Builder()
                    .url(urlBuilder(path, emptyMap()))
                    .apply { grant?.let { header(HEADER_SENSITIVE_GRANT, it) } }
                    .post(jsonBody(MobileJson.instance.encodeToString(bodySerializer, body)))
            },
            responseSerializer = responseSerializer,
            authenticated = authenticated,
            responseDiagnosticPhase = responseDiagnosticPhase,
        )
    }

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
    ): ApiResult<R> {
        val grant = when (val validated = validateSensitiveGrant(sensitiveGrant)) {
            is SensitiveGrantValidation.Valid -> validated.value
            SensitiveGrantValidation.Absent -> null
            SensitiveGrantValidation.Invalid -> return invalidSensitiveGrantFailure()
        }
        return execute(
            builder = {
                Request.Builder()
                    .url(urlBuilder(path, emptyMap()))
                    .apply { grant?.let { header(HEADER_SENSITIVE_GRANT, it) } }
                    .delete()
            },
            responseSerializer = responseSerializer,
            authenticated = true,
        )
    }

    /** Sends a blob chunk without converting it through JSON, so the proof hashes the wire bytes. */
    suspend fun <R> putBytes(
        path: String,
        body: ByteArray,
        responseSerializer: DeserializationStrategy<R>,
    ): ApiResult<R> {
        val wireBytes = body.copyOf()
        return try {
            execute(
                builder = {
                    Request.Builder()
                        .url(urlBuilder(path, emptyMap()))
                        .put(wireBytes.toRequestBody(OCTET_STREAM_MEDIA))
                },
                responseSerializer = responseSerializer,
                authenticated = true,
            )
        } finally {
            wireBytes.fill(0)
        }
    }

    /** Reads a protected blob response under the same response-size limit as JSON payloads. */
    suspend fun getBytes(
        path: String,
        query: Map<String, String> = emptyMap(),
    ): ApiResult<ByteArray> = executeBytes(
        builder = { urlBuilder(path, query).let { Request.Builder().url(it).get() } },
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
        responseDiagnosticPhase: String? = null,
    ): ApiResult<R> {
        val request = builder()
            .apply { if (!authenticated) header(AuthInterceptor.HEADER_SKIP_AUTH, "1") }
            .build()

        val authorizedRequest = when (val prepared = authorizeRequest(request, authenticated)) {
            is ApiResult.Success -> prepared.value
            is ApiResult.Failure -> return prepared
        }

        val response = try {
            awaitResponse(client, authorizedRequest)
        } catch (tooLarge: ResponseSizeLimitExceededException) {
            return responseTooLargeFailure(tooLarge)
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
                    return execute(
                        builder,
                        responseSerializer,
                        authenticated,
                        attemptedRefresh = true,
                        responseDiagnosticPhase = responseDiagnosticPhase,
                    )
                }
            }

            val bodyText = try {
                it.body?.string()
            } catch (tooLarge: ResponseSizeLimitExceededException) {
                return responseTooLargeFailure(tooLarge, it.code, requestId)
            } catch (_: IOException) {
                return ApiResult.Failure(
                    MobileError.local(
                        code = "network_unreachable",
                        message = "network error while reading response",
                        retryable = true,
                    ).copy(httpStatus = it.code, requestId = requestId),
                )
            }

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
            } catch (_: Exception) {
                val malformed = MobileError.local("malformed_response", "unparseable response")
                    .copy(httpStatus = it.code, requestId = requestId)
                ApiResult.Failure(
                    responseDiagnosticPhase
                        ?.let { phase -> malformed.withLocalDiagnostic("$phase decode: response did not match DTO") }
                        ?: malformed,
                )
            }
        }
    }

    private suspend fun executeBytes(
        builder: () -> Request.Builder,
        attemptedRefresh: Boolean = false,
    ): ApiResult<ByteArray> {
        val request = builder().build()
        val authorizedRequest = when (val prepared = authorizeRequest(request, authenticated = true)) {
            is ApiResult.Success -> prepared.value
            is ApiResult.Failure -> return prepared
        }
        val response = try {
            awaitResponse(client, authorizedRequest)
        } catch (tooLarge: ResponseSizeLimitExceededException) {
            return responseTooLargeFailure(tooLarge)
        } catch (io: IOException) {
            return networkFailure(io.message ?: "network error")
        }

        response.use {
            val requestId = it.header(RequestIdInterceptor.HEADER_REQUEST_ID)
                ?: request.header(RequestIdInterceptor.HEADER_REQUEST_ID)
            if (it.isRedirect) {
                return ApiResult.Failure(
                    MobileError.local("unexpected_redirect", "server attempted a redirect", retryable = false)
                        .copy(httpStatus = it.code, requestId = requestId),
                )
            }
            if (it.code == 401 && !attemptedRefresh && refreshOnce()) {
                return executeBytes(builder, attemptedRefresh = true)
            }
            if (!it.isSuccessful) {
                val bodyText = try {
                    it.body?.string()
                } catch (tooLarge: ResponseSizeLimitExceededException) {
                    return responseTooLargeFailure(tooLarge, it.code, requestId)
                } catch (_: IOException) {
                    return networkFailure("network error while reading response", it.code, requestId)
                }
                return ApiResult.Failure(
                    ErrorDecoder.decode(it.code, bodyText, requestId, retryAfterSeconds(it)),
                )
            }
            return try {
                ApiResult.Success(it.body?.bytes() ?: ByteArray(0), requestId)
            } catch (tooLarge: ResponseSizeLimitExceededException) {
                responseTooLargeFailure(tooLarge, it.code, requestId)
            } catch (_: IOException) {
                networkFailure("network error while reading response", it.code, requestId)
            }
        }
    }

    private suspend fun authorizeRequest(
        request: Request,
        authenticated: Boolean,
    ): ApiResult<Request> {
        if (!authenticated) return ApiResult.Success(request, null)
        val binding = try {
            request.deviceProofBinding()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return ApiResult.Failure(
                MobileError.local(
                    code = "invalid_request",
                    message = "request cannot be bound to a device proof",
                    retryable = false,
                ),
            )
        }
        return if (binding == null) ApiResult.Success(request, null) else attachDeviceProof(request, binding)
    }

    private suspend fun awaitResponse(
        httpClient: OkHttpClient,
        request: Request,
    ): Response = suspendCancellableCoroutine { continuation ->
        val call = httpClient.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) {
                if (continuation.isActive) continuation.resumeWith(Result.failure(error))
            }

            override fun onResponse(call: Call, response: Response) {
                if (continuation.isActive) {
                    continuation.resume(response)
                } else {
                    response.close()
                }
            }
        })
    }

    private suspend fun attachDeviceProof(
        request: Request,
        binding: DeviceProofBinding,
    ): ApiResult<Request> {
        val challengeResult = requestProofChallenge(binding)
        val challenge = when (challengeResult) {
            is ApiResult.Success -> challengeResult.value
            is ApiResult.Failure -> return challengeResult
        }
        val proof = try {
            proofSigner.sign(challenge)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return ApiResult.Failure(
                MobileError.local(
                    code = "device_key_unavailable",
                    message = "device proof signing failed",
                    retryable = false,
                ),
            )
        }
        if (!isStrictP1363Proof(proof)) {
            return ApiResult.Failure(
                MobileError.local(
                    code = "device_key_unavailable",
                    message = "device proof signature has an invalid format",
                    retryable = false,
                ),
            )
        }
        return ApiResult.Success(
            request.newBuilder()
                .header(HEADER_SERVER_NONCE, challenge.nonce)
                .header(HEADER_PROOF_TIMESTAMP, challenge.timestamp.toString())
                .header(HEADER_DEVICE_PROOF, proof)
                .build(),
            challengeResult.requestId,
        )
    }

    private suspend fun requestProofChallenge(
        binding: DeviceProofBinding,
    ): ApiResult<DeviceProofChallenge> {
        return when (
            val result = post(
                path = MobileApiPaths.POST_MOBILE_V1_DEVICES_PROOF_CHALLENGE,
                body = DeviceProofChallengeRequestDto(
                    method = binding.method,
                    path = binding.challengePath,
                    bodySha256 = binding.bodySha256,
                    usage = binding.usage,
                ),
                bodySerializer = DeviceProofChallengeRequestDto.serializer(),
                responseSerializer = DeviceProofChallengeResponseDto.serializer(),
            )
        ) {
            is ApiResult.Failure -> result
            is ApiResult.Success -> {
                val challenge = result.value
                    .takeIf { it.ok }
                    ?.challenge
                    ?.toChallenge(binding)
                if (challenge == null) {
                    ApiResult.Failure(
                        MobileError.local(
                            code = "malformed_response",
                            message = "server returned an invalid device proof challenge",
                            retryable = false,
                        ).copy(requestId = result.requestId)
                            .withLocalDiagnostic("device-proof validate: challenge fields do not match request binding"),
                    )
                } else {
                    ApiResult.Success(challenge, result.requestId)
                }
            }
        }
    }

    private fun responseTooLargeFailure(
        failure: ResponseSizeLimitExceededException,
        httpStatus: Int? = null,
        requestId: String? = null,
    ): ApiResult.Failure = ApiResult.Failure(
        MobileError.local(
            code = "response_too_large",
            message = failure.message ?: "response exceeds the configured byte limit",
            retryable = false,
        ).copy(httpStatus = httpStatus, requestId = requestId),
    )

    private fun networkFailure(
        message: String,
        httpStatus: Int? = null,
        requestId: String? = null,
    ): ApiResult.Failure = ApiResult.Failure(
        MobileError.local(
            code = "network_unreachable",
            message = message,
            retryable = true,
        ).copy(httpStatus = httpStatus, requestId = requestId),
    )

    private fun invalidSensitiveGrantFailure(): ApiResult.Failure = ApiResult.Failure(
        MobileError.local(
            code = "invalid_request",
            message = "sensitive grant has an invalid format",
            retryable = false,
        ),
    )

    private fun validateSensitiveGrant(value: String?): SensitiveGrantValidation = when {
        value == null -> SensitiveGrantValidation.Absent
        SENSITIVE_GRANT.matches(value) -> SensitiveGrantValidation.Valid(value)
        else -> SensitiveGrantValidation.Invalid
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
        private val OCTET_STREAM_MEDIA = "application/octet-stream".toMediaType()
        private val SENSITIVE_GRANT = Regex("^[A-Za-z0-9_-]{43}$")
        private const val HEADER_SENSITIVE_GRANT = "X-Zephyr-Sensitive-Grant"

        /** Long enough for a slow mobile link, short enough that the UI can show a failure. */
        const val CONNECT_TIMEOUT_SEC = 15L
        const val READ_TIMEOUT_SEC = 30L
        const val WRITE_TIMEOUT_SEC = 30L

        /** Bounds a whole call including retries so a hung socket cannot pin a sync round forever. */
        const val CALL_TIMEOUT_SEC = 120L
        private const val HEADER_LAST_EVENT_ID = "Last-Event-ID"
    }

    private sealed interface SensitiveGrantValidation {
        data object Absent : SensitiveGrantValidation
        data class Valid(val value: String) : SensitiveGrantValidation
        data object Invalid : SensitiveGrantValidation
    }
}
