package one.zephyr.mobile.app

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.json.JsonObject
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.network.MobileJson
import one.zephyr.mobile.network.AiAbortResponseDto
import one.zephyr.mobile.network.AiRunStartDto
import one.zephyr.mobile.network.AiRuntimeEvent
import one.zephyr.mobile.network.AiRuntimeEventEnvelope
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Typed loopback client for the embedded Go runtime. */
internal class EmbeddedAiRuntimeApi(
    private val process: EmbeddedAiRuntimeProcess,
    private val platformHost: AndroidAiPlatformHost,
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS).retryOnConnectionFailure(false).build()
    private val streamClient = client.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build()

    suspend fun createSession(userId: String, generation: String, title: String): ApiResult<EmbeddedSession> =
        when (val result = post("/admin/sessions", EmbeddedCreateSession(userId, generation, title), EmbeddedCreateSession.serializer(), EmbeddedSessionResponse.serializer())) {
            is ApiResult.Success -> ApiResult.Success(result.value.session, result.requestId)
            is ApiResult.Failure -> result
        }

    suspend fun listSessions(userId: String, generation: String): ApiResult<List<EmbeddedSession>> =
        when (val result = get("/admin/sessions?userId=${encode(userId)}&databaseGeneration=${encode(generation)}", EmbeddedSessionsResponse.serializer())) {
            is ApiResult.Success -> ApiResult.Success(result.value.sessions, result.requestId)
            is ApiResult.Failure -> result
        }

    suspend fun messages(userId: String, generation: String, sessionId: String): ApiResult<List<EmbeddedMessage>> =
        when (val result = get("/admin/sessions/${encode(sessionId)}/messages?userId=${encode(userId)}&databaseGeneration=${encode(generation)}", EmbeddedMessagesResponse.serializer())) {
            is ApiResult.Success -> ApiResult.Success(result.value.messages, result.requestId)
            is ApiResult.Failure -> result
        }

    suspend fun start(body: EmbeddedStartRun): ApiResult<AiRunStartDto> =
        post("/admin/runs", body, EmbeddedStartRun.serializer(), AiRunStartDto.serializer())

    suspend fun abort(runId: String): ApiResult<AiAbortResponseDto> =
        post("/admin/runs/${encode(runId)}/abort", JsonObject(emptyMap()), JsonObject.serializer(), AiAbortResponseDto.serializer())

    suspend fun decide(runId: String, body: EmbeddedPermissionDecision): ApiResult<EmbeddedPermissionResponse> =
        post("/admin/runs/${encode(runId)}/permission", body, EmbeddedPermissionDecision.serializer(), EmbeddedPermissionResponse.serializer())

    suspend fun stream(path: String, lastEventId: Long, onEvent: suspend (AiRuntimeEvent) -> Unit): ApiResult<Unit> {
        return runtimeCall("embedded_ai_stream_failed", "本机 AI 事件流中断") {
            val endpoint = endpoint()
            val request = authorized(
                Request.Builder().url(endpoint.baseUrl + path).get()
                    .header("Accept", "text/event-stream")
                    .apply { if (lastEventId > 0) header("Last-Event-ID", "$lastEventId") }
                    .build(),
                endpoint,
            )
            await(streamClient, request).use { response ->
                if (!response.isSuccessful) {
                    failure("embedded_ai_http_${response.code}", "本机 AI Runtime 请求失败（HTTP ${response.code}）")
                } else {
                    val source = response.body?.source()
                    if (source == null) {
                        failure("empty_ai_stream", "本机 AI 事件流为空")
                    } else {
                        val parser = EmbeddedSseParser(onEvent)
                        while (!source.exhausted()) parser.accept(source.readUtf8LineStrict(MAX_LINE))
                        parser.finish()
                        ApiResult.Success(Unit, null)
                    }
                }
            }
        }
    }

    private suspend fun <B, R> post(
        path: String,
        body: B,
        bs: SerializationStrategy<B>,
        rs: DeserializationStrategy<R>,
    ): ApiResult<R> = runtimeCall("embedded_ai_start_failed", "本机 AI Runtime 启动失败") {
        val endpoint = endpoint()
        val json = MobileJson.instance.encodeToString(bs, body)
        val request = Request.Builder().url(endpoint.baseUrl + path)
            .post(json.toRequestBody(JSON)).build()
        execute(authorized(request, endpoint), rs)
    }

    private suspend fun <R> get(path: String, serializer: DeserializationStrategy<R>): ApiResult<R> =
        runtimeCall("embedded_ai_start_failed", "本机 AI Runtime 启动失败") {
            val endpoint = endpoint()
            val request = Request.Builder().url(endpoint.baseUrl + path).get().build()
            execute(authorized(request, endpoint), serializer)
        }

    private suspend fun <R> execute(request: Request, serializer: DeserializationStrategy<R>): ApiResult<R> = try {
        await(client, request).use { response ->
            val raw = response.body?.string().orEmpty()
            if (!response.isSuccessful) return failure("embedded_ai_http_${response.code}", parseError(raw).ifBlank { "本机 AI Runtime 请求失败（HTTP ${response.code}）" })
            runCatching { MobileJson.instance.decodeFromString(serializer, raw) }
                .fold({ ApiResult.Success(it, null) }, { failure("malformed_embedded_ai_response", it.message ?: "本机 AI 响应无效") })
        }
    } catch (cancelled: CancellationException) { throw cancelled }
    catch (error: IOException) { failure("embedded_ai_unreachable", error.message ?: "本机 AI Runtime 不可达", true) }

    private fun endpoint(): EmbeddedAiRuntimeProcess.Endpoint {
        val host = platformHost.ensureStarted()
        return process.ensureStarted(host.url, host.token)
    }
    private fun authorized(
        request: Request,
        endpoint: EmbeddedAiRuntimeProcess.Endpoint,
    ): Request = request.newBuilder().header("X-AI-Admin", endpoint.adminToken).build()

    private suspend fun <T> runtimeCall(
        code: String,
        fallback: String,
        block: suspend () -> ApiResult<T>,
    ): ApiResult<T> = withContext(Dispatchers.IO) {
        try {
            block()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            failure(code, failure.message ?: fallback, true)
        }
    }
    private fun parseError(raw: String): String = runCatching { MobileJson.instance.parseToJsonElement(raw).jsonObject["error"]?.toString()?.trim('"').orEmpty() }.getOrDefault("")
    private suspend fun await(http: OkHttpClient, request: Request): Response = suspendCancellableCoroutine { c ->
        val call = http.newCall(request); c.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback { override fun onFailure(call: Call, e: IOException) { if (c.isActive) c.resumeWithException(e) }; override fun onResponse(call: Call, r: Response) { if (c.isActive) c.resume(r) else r.close() } })
    }
    private fun encode(value: String) = java.net.URLEncoder.encode(value, "UTF-8")
    private fun <T> failure(code: String, message: String, retryable: Boolean = false): ApiResult<T> = ApiResult.Failure(one.zephyr.mobile.model.MobileError.local(code, message, retryable))

    private class EmbeddedSseParser(private val emit: suspend (AiRuntimeEvent) -> Unit) {
        private var data = StringBuilder()
        suspend fun accept(line: String) { if (line.isEmpty()) flush() else if (line.startsWith("data:")) { if (data.isNotEmpty()) data.append('\n'); data.append(line.removePrefix("data:").trimStart()) } }
        suspend fun finish() = flush()
        private suspend fun flush() { if (data.isEmpty()) return; val raw = data.toString(); data = StringBuilder(); val e = MobileJson.instance.decodeFromString(AiRuntimeEventEnvelope.serializer(), raw); emit(AiRuntimeEvent(e.type, e.runId, e.seq, e.timestamp, e.data as? JsonObject ?: JsonObject(emptyMap()))) }
    }
    companion object { private val JSON = "application/json; charset=utf-8".toMediaType(); private const val MAX_LINE = 1024L * 1024L }
}

