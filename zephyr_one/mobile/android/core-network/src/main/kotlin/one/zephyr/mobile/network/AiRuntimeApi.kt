package one.zephyr.mobile.network

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import one.zephyr.mobile.model.MobileError
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Account client for the server-owned Zephyr AI runtime. Provider secrets never reach One. */
class AiRuntimeApi(
    private val endpoint: ApiEndpoint,
    private val credentials: CredentialStore,
    appVersion: String,
    clientBuilder: OkHttpClient.Builder = OkHttpClient.Builder(),
) {
    private val client = TlsConfigurator
        .apply(clientBuilder, endpoint.tlsPolicy, endpoint.host)
        .connectTimeout(MobileApiClient.CONNECT_TIMEOUT_SEC, TimeUnit.SECONDS)
        .readTimeout(MobileApiClient.READ_TIMEOUT_SEC, TimeUnit.SECONDS)
        .writeTimeout(MobileApiClient.WRITE_TIMEOUT_SEC, TimeUnit.SECONDS)
        .callTimeout(MobileApiClient.CALL_TIMEOUT_SEC, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
        .followRedirects(false)
        .followSslRedirects(false)
        .addInterceptor(RequestIdInterceptor())
        .addInterceptor(ClientHeaderInterceptor(appVersion))
        .addInterceptor(ResponseSizeLimitInterceptor())
        .build()

    private val streamingClient = client.newBuilder()
        .readTimeout(0L, TimeUnit.MILLISECONDS)
        .callTimeout(0L, TimeUnit.MILLISECONDS)
        .build()

    suspend fun status(): ApiResult<AiRuntimeStatusDto> =
        get(PATH_RUNTIME_STATUS, AiRuntimeStatusDto.serializer())

    suspend fun providers(): ApiResult<List<AiProviderDto>> =
        get(PATH_PROVIDERS, AiProvidersResponseDto.serializer()).map { it.providers }

    suspend fun history(): ApiResult<List<AiHistoryConversationDto>> =
        get(
            PATH_HISTORY,
            AiHistoryResponseDto.serializer(),
            query = mapOf("withMessages" to "1"),
        ).map { it.conversations }

    suspend fun runtimeSessions(): ApiResult<AiRuntimeSessionsResponseDto> =
        get(PATH_RUNTIME_SESSIONS, AiRuntimeSessionsResponseDto.serializer())

    suspend fun createSession(title: String): ApiResult<AiRuntimeSessionResponseDto> =
        post(
            PATH_RUNTIME_SESSIONS,
            AiCreateSessionRequestDto(title),
            AiCreateSessionRequestDto.serializer(),
            AiRuntimeSessionResponseDto.serializer(),
        )

    suspend fun startRun(request: AiRunRequestDto): ApiResult<AiRunStartDto> =
        post(PATH_RUNTIME_RUNS, request, AiRunRequestDto.serializer(), AiRunStartDto.serializer())

    suspend fun abort(runId: String): ApiResult<AiAbortResponseDto> =
        post(runtimeRun(runId) + "/abort", AiEmptyRequestDto(), AiEmptyRequestDto.serializer(), AiAbortResponseDto.serializer())

    suspend fun decide(runId: String, request: AiRunDecisionRequestDto): ApiResult<AiRunDecisionResponseDto> =
        post(runtimeRun(runId) + "/permission", request, AiRunDecisionRequestDto.serializer(), AiRunDecisionResponseDto.serializer())

    suspend fun listAttachments(sessionId: String): ApiResult<List<AiAttachmentDto>> =
        get(PATH_ATTACHMENTS, AiAttachmentsResponseDto.serializer(), mapOf("sessionId" to sessionId))
            .map { it.attachments }

    suspend fun upload(
        sessionId: String,
        name: String,
        mimeType: String,
        bytes: ByteArray,
    ): ApiResult<AiAttachmentDto> {
        if (bytes.isEmpty()) return localFailure("empty_file", "空文件")
        if (bytes.size > MAX_ATTACHMENT_BYTES) return localFailure("file_too_large", "单文件不能超过 12MB")
        val wire = bytes.copyOf()
        return try {
            val body = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("sessionId", sessionId)
                .addFormDataPart("file", name, wire.toRequestBody(mimeType.toMediaTypeOrOctetStream()))
                .build()
            execute(
                Request.Builder().url(url(PATH_ATTACHMENTS)).post(body).build(),
                AiAttachmentResponseDto.serializer(),
            ).map { it.attachment }
        } finally {
            wire.fill(0)
        }
    }

    suspend fun deleteAttachment(sessionId: String, attachmentId: String): ApiResult<Boolean> =
        execute(
            Request.Builder()
                .url(url(PATH_ATTACHMENTS + "/" + pathSegment(attachmentId), mapOf("sessionId" to sessionId)))
                .delete()
                .build(),
            AiOkResponseDto.serializer(),
        ).map { it.ok }

    suspend fun deleteConversation(id: String, expectedRevision: Long? = null): ApiResult<Boolean> {
        val query = if (expectedRevision != null && expectedRevision > 0) {
            mapOf("expectedRevision" to expectedRevision.toString())
        } else emptyMap()
        return execute(
            Request.Builder()
                .url(url(PATH_HISTORY + "/" + pathSegment(id), query))
                .delete()
                .build(),
            AiOkResponseDto.serializer(),
        ).map { it.ok }
    }

    /** Consumes the Node SSE proxy with SID auth and bounded line/event sizes. */
    suspend fun stream(
        ssePath: String,
        lastEventId: Long = 0,
        onEvent: suspend (AiRuntimeEvent) -> Unit,
    ): ApiResult<Unit> {
        val request = authorized(
            Request.Builder()
                .url(urlFromServerPath(ssePath))
                .get()
                .header("Accept", "text/event-stream")
                .header("Cache-Control", "no-cache")
                .apply { if (lastEventId > 0) header("Last-Event-ID", lastEventId.toString()) }
                .build(),
        ) ?: return sidFailure()
        return try {
            val response = await(streamingClient, request)
            response.use { current ->
                if (current.isRedirect) return unexpectedRedirect(current)
                if (!current.isSuccessful) return httpFailure(current)
                if (!current.header("Content-Type").orEmpty().lowercase().startsWith("text/event-stream")) {
                    return localFailure("malformed_ai_stream", "服务器没有返回 AI 事件流")
                }
                val source = current.body?.source()
                    ?: return localFailure("malformed_ai_stream", "AI 事件流为空")
                val parser = AiSseParser { event -> onEvent(event) }
                while (!source.exhausted()) {
                    val line = source.readUtf8LineStrict(MAX_SSE_LINE_BYTES)
                    parser.accept(line)
                }
                parser.finish()
                ApiResult.Success(Unit, request.header(RequestIdInterceptor.HEADER_REQUEST_ID))
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (tooLarge: ResponseSizeLimitExceededException) {
            localFailure("response_too_large", tooLarge.message ?: "AI 响应过大")
        } catch (io: IOException) {
            localFailure("network_unreachable", io.message ?: "AI 网络连接中断", retryable = true)
        } catch (failure: Exception) {
            localFailure("malformed_ai_stream", failure.message ?: "AI 事件流格式无效")
        }
    }

    private suspend fun <R> get(
        path: String,
        serializer: DeserializationStrategy<R>,
        query: Map<String, String> = emptyMap(),
    ): ApiResult<R> = execute(Request.Builder().url(url(path, query)).get().build(), serializer)

    private suspend fun <B, R> post(
        path: String,
        body: B,
        bodySerializer: SerializationStrategy<B>,
        responseSerializer: DeserializationStrategy<R>,
    ): ApiResult<R> = execute(
        Request.Builder()
            .url(url(path))
            .post(MobileJson.instance.encodeToString(bodySerializer, body).toRequestBody(JSON_MEDIA))
            .build(),
        responseSerializer,
    )

    private suspend fun <R> execute(
        request: Request,
        serializer: DeserializationStrategy<R>,
    ): ApiResult<R> {
        val authorized = authorized(request) ?: return sidFailure()
        return try {
            val response = await(client, authorized)
            response.use { current ->
                if (current.isRedirect) return unexpectedRedirect(current)
                if (!current.isSuccessful) return httpFailure(current)
                val text = current.body?.string().orEmpty()
                try {
                    ApiResult.Success(
                        MobileJson.instance.decodeFromString(serializer, text),
                        current.header(RequestIdInterceptor.HEADER_REQUEST_ID),
                    )
                } catch (failure: Exception) {
                    localFailure("malformed_response", failure.message ?: "AI 响应无法解析")
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (tooLarge: ResponseSizeLimitExceededException) {
            localFailure("response_too_large", tooLarge.message ?: "AI 响应过大")
        } catch (io: IOException) {
            localFailure("network_unreachable", io.message ?: "AI 网络不可达", retryable = true)
        }
    }

    private fun authorized(request: Request): Request? {
        val builder = request.newBuilder()
        credentials.sid()?.takeIf { it.isNotBlank() }?.let {
            return builder.header("X-Zephyr-Sid", it).build()
        }
        credentials.accessCredential()?.takeIf { it.isNotBlank() }?.let {
            return builder.header("Authorization", "Bearer $it").build()
        }
        return null
    }

    private suspend fun await(http: OkHttpClient, request: Request): Response =
        suspendCancellableCoroutine { continuation ->
            val call = http.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, error: IOException) {
                    if (continuation.isActive) continuation.resumeWithException(error)
                }

                override fun onResponse(call: Call, response: Response) {
                    if (continuation.isActive) continuation.resume(response) else response.close()
                }
            })
        }

    private fun <T> httpFailure(response: Response): ApiResult<T> {
        val requestId = response.header(RequestIdInterceptor.HEADER_REQUEST_ID)
        val text = runCatching { response.body?.string() }.getOrNull()
        val parsed = text?.let { raw ->
            runCatching { MobileJson.instance.parseToJsonElement(raw).jsonObject }.getOrNull()
        }
        val nested = parsed?.get("error") as? JsonObject
        val message = when {
            nested != null -> nested.string("message")
            parsed != null -> parsed.string("error").ifBlank { parsed.string("message") }
            else -> ""
        }.ifBlank { "AI 请求失败（HTTP ${response.code}）" }
        val code = when {
            nested != null -> nested.string("code")
            parsed != null -> parsed.string("code")
            else -> ""
        }.ifBlank { if (response.code == 401) "app_session_expired" else "ai_http_${response.code}" }
        return ApiResult.Failure(
            MobileError(
                code = code,
                message = message,
                retryable = response.code == 429 || response.code >= 500,
                requestId = requestId,
                httpStatus = response.code,
            ),
        )
    }

    private fun <T> sidFailure(): ApiResult<T> =
        localFailure("app_session_expired", "没有可用的主端登录或设备访问凭据，请重新绑定")

    private fun <T> unexpectedRedirect(response: Response): ApiResult<T> =
        ApiResult.Failure(MobileError.local("unexpected_redirect", "AI 服务尝试了重定向", false).copy(httpStatus = response.code))

    private fun <T> localFailure(code: String, message: String, retryable: Boolean = false): ApiResult<T> =
        ApiResult.Failure(MobileError.local(code, message, retryable))

    private fun url(path: String, query: Map<String, String> = emptyMap()): HttpUrl {
        val builder = endpoint.baseUrl.toHttpUrlCompat().newBuilder()
        path.trim('/').split('/').filter(String::isNotEmpty).forEach(builder::addPathSegment)
        query.forEach(builder::addQueryParameter)
        return builder.build()
    }

    private fun urlFromServerPath(path: String): HttpUrl {
        require(path.startsWith("/") && !path.startsWith("//")) { "AI stream path must be origin-relative" }
        val parsed = endpoint.baseUrl.toHttpUrlCompat().resolve(path)
            ?: throw IllegalArgumentException("invalid AI stream path")
        require(parsed.host == endpoint.host) { "AI stream cannot change origin" }
        return parsed
    }

    private fun pathSegment(value: String): String = value.replace("/", "_").take(200)

    private fun String.toHttpUrlCompat(): HttpUrl = toHttpUrl()
    private fun String.toMediaTypeOrOctetStream(): MediaType =
        runCatching { toMediaType() }.getOrElse { OCTET_STREAM_MEDIA }

    private fun JsonObject.string(key: String): String =
        (get(key) as? kotlinx.serialization.json.JsonPrimitive)?.content.orEmpty()

    private class AiSseParser(
        private val emit: suspend (AiRuntimeEvent) -> Unit,
    ) {
        private var eventName = ""
        private var eventId = ""
        private val data = ArrayList<String>()

        suspend fun accept(line: String) {
            if (line.isEmpty()) {
                flush()
                return
            }
            if (line.startsWith(":")) return
            val split = line.indexOf(':')
            val field = if (split < 0) line else line.substring(0, split)
            val value = if (split < 0) "" else line.substring(split + 1).removePrefix(" ")
            when (field) {
                "event" -> eventName = value.take(120)
                "id" -> eventId = value.take(80)
                "data" -> {
                    if (data.sumOf(String::length) + value.length > MAX_SSE_EVENT_BYTES) {
                        throw IOException("AI event exceeds size limit")
                    }
                    data += value
                }
            }
        }

        suspend fun finish() = flush()

        private suspend fun flush() {
            if (data.isEmpty() && eventName.isEmpty()) return reset()
            val raw = data.joinToString("\n")
            val envelope = runCatching {
                MobileJson.instance.decodeFromString(AiRuntimeEventEnvelope.serializer(), raw)
            }.getOrElse { throw IOException("malformed AI event", it) }
            val payload = when (val value = envelope.data) {
                is JsonObject -> value
                null -> JsonObject(emptyMap())
                else -> runCatching {
                    if (value is kotlinx.serialization.json.JsonPrimitive && value.isString) {
                        MobileJson.instance.parseToJsonElement(value.content).jsonObject
                    } else JsonObject(mapOf("value" to value))
                }.getOrDefault(JsonObject(emptyMap()))
            }
            emit(
                AiRuntimeEvent(
                    type = envelope.type.ifBlank { eventName.ifBlank { "message" } },
                    runId = envelope.runId,
                    seq = envelope.seq.takeIf { it > 0 } ?: eventId.toLongOrNull().orZero(),
                    timestamp = envelope.timestamp,
                    data = payload,
                ),
            )
            reset()
        }

        private fun reset() {
            eventName = ""
            eventId = ""
            data.clear()
        }

        private fun Long?.orZero(): Long = this ?: 0L
    }

    private companion object {
        const val PATH_RUNTIME_STATUS = "/api/ai/runtime/status"
        const val PATH_RUNTIME_SESSIONS = "/api/ai/runtime/sessions"
        const val PATH_RUNTIME_RUNS = "/api/ai/runtime/runs"
        const val PATH_PROVIDERS = "/api/ai/providers"
        const val PATH_HISTORY = "/api/ai/history/conversations"
        const val PATH_ATTACHMENTS = "/api/ai/attachments"
        const val MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024
        const val MAX_SSE_LINE_BYTES = 1024L * 1024L
        const val MAX_SSE_EVENT_BYTES = 2 * 1024 * 1024
        val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
        val OCTET_STREAM_MEDIA = "application/octet-stream".toMediaType()

        fun runtimeRun(runId: String): String = PATH_RUNTIME_RUNS + "/" + runId.replace("/", "_").take(200)
    }
}

@kotlinx.serialization.Serializable
private data class AiCreateSessionRequestDto(val title: String)

@kotlinx.serialization.Serializable
private class AiEmptyRequestDto
