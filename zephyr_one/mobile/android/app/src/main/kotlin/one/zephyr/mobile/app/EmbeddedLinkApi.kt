package one.zephyr.mobile.app

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import one.zephyr.mobile.network.MobileJson
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Loopback client for the embedded Go Link process. The Kotlin side owns device
 * identity and dialing policy; the Go side owns ZSL/2, the wire codec and CDC, so
 * the mobile end speaks byte-identical Link v2 to the server and desktop.
 */
internal class EmbeddedLinkApi(
    private val process: EmbeddedLinkProcess,
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    data class LinkSession(val sessionId: String, val exporter: String)

    /** Establish a ZSL/2 channel to a Link server URL through the embedded Go core. */
    suspend fun dial(serverUrl: String): LinkSession = withContext(Dispatchers.IO) {
        val base = process.ensureStarted().baseUrl
        val body = JsonObject(mapOf("serverUrl" to JsonPrimitive(serverUrl)))
        val response = post("$base/link/dial", body)
        LinkSession(
            sessionId = response.getValue("sessionId").jsonPrimitive.content,
            exporter = response.getValue("exporter").jsonPrimitive.content,
        )
    }

    private fun post(url: String, body: JsonObject): JsonObject {
        val request = Request.Builder()
            .url(url)
            .post(MobileJson.instance.encodeToString(JsonObject.serializer(), body)
                .toRequestBody("application/json".toMediaType()))
            .build()
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val parsed = runCatching { MobileJson.instance.parseToJsonElement(text).jsonObject }
                .getOrElse { throw IllegalStateException("Link runtime 返回了无法解析的响应") }
            if (!response.isSuccessful || parsed["ok"]?.jsonPrimitive?.content == "false") {
                val error = parsed["error"]?.jsonObject?.get("message")?.jsonPrimitive?.content
                    ?: "Link 请求失败 (${response.code})"
                throw IllegalStateException(error)
            }
            return parsed
        }
    }
}