@kotlinx.serialization.Serializable internal data class EmbeddedCreateSession(val userId: String, val databaseGeneration: String, val title: String, val metadata: JsonObject = JsonObject(emptyMap()))
@kotlinx.serialization.Serializable internal data class EmbeddedSession(val id: String, val title: String = "新对话", val createdAt: Long = 0, val updatedAt: Long = 0)
@kotlinx.serialization.Serializable internal data class EmbeddedSessionResponse(val ok: Boolean = true, val session: EmbeddedSession)
@kotlinx.serialization.Serializable internal data class EmbeddedSessionsResponse(val ok: Boolean = true, val sessions: List<EmbeddedSession> = emptyList())
@kotlinx.serialization.Serializable internal data class EmbeddedMessage(val id: Long, val role: String, val content: String = "", val createdAt: Long = 0)
@kotlinx.serialization.Serializable internal data class EmbeddedMessagesResponse(val ok: Boolean = true, val messages: List<EmbeddedMessage> = emptyList())
@kotlinx.serialization.Serializable internal data class EmbeddedProvider(val id: String, val name: String, val kind: String, val baseUrl: String, val apiKey: String, val defaultModel: String, val models: List<String>, val apiMode: String = "auto", val organization: String = "", val extraHeaders: Map<String,String> = emptyMap(), val options: JsonObject = JsonObject(emptyMap()))
@kotlinx.serialization.Serializable internal data class EmbeddedPermission(val mode: String = "ask", val deny: List<String> = emptyList(), val ask: List<String> = emptyList(), val allow: List<String> = emptyList())
@kotlinx.serialization.Serializable internal data class EmbeddedCompose(val assistantName: String = "Zephyr AI", val defaultSystemPrompt: String = "", val customSystemPrompt: String = "", val contextText: String = "", val locale: String = "zh-CN", val skills: List<EmbeddedSkill> = emptyList(), val memories: List<EmbeddedMemory> = emptyList(), val envVars: List<EmbeddedEnv> = emptyList())
@kotlinx.serialization.Serializable internal data class EmbeddedSkill(val id: String, val name: String, val description: String, val prompt: String, val enabled: Boolean)
@kotlinx.serialization.Serializable internal data class EmbeddedMemory(val title: String, val content: String, val scope: String, val project: String, val tags: List<String>)
@kotlinx.serialization.Serializable internal data class EmbeddedEnv(val name: String, val description: String, val value: String, val valueVisibleToAi: Boolean)
@kotlinx.serialization.Serializable internal data class EmbeddedMcpServer(val name: String, val type: String, val command: String = "", val args: List<String> = emptyList(), val env: Map<String,String> = emptyMap(), val url: String = "", val headers: Map<String,String> = emptyMap(), val callTimeoutSeconds: Int = 300, val trustedReadOnlyTools: List<String> = emptyList())
@kotlinx.serialization.Serializable internal data class EmbeddedStartRun(val userId: String, val sessionId: String, val provider: EmbeddedProvider, val model: String, val message: String, val options: JsonObject, val maxSteps: Int, val permission: EmbeddedPermission, val autoConfirm: Boolean, val autoConfirmDelayMs: Int, val mode: String, val systemCompose: EmbeddedCompose, val context: JsonObject, val mcpServers: List<EmbeddedMcpServer> = emptyList(), val databaseGeneration: String, val runNonce: String, val contextWindowTokens: Int, val outputReserveTokens: Int)
@kotlinx.serialization.Serializable internal data class EmbeddedPermissionDecision(val userId: String, val sessionId: String, val callId: String, val tool: String, val approve: Boolean, val scope: String = "once", val provider: EmbeddedProvider)
@kotlinx.serialization.Serializable internal data class EmbeddedPermissionResponse(val ok: Boolean = true, val approved: Boolean = false, val resumed: Boolean = false, val runId: String = "", val callId: String = "", val ticket: String = "")
