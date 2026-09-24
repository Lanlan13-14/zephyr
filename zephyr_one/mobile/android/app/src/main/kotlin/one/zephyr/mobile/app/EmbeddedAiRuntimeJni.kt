package one.zephyr.mobile.app

import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.security.SecureRandom

/**
 * In-memory JNI bridge for the embedded Zephyr AI runtime.
 * Bypasses loopback HTTP and socket allocations by dispatching
 * requests directly through CGO exports into Go in-memory router.
 */
internal object EmbeddedAiRuntimeJni : Closeable {
    private var isLoaded = false
    private var isInitialized = false
    private var baseUrl = ""
    private var adminToken = ""
    private val lock = Any()

    init {
        try {
            // Prefer the true c-shared JNI library (built via -buildmode=c-shared,
            // carries Java_one_..._nativeInit Dispatch symbols). The CGO-less
            // libzephyr_ai_runtime.so is an executable and cannot be loaded here.
            System.loadLibrary("zephyr_ai_runtime_jni")
            isLoaded = true
        } catch (t: Throwable) {
            isLoaded = false
        }
    }

    fun isAvailable(): Boolean = isLoaded

    data class DispatchResult(
        val statusCode: Int,
        val headers: Map<String, String>,
        val body: String,
        val error: String? = null
    )

    fun ensureStarted(
        dataDir: File,
        platformHostUrl: String = "",
        platformHostToken: String = ""
    ): Boolean = synchronized(lock) {
        if (!isLoaded) return false
        if (isInitialized) return true

        val data = dataDir.apply { mkdirs() }
        val token = randomToken()
        val config = JSONObject().apply {
            put("dataDir", data.absolutePath)
            put("adminToken", token)
            put("platformHostUrl", platformHostUrl)
            put("platformHostToken", platformHostToken)
        }

        return try {
            val res = nativeInit(config.toString())
            val resObj = JSONObject(res)
            isInitialized = resObj.optBoolean("ok", false)
            baseUrl = resObj.optString("baseUrl", "")
            adminToken = resObj.optString("adminToken", "")
            isInitialized
        } catch (t: Throwable) {
            isInitialized = false
            baseUrl = ""
            adminToken = ""
            false
        }
    }

    /** SSE endpoint of the in-process runtime; empty when JNI is not active. */
    fun streamEndpoint(): Pair<String, String>? {
        synchronized(lock) {
            if (!isInitialized || baseUrl.isEmpty()) return null
            return baseUrl to adminToken
        }
    }

    fun dispatch(
        method: String,
        path: String,
        headers: Map<String, String> = emptyMap(),
        body: String = ""
    ): DispatchResult = synchronized(lock) {
        if (!isInitialized) {
            return DispatchResult(503, emptyMap(), "", "JNI runtime not initialized")
        }

        val headersJson = JSONObject(headers).toString()
        val outJsonStr = try {
            nativeDispatch(method, path, headersJson, body)
        } catch (t: Throwable) {
            return DispatchResult(500, emptyMap(), "", t.message ?: "JNI dispatch crash")
        }

        return try {
            val out = JSONObject(outJsonStr)
            val statusCode = out.optInt("statusCode", 500)
            val outHeaders = mutableMapOf<String, String>()
            val headersObj = out.optJSONObject("headers")
            if (headersObj != null) {
                val keys = headersObj.keys()
                while (keys.hasNext()) {
                    val k = keys.next()
                    outHeaders[k] = headersObj.optString(k)
                }
            }
            val respBody = out.optString("body", "")
            val error = out.optString("error", null)
            DispatchResult(statusCode, outHeaders, respBody, error)
        } catch (t: Throwable) {
            DispatchResult(500, emptyMap(), "", "Malformed JNI response: ${t.message}")
        }
    }

    override fun close() = synchronized(lock) {
        if (isInitialized) {
            try {
                nativeClose()
            } catch (_: Throwable) {}
            isInitialized = false
            baseUrl = ""
            adminToken = ""
        }
    }

    private fun randomToken(): String {
        val bytes = ByteArray(32).also(SecureRandom()::nextBytes)
        return try {
            android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP or android.util.Base64.URL_SAFE)
        } finally {
            bytes.fill(0)
        }
    }

    private external fun nativeInit(configJson: String): String
    private external fun nativeDispatch(method: String, path: String, headersJson: String, body: String): String
    private external fun nativeClose()
}
