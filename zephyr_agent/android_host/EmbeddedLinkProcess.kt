package com.zephyr.agent

import android.content.Context
import java.io.BufferedReader
import java.io.Closeable
import java.io.File
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

internal class EmbeddedLinkProcess(private val context: Context) : Closeable {
    data class Endpoint(val baseUrl: String)
    private val lock = Any()
    private var process: Process? = null
    private var endpoint: Endpoint? = null
    private val readers = Executors.newCachedThreadPool { r -> Thread(r, "zephyr-agent-link").apply { isDaemon = true } }

    fun ensureStarted(): Endpoint = synchronized(lock) {
        if (process?.isAlive == true) return@synchronized endpoint!!
        stopLocked()
        val binary = File(context.applicationInfo.nativeLibraryDir, "libzephyr_link.so")
        check(binary.isFile && binary.canExecute()) { "本机 Link Runtime 未随 Agent 安装" }
        val data = File(context.noBackupFilesDir, "zephyr-link-runtime").apply { mkdirs() }
        val builder = ProcessBuilder(binary.absolutePath).directory(data)
            .redirectError(ProcessBuilder.Redirect.appendTo(File(data, "link.log")))
        val env = builder.environment()
        env["HOME"] = data.absolutePath
        env["TMPDIR"] = File(context.cacheDir, "zephyr-link-tmp").apply { mkdirs() }.absolutePath
        val child = builder.start()
        val line = try {
            readers.submit(Callable {
                BufferedReader(InputStreamReader(child.inputStream, Charsets.UTF_8)).readLine().orEmpty().trim()
            }).get(10, TimeUnit.SECONDS)
        } catch (timeout: TimeoutException) {
            child.destroyForcibly()
            error("Link Runtime 启动超时")
        } catch (failure: Exception) {
            child.destroyForcibly()
            error("Link Runtime 启动失败: ${failure.message}")
        }
        check(child.isAlive && line.matches(Regex("127\\.0\\.0\\.1:[1-9][0-9]{0,4}"))) {
            child.destroyForcibly()
            "Link Runtime 启动失败"
        }
        val port = line.substringAfterLast(':').toInt()
        Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), 2000) }
        process = child
        Endpoint("http://127.0.0.1:$port").also { endpoint = it }
    }

    fun post(path: String, body: String): String {
        val base = ensureStarted().baseUrl
        val conn = (URL(base + path).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 5000
            readTimeout = 65000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
        }
        conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        val stream = if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        if (conn.responseCode !in 200..299) error(text.ifBlank { "Link Runtime 请求失败 (${conn.responseCode})" })
        return text
    }

    override fun close() = synchronized(lock) { stopLocked() }
    private fun stopLocked() {
        process?.let { child -> runCatching { child.outputStream.close() }; if (!child.waitFor(2, TimeUnit.SECONDS)) child.destroyForcibly() }
        process = null
        endpoint = null
    }
}
