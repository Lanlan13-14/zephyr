package one.zephyr.mobile.app

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import one.zephyr.mobile.network.MobileJson
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

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
    /** The main end mounts the Link proxy at /api/link/v2; the Go Dial/push append the leaf. */
    private fun linkRoot(serverUrl: String): String = serverUrl.trimEnd('/') + "/api/link/v2"

    suspend fun dial(serverUrl: String, deviceId: String): LinkSession = withContext(Dispatchers.IO) {
        val base = process.ensureStarted().baseUrl
        val body = JsonObject(mapOf(
            "serverUrl" to JsonPrimitive(linkRoot(serverUrl)),
            "deviceId" to JsonPrimitive(deviceId),
        ))
        val response = post("$base/link/dial", body)
        LinkSession(
            sessionId = response.getValue("sessionId").jsonPrimitive.content,
            exporter = response.getValue("exporter").jsonPrimitive.content,
        )
    }

    /** The unsealed business ack from a pushed frame. */
    data class LinkPushResult(val ackKind: Int, val ack: JsonObject)

    /**
     * Push a business frame on an established session. The embedded Go core seals it, POSTs to the
     * peer's /link/frame and unseals the reply, so the host only names the session and the body and
     * never touches key material or the wire codec.
     */
    suspend fun push(
        serverUrl: String,
        session: LinkSession,
        kind: Int,
        body: JsonElement,
        secret: Boolean = false,
    ): LinkPushResult = withContext(Dispatchers.IO) {
        val base = process.ensureStarted().baseUrl
        val payload = buildJsonObject {
            put("sessionId", session.sessionId)
            put("peerUrl", linkRoot(serverUrl))
            put("kind", kind)
            put("body", body)
            put("secret", secret)
        }
        val response = post("$base/link/push", payload)
        val ack = response["ack"]?.jsonObject ?: JsonObject(emptyMap())
        LinkPushResult(
            ackKind = response["ackKind"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
            ack = ack,
        )
    }

    /** ML-KEM-768 keypair: public key + 64-byte seed. */
    data class MlkemKeypair(val publicKey: String, val seed: String)

    /** ML-KEM-768 encapsulation: shared secret + ciphertext to send to the peer. */
    data class MlkemEncapsulation(val shared: String, val ciphertext: String)

    /**
     * Device-identity ML-KEM-768 key generation, delegated to the embedded Go core.
     * Kotlin never implements the primitive; it only shuttles base64 key blobs.
     */
    suspend fun mlkemGenerate(): MlkemKeypair = withContext(Dispatchers.IO) {
        val base = process.ensureStarted().baseUrl
        val response = post("$base/link/mlkem/generate", JsonObject(emptyMap()))
        MlkemKeypair(
            publicKey = response.getValue("publicKey").jsonPrimitive.content,
            seed = response.getValue("seed").jsonPrimitive.content,
        )
    }

    /** Encapsulate a shared secret to a peer public key; returns shared + ciphertext. */
    suspend fun mlkemEncapsulate(publicKey: String): MlkemEncapsulation = withContext(Dispatchers.IO) {
        val base = process.ensureStarted().baseUrl
        val body = JsonObject(mapOf("publicKey" to JsonPrimitive(publicKey)))
        val response = post("$base/link/mlkem/encapsulate", body)
        MlkemEncapsulation(
            shared = response.getValue("shared").jsonPrimitive.content,
            ciphertext = response.getValue("ciphertext").jsonPrimitive.content,
        )
    }

    /** Decapsulate a ciphertext with a seed to recover the shared secret. */
    suspend fun mlkemDecapsulate(seed: String, ciphertext: String): String = withContext(Dispatchers.IO) {
        val base = process.ensureStarted().baseUrl
        val body = JsonObject(mapOf(
            "seed" to JsonPrimitive(seed),
            "ciphertext" to JsonPrimitive(ciphertext),
        ))
        val response = post("$base/link/mlkem/decapsulate", body)
        response.getValue("shared").jsonPrimitive.content
    }

    private suspend fun post(url: String, body: JsonObject): JsonObject {
        val request = Request.Builder()
            .url(url)
            .post(MobileJson.instance.encodeToString(JsonObject.serializer(), body)
                .toRequestBody("application/json".toMediaType()))
            .build()
        // enqueue() + invokeOnCancellation so a withTimeout upstream can actually cancel the
        // loopback call. execute() is a blocking thread call — coroutine cancellation cannot
        // interrupt it, so the bind screen would spin forever even after the timeout fires.
        val response = suspendCancellableCoroutine<Response> { continuation ->
            val call = client.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, error: IOException) {
                    if (continuation.isActive) continuation.resumeWith(Result.failure(error))
                }

                override fun onResponse(call: Call, resp: Response) {
                    if (continuation.isActive) {
                        continuation.resume(resp)
                    } else {
                        resp.close()
                    }
                }
            })
        }
        return response.use { resp ->
            val text = resp.body?.string().orEmpty()
            val parsed = runCatching { MobileJson.instance.parseToJsonElement(text).jsonObject }
                .getOrElse { throw IllegalStateException("Link runtime 返回了无法解析的响应") }
            if (!resp.isSuccessful || parsed["ok"]?.jsonPrimitive?.content == "false") {
                val error = parsed["error"]?.jsonObject?.get("message")?.jsonPrimitive?.content
                    ?: "Link 请求失败 (${resp.code})"
                throw IllegalStateException(error)
            }
            parsed
        }
    }
}
