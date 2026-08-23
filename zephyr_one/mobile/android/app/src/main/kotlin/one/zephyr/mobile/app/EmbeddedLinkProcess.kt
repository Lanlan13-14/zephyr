package one.zephyr.mobile.app

import android.content.Context
import java.io.BufferedReader
import java.io.Closeable
import java.io.File
import java.io.InputStreamReader
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.TimeUnit

/**
 * Owns the packaged, loopback-only Go Link process. Same lifecycle shape as
 * [EmbeddedAiRuntimeProcess]: the binary ships in jniLibs, starts on demand and
 * dies on stdin EOF. Kotlin never re-implements ZSL/2 — it drives the shared Go
 * protocol core over 127.0.0.1 HTTP.
 */
internal class EmbeddedLinkProcess(private val context: Context) : Closeable {
    data class Endpoint(val baseUrl: String)

    private val lock = Any()
    private var process: Process? = null
    private var endpoint: Endpoint? = null

    fun ensureStarted(): Endpoint = synchronized(lock) {
        if (process?.isAlive == true) endpoint?.let { return@synchronized it }
        stopLocked()
        val binary = File(context.applicationInfo.nativeLibraryDir, "libzephyr_link.so")
        check(binary.isFile && binary.canExecute()) { "本机 Link Runtime 未随 APK 安装" }
        val data = File(context.noBackupFilesDir, "zephyr-link-runtime").apply { mkdirs() }
        val builder = ProcessBuilder(binary.absolutePath)
            .directory(data)
            .redirectError(ProcessBuilder.Redirect.appendTo(File(data, "link.log")))
        val env = builder.environment()
        env.clear()
        env["HOME"] = data.absolutePath
        env["TMPDIR"] = File(context.cacheDir, "zephyr-link-tmp").apply { mkdirs() }.absolutePath
        val child = builder.start()
        val line = BufferedReader(InputStreamReader(child.inputStream, Charsets.UTF_8)).readLine().orEmpty().trim()
        if (!child.isAlive || !line.matches(Regex("127\\.0\\.0\\.1:[1-9][0-9]{0,4}"))) {
            child.destroyForcibly()
            error("本机 Link Runtime 启动失败")
        }
        val port = line.substringAfterLast(':').toInt()
        check(port in 1..65535)
        Socket().use { socket -> socket.connect(InetSocketAddress("127.0.0.1", port), 2_000) }
        process = child
        Endpoint("http://127.0.0.1:$port").also { endpoint = it }
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
    }
}
