package one.zephyr.mobile.app

import android.content.Context
import java.io.BufferedReader
import java.io.Closeable
import java.io.File
import java.io.InputStreamReader
import java.net.InetSocketAddress
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.TimeUnit

/** Owns the packaged, loopback-only Go AI runtime process. */
internal class EmbeddedAiRuntimeProcess(private val context: Context) : Closeable {
    data class Endpoint(val baseUrl: String, val adminToken: String)

    private val lock = Any()
    private var process: Process? = null
    private var endpoint: Endpoint? = null
    private var platformIdentity: String = ""

    fun ensureStarted(platformHostUrl: String = "", platformHostToken: String = ""): Endpoint = synchronized(lock) {
        val requestedIdentity = "$platformHostUrl\u0000$platformHostToken"
        val alive = process?.isAlive == true && platformIdentity == requestedIdentity
        if (alive) endpoint?.let { return@synchronized it }
        stopLocked()
        val binary = File(context.applicationInfo.nativeLibraryDir, "libzephyr_ai_runtime.so")
        check(binary.isFile && binary.canExecute()) { "本机 AI Runtime 未随 APK 安装" }
        val data = File(context.noBackupFilesDir, "zephyr-ai-runtime").apply { mkdirs() }
        val token = randomToken()
        val builder = ProcessBuilder(binary.absolutePath)
            .directory(data)
            .redirectError(ProcessBuilder.Redirect.appendTo(File(data, "runtime.log")))
        val env = builder.environment()
        env.clear()
        env["HOME"] = data.absolutePath
        env["TMPDIR"] = File(context.cacheDir, "zephyr-ai-tmp").apply { mkdirs() }.absolutePath
        env["ZEPHYR_AI_DATA"] = data.absolutePath
        env["ZEPHYR_AI_ADMIN_TOKEN"] = token
        env["ZEPHYR_AI_PLATFORM_HOST_URL"] = platformHostUrl
        env["ZEPHYR_AI_PLATFORM_HOST_TOKEN"] = platformHostToken
        val child = builder.start()
        val line = BufferedReader(InputStreamReader(child.inputStream, Charsets.UTF_8)).readLine().orEmpty().trim()
        if (!child.isAlive || !line.matches(Regex("127\\.0\\.0\\.1:[1-9][0-9]{0,4}"))) {
            child.destroyForcibly()
            error("本机 AI Runtime 启动失败")
        }
        val port = line.substringAfterLast(':').toInt()
        check(port in 1..65535)
        Socket().use { socket -> socket.connect(InetSocketAddress("127.0.0.1", port), 2_000) }
        process = child
        platformIdentity = requestedIdentity
        Endpoint("http://127.0.0.1:$port", token).also { endpoint = it }
    }

    fun isRunning(): Boolean = synchronized(lock) { process?.isAlive == true }

    override fun close() = synchronized(lock) { stopLocked() }

    private fun stopLocked() {
        process?.let { child ->
            runCatching { child.outputStream.close() }
            if (!child.waitFor(2, TimeUnit.SECONDS)) child.destroyForcibly()
        }
        process = null
        endpoint = null
        platformIdentity = ""
    }

    private fun randomToken(): String {
        val bytes = ByteArray(32).also(SecureRandom()::nextBytes)
        return try { android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP or android.util.Base64.URL_SAFE) }
        finally { bytes.fill(0) }
    }
}
