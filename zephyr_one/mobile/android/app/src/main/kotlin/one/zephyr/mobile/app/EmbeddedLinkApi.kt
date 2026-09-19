package one.zephyr.mobile.app

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.booleanOrNull
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

    /**
     * Signs the handshake transcript the Go core returns when the peer requires
     * an ES256 finish. The host owns the Keystore key; Go never sees it.
     */
    fun interface HandshakeSigner {
        fun signTranscript(transcript: ByteArray): String
    }

    /**
     * Attach /link/stream on an established One session so DialRelay can splice
     * through the main end onto an Agent bastion.
     */
    suspend fun startInitiator(
        serverUrl: String,
        session: LinkSession,
        insecure: Boolean = false,
    ): Unit = withContext(Dispatchers.IO) {
        val base = process.ensureStarted().baseUrl
        val peer = LinkPeerResolver.resolve(linkRoot(serverUrl))
        val body = JsonObject(mapOf(
            "sessionId" to JsonPrimitive(session.sessionId),
            "peerUrl" to JsonPrimitive(peer.url),
            "insecure" to JsonPrimitive(insecure),
        ))
        post("$base/link/tunnel/initiator/start", body)
    }

    /**
     * Open a TCP splice to [host]:[port] through [agentId]. Returns a connected
     * Socket whose bytes ride One → main → Agent. Handshake is raw HTTP so we
     * can keep the leftover socket after the 101.
     */
    suspend fun dialInitiator(
        agentId: String,
        host: String,
        port: Int,
    ): java.net.Socket = withContext(Dispatchers.IO) {
        val endpoint = process.ensureStarted()
        val loopback = java.net.URI.create(endpoint.baseUrl)
        val socket = java.net.Socket()
        socket.connect(
            java.net.InetSocketAddress(loopback.host, loopback.port),
            8_000,
        )
        val payload = """{"agentId":${jsonString(agentId)},"host":${jsonString(host)},"port":$port}"""
        val request = buildString {
            append("POST /link/tunnel/initiator/dial HTTP/1.1\r\n")
            append("Host: ${loopback.host}:${loopback.port}\r\n")
            append("Content-Type: application/json\r\n")
            append("Connection: Upgrade\r\n")
            append("Upgrade: tcp\r\n")
            append("Content-Length: ${payload.toByteArray(Charsets.UTF_8).size}\r\n")
            append("\r\n")
            append(payload)
        }
        socket.getOutputStream().write(request.toByteArray(Charsets.UTF_8))
        socket.getOutputStream().flush()
        val header = readHttpHeaders(socket.getInputStream())
        val status = header.lineSequence().firstOrNull()?.split(' ')?.getOrNull(1)
        if (status != "101") {
            socket.close()
            throw LinkRequestException(
                code = "initiator_dial_failed",
                message = "Agent 跳板拨号失败 ($status)",
                retryable = status?.toIntOrNull()?.let { it >= 500 } == true,
            )
        }
        socket
    }

    private fun jsonString(value: String): String =
        "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    private fun readHttpHeaders(input: java.io.InputStream): String {
        val bytes = java.io.ByteArrayOutputStream()
        var prev = -1
        while (true) {
            val next = input.read()
            if (next < 0) break
            bytes.write(next)
            if (prev == '\r'.code && next == '\n'.code && bytes.size() >= 4) {
                val arr = bytes.toByteArray()
                if (arr[arr.size - 4] == '\r'.code.toByte() && arr[arr.size - 3] == '\n'.code.toByte()) {
                    return String(arr, Charsets.ISO_8859_1)
                }
            }
            prev = next
        }
        return String(bytes.toByteArray(), Charsets.ISO_8859_1)
    }

    /** Establish a ZSL/2 channel to a Link server URL through the embedded Go core. */
    /** The main end mounts the Link proxy at /api/link/v2; the Go Dial/push append the leaf. */
    private fun linkRoot(serverUrl: String): String = serverUrl.trimEnd('/') + "/api/link/v2"

    suspend fun dial(
        serverUrl: String,
        deviceId: String,
        spkiPins: List<String>,
        insecure: Boolean = false,
        signer: HandshakeSigner? = null,
    ): LinkSession = withContext(Dispatchers.IO) {
        val base = process.ensureStarted().baseUrl
        val peers = LinkPeerResolver.resolveAll(linkRoot(serverUrl))
        var lastError: Exception? = null
        for (peer in peers) {
            val body = JsonObject(mapOf(
                "serverUrl" to JsonPrimitive(peer.url),
                "deviceId" to JsonPrimitive(deviceId),
                "spkiPins" to kotlinx.serialization.json.JsonArray(spkiPins.map(::JsonPrimitive)),
                "insecure" to JsonPrimitive(insecure),
                "serverName" to JsonPrimitive(peer.serverName),
            ))
            try {
                val response = post("$base/link/dial", body)
                val pending = response["pending"]?.jsonPrimitive?.booleanOrNull == true
                if (pending) {
                    val sessionId = response.getValue("sessionId").jsonPrimitive.content
                    val transcriptB64 = response.getValue("transcript").jsonPrimitive.content
                    val transcript = one.zephyr.mobile.model.Base64Codec.decodeUrlNoPad(transcriptB64)
                    val proof = signer?.signTranscript(transcript)
                        ?: throw LinkRequestException(
                            code = "proof_required",
                            message = "Link 握手需要设备签名",
                            retryable = false,
                        )
                    val finished = post(
                        "$base/link/dial/finish",
                        JsonObject(mapOf(
                            "sessionId" to JsonPrimitive(sessionId),
                            "proof" to JsonPrimitive(proof),
                        )),
                    )
                    return@withContext LinkSession(
                        sessionId = finished.getValue("sessionId").jsonPrimitive.content,
                        exporter = finished.getValue("exporter").jsonPrimitive.content,
                    )
                }
                return@withContext LinkSession(
                    sessionId = response.getValue("sessionId").jsonPrimitive.content,
                    exporter = response.getValue("exporter").jsonPrimitive.content,
                )
            } catch (error: LinkRequestException) {
                lastError = error
                if (!isRetryablePeerFailure(error)) throw error
            }
        }
        throw lastError ?: IllegalStateException("Link 无法解析对端地址")
    }

    private fun isRetryablePeerFailure(error: LinkRequestException): Boolean =
        error.retryable &&
            !error.sessionInvalid &&
            (error.code == "link_unavailable" || error.code == "server_unavailable")

    /** The unsealed business ack from a pushed frame. */
    data class LinkPushResult(val ackKind: Int, val ack: JsonObject)

    internal class LinkRequestException(
        val code: String,
        override val message: String,
        val retryable: Boolean,
        val details: Map<String, String> = emptyMap(),
        val sessionInvalid: Boolean = false,
    ) : IllegalStateException(message)

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
        spkiPins: List<String> = emptyList(),
        insecure: Boolean = false,
    ): LinkPushResult = withContext(Dispatchers.IO) {
        val base = process.ensureStarted().baseUrl
        val peer = LinkPeerResolver.resolve(linkRoot(serverUrl))
        val payload = buildJsonObject {
            put("sessionId", session.sessionId)
            put("peerUrl", peer.url)
            put("kind", kind)
            put("body", body)
            put("secret", secret)
            put("spkiPins", kotlinx.serialization.json.JsonArray(spkiPins.map(::JsonPrimitive)))
            put("insecure", insecure)
            put("serverName", peer.serverName)
        }
        val response = post("$base/link/push", payload)
        val ackElement = response["ack"]
        val ack = when (ackElement) {
            null, JsonNull -> JsonObject(emptyMap())
            is JsonObject -> ackElement
            else -> throw IllegalStateException("Link runtime 返回了无法解析的响应")
        }
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
        val response: Response = suspendCancellableCoroutine { continuation ->
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
                val errorObject = parsed["error"] as? JsonObject
                val code = errorObject?.get("code")?.jsonPrimitive?.content ?: "link_unavailable"
                val message = errorObject?.get("message")?.jsonPrimitive?.content
                    ?: "Link 请求失败 (${resp.code})"
                val retryable = errorObject?.get("retryable")?.jsonPrimitive?.content?.toBooleanStrictOrNull()
                    ?: (resp.code >= 500)
                val details = (errorObject?.get("details") as? JsonObject)
                    ?.mapValues { (_, value) -> (value as? JsonPrimitive)?.content ?: value.toString() }
                    ?: emptyMap()
                throw LinkRequestException(
                    code = code,
                    message = message,
                    retryable = retryable,
                    details = details,
                    sessionInvalid = code == "session_unknown" || code == "invalid_frame",
                )
            }
            parsed
        }
    }
}
