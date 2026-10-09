package one.zephyr.mobile.feature.notes

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.InputStream
import java.util.concurrent.TimeUnit
import kotlin.coroutines.coroutineContext

/** Credentials stay in native code. WebView never receives SSH handles, tokens or remote URLs. */
sealed interface PreviewSource {
    val name: String
    val displayPath: String
    data class Sftp(val port: SftpPort, val handle: SftpSessionHandle, val path: String) : PreviewSource {
        override val name get() = path.substringAfterLast('/')
        override val displayPath get() = path
    }
    data class Local(val uri: Uri, override val name: String) : PreviewSource {
        override val displayPath get() = name
    }
    data class Http(
        val url: String,
        override val name: String,
        val headers: Map<String, String> = emptyMap(),
        val subtitles: List<Http> = emptyList(),
    ) : PreviewSource {
        // Do not display/log query strings containing preview bearer/lease tokens.
        override val displayPath get() = name
        init {
            require(url.toHttpUrl().isHttps) { "媒体地址必须使用 HTTPS" }
            require(headers.keys.all { it.matches(Regex("[A-Za-z0-9-]+")) })
            require(headers.values.none { it.contains('\r') || it.contains('\n') })
        }
    }
}

/** Adapter for RAW `sftp-media-preview-ready`/HTTP replies; no transcode request or suffix rewrite. */
data class RawPreviewReady(
    val path: String,
    val streamUrl: String,
    val subtitles: List<PreviewSource.Http> = emptyList(),
) {
    fun source(baseUrl: String, authHeaders: Map<String, String>): PreviewSource.Http {
        val base = baseUrl.toHttpUrl()
        val resolved = base.resolve(streamUrl) ?: error("无效媒体地址")
        // Query-string bearer/lease tokens are credentials too. A same-origin
        // absolute URL that drops or replaces them must not inherit session headers,
        // and a cross-origin URL must never receive either form of auth.
        require(resolved.isHttps && resolved.scheme == base.scheme && resolved.host == base.host && resolved.port == base.port) {
            "拒绝将会话鉴权发送到其他来源"
        }
        if (resolved.queryParameterNames.isNotEmpty() && resolved.encodedQuery != base.encodedQuery) {
            require(authHeaders.isEmpty()) { "带查询鉴权的地址不能再附加会话请求头" }
        }
        return PreviewSource.Http(resolved.toString(), path.substringAfterLast('/'), authHeaders, subtitles)
    }
}

/** One preview generation owns its uniquely named files. Closing/refresh never reuses stale cache. */
class PreviewFiles(private val context: Context) : AutoCloseable {
    private val files = java.util.concurrent.CopyOnWriteArrayList<File>()
    @Volatile private var closed = false
    private val http = OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false)
        .connectTimeout(20, TimeUnit.SECONDS).readTimeout(45, TimeUnit.SECONDS).build()

    suspend fun stage(source: PreviewSource, maxBytes: Long): File = withContext(Dispatchers.IO) {
        check(!closed) { "预览已关闭" }
        val suffix = source.name.substringAfterLast('.', "bin").lowercase().takeIf { it.matches(Regex("[a-z0-9]{1,12}")) } ?: "bin"
        val file = File.createTempFile("zephyr-preview-", ".$suffix", context.cacheDir)
        files.add(file)
        if (closed) { file.delete(); error("预览已关闭") }
        var total = 0L
        try {
            file.outputStream().use { output ->
                suspend fun copy(input: InputStream) {
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        coroutineContext.ensureActive()
                        check(!closed) { "预览已关闭" }
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        require(total <= maxBytes) { "文件超过预览大小限制（${SftpOpenPolicy.formatBytes(maxBytes)}）" }
                        output.write(buffer, 0, count)
                    }
                }
                when (source) {
                    is PreviewSource.Local -> context.contentResolver.openInputStream(source.uri)?.use { copy(it) }
                        ?: error("无法读取本地文件")
                    is PreviewSource.Sftp -> source.port.readStream(source.handle, source.path, 0L) { offset, bytes, size ->
                        coroutineContext.ensureActive()
                        check(!closed) { "预览已关闭" }
                        require(size <= maxBytes && offset == total && total + bytes.size <= maxBytes) { "文件过大或媒体流不连续" }
                        output.write(bytes)
                        total += bytes.size
                    }
                    is PreviewSource.Http -> {
                        val request = Request.Builder().url(source.url).apply {
                            source.headers.forEach { (key, value) -> header(key, value) }
                            header("Cache-Control", "no-cache")
                        }.build()
                        http.newCall(request).execute().use { response ->
                            require(response.isSuccessful) { "读取媒体失败（HTTP ${response.code}）" }
                            val body = response.body ?: error("媒体响应为空")
                            require(body.contentLength() <= maxBytes) { "媒体超过预览大小限制" }
                            body.byteStream().use { copy(it) }
                        }
                    }
                }
            }
            require(total > 0L) { "预览文件为空" }
            coroutineContext.ensureActive()
            check(!closed) { "预览已关闭" }
            file
        } catch (failure: Throwable) {
            file.delete()
            files.remove(file)
            throw failure
        }
    }

    override fun close() {
        closed = true
        http.dispatcher.cancelAll()
        http.connectionPool.evictAll()
        files.forEach { it.delete() }
        files.clear()
    }
}
