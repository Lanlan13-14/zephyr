package com.zephyr.agent

import android.content.Context
import android.os.Build
import java.io.BufferedReader
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.zip.ZipFile

internal class EmbeddedLinkProcess(private val context: Context) : Closeable {
    data class Endpoint(val baseUrl: String)
    private val lock = Any()
    private var process: Process? = null
    private var endpoint: Endpoint? = null
    private val readers = Executors.newCachedThreadPool { r -> Thread(r, "zephyr-agent-link").apply { isDaemon = true } }

    /**
     * Resolve the embedded Go runtime binary to a real executable file.
     *
     * Modern APKs ship with android:extractNativeLibs=false: libraries stay
     * page-aligned inside the APK and are never unpacked into
     * nativeLibraryDir. The Link runtime is the only .so this app exec()s as
     * a child process (everything else only loadLibrary()s), and an exec
     * target must exist as a real file — so when the installer did not unpack
     * it we extract it ourselves into noBackupFilesDir, keyed by APK digest
     * so app updates invalidate the cached copy.
     */
    private fun resolveBinary(): File {
        val direct = File(context.applicationInfo.nativeLibraryDir, "libzephyr_link.so")
        if (direct.isFile && direct.canExecute()) return direct

        val abi = Build.SUPPORTED_ABIS?.firstOrNull() ?: "arm64-v8a"
        val entryName = "lib/$abi/libzephyr_link.so"
        val sourceApk = context.applicationInfo.sourceDir
        check(!sourceApk.isNullOrBlank()) { "无法定位 Agent 安装包" }
        val digest = run {
            val md = MessageDigest.getInstance("SHA-256")
            File(sourceApk).inputStream().use { input ->
                val buf = ByteArray(1 shl 16)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    md.update(buf, 0, n)
                }
            }
            md.digest().joinToString("") { b -> "%02x".format(b) }.take(16)
        }
        val outDir = File(context.noBackupFilesDir, "zephyr-link-runtime").apply { mkdirs() }
        val extracted = File(outDir, "libzephyr_link-$digest.so")
        if (!extracted.isFile) {
            outDir.listFiles()?.forEach { if (it.name.startsWith("libzephyr_link-")) it.delete() }
            val tmp = File(outDir, ".libzephyr_link-$digest.tmp")
            ZipFile(File(sourceApk)).use { zip ->
                val entry = zip.getEntry(entryName)
                    ?: zip.getEntry("lib/arm64-v8a/libzephyr_link.so")
                check(entry != null) { "安装包缺少 Link Runtime ($entryName)" }
                zip.getInputStream(entry).use { input ->
                    FileOutputStream(tmp).use { output -> input.copyTo(output) }
                }
            }
            check(tmp.setExecutable(true, true)) { "Link Runtime 无法设为可执行" }
            check(tmp.renameTo(extracted)) { "Link Runtime 解包失败" }
        }
        check(extracted.isFile && extracted.canExecute()) { "Link Runtime 解包校验失败" }
        return extracted
    }

    fun ensureStarted(): Endpoint = synchronized(lock) {
        if (process?.isAlive == true) return@synchronized endpoint!!
        stopLocked()
        val binary = try {
            resolveBinary()
        } catch (failure: IllegalStateException) {
            throw failure
        } catch (failure: Exception) {
            throw IllegalStateException("Link Runtime 不可用: ${failure.message}", failure)
        }
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

    /** Port of the embedded runtime's loopback listener; the zft2 mirror WS
     *  rides the same mux at /link/zft2/stream. */
    fun zft2LocalPort(): Int {
        val base = ensureStarted().baseUrl
        return base.substringAfterLast(':').toInt()
    }

    override fun close() = synchronized(lock) { stopLocked() }
    private fun stopLocked() {
        process?.let { child -> runCatching { child.outputStream.close() }; if (!child.waitFor(2, TimeUnit.SECONDS)) child.destroyForcibly() }
        process = null
        endpoint = null
    }
}
