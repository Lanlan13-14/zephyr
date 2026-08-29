package one.zephyr.mobile.app

import android.content.Context
import java.io.BufferedReader
import java.io.Closeable
import java.io.File
import java.io.InputStreamReader
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

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

    companion object {
        /** How long to wait for the Go binary to print its loopback port on stdout. */
        private const val STARTUP_TIMEOUT_MS = 10_000L
        /** Single daemon thread for the blocking readLine; discarded after each start. */
        private val STARTUP_READER = Executors.newCachedThreadPool { runnable ->
            Thread(runnable, "zephyr-link-startup").apply { isDaemon = true }
        }
    }

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
        // readLine() blocks forever if the child never writes to stdout (e.g. it is stuck
        // waiting on something). Run it on a throwaway thread with a hard timeout so the
        // bind flow can fail fast instead of hanging the entire consume+bootstrap chain.
        val line = try {
            STARTUP_READER.submit(Callable {
                BufferedReader(InputStreamReader(child.inputStream, Charsets.UTF_8)).readLine().orEmpty().trim()
            }).get(STARTUP_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        } catch (timeout: TimeoutException) {
            child.destroyForcibly()
            error("本机 Link Runtime 启动超时（${STARTUP_TIMEOUT_MS}ms 内未输出端口）")
        } catch (failure: Exception) {
            child.destroyForcibly()
            error("本机 Link Runtime 启动失败: ${failure.message}")
        }
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
