package one.zephyr.mobile.protocol.ffmpeg

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.os.Build
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicBoolean

/**
 * On-device still-image decoder.
 *
 * Browser-direct formats (and HEIC/HEIF on API 28+) go through [ImageDecoder].
 * Everything else is FFmpeg 6.1.2 (`libffmpegexec.so`) with the same 4096-edge /
 * 32 MiB pixel ceiling the desktop wasm preview uses. Audio/video stay on LibVLC.
 */
object FfmpegImage {

    const val MAX_EDGE = 4096
    const val MAX_PIXELS = 32 * 1024 * 1024
    const val ENGINE = "ffmpeg-6.1.2"

    /** Same set as `public/preview/preview-wasm.js` `BROWSER_DIRECT`. */
    val BROWSER_DIRECT = setOf("jpg", "jpeg", "png", "webp", "gif", "avif", "bmp")

    private val loaded = AtomicBoolean(false)
    @Volatile private var loadError: String? = null

    @JvmStatic
    private external fun nativeConvert(ffmpegPath: String, inputPath: String, outputPath: String, maxEdge: Int): String?

    fun available(): Boolean = loadError == null && (loaded.get() || runCatching { ensureLoaded() }.isSuccess)

    fun ffmpegPath(context: Context): File = File(context.applicationInfo.nativeLibraryDir, "libffmpegexec.so")

    fun convert(context: Context, input: File, name: String): Result {
        require(input.isFile && input.length() > 0L) { "预览文件为空" }
        val ext = extensionOf(name)
        val direct = decodeWithPlatform(input, ext)
        if (direct != null) return direct
        return decodeWithFfmpeg(context, input, ext)
    }

    private fun decodeWithPlatform(input: File, ext: String): Result? {
        val platform = ext in BROWSER_DIRECT || ext in setOf("heic", "heif", "ico", "cur")
        if (!platform) return null
        if (Build.VERSION.SDK_INT < 28) {
            val bitmap = android.graphics.BitmapFactory.decodeFile(input.absolutePath) ?: return null
            return persistBitmap(bitmap, input, "ImageDecoder")
        }
        return runCatching {
            val source = ImageDecoder.createSource(input)
            val bitmap = ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
                val width = info.size.width
                val height = info.size.height
                require(width > 0 && height > 0) { "图片超过浏览器解码安全限制" }
                require(width <= 8192 && height <= 8192) { "图片超过浏览器解码安全限制" }
                require(width.toLong() * height.toLong() <= MAX_PIXELS) { "图片超过浏览器解码安全限制" }
                val longest = maxOf(width, height)
                if (longest > MAX_EDGE) {
                    val scale = MAX_EDGE.toFloat() / longest.toFloat()
                    decoder.setTargetSize((width * scale).toInt().coerceAtLeast(1), (height * scale).toInt().coerceAtLeast(1))
                }
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
            persistBitmap(bitmap, input, "ImageDecoder")
        }.getOrElse { error ->
            if (error.message?.contains("超过") == true) throw error
            null
        }
    }

    private fun persistBitmap(bitmap: Bitmap, input: File, engine: String): Result {
        val width = bitmap.width
        val height = bitmap.height
        require(width > 0 && height > 0) { "图片超过浏览器解码安全限制" }
        require(width <= 8192 && height <= 8192) { "图片超过浏览器解码安全限制" }
        require(width.toLong() * height.toLong() <= MAX_PIXELS) { "图片超过浏览器解码安全限制" }
        val output = File(input.parentFile, input.nameWithoutExtension + ".preview.jpg")
        FileOutputStream(output).use { stream ->
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 82, stream)) {
                error("图片编码失败")
            }
        }
        if (!bitmap.isRecycled) bitmap.recycle()
        require(output.isFile && output.length() > 0L) { "图片编码失败" }
        return Result(output, width, height, engine)
    }

    private fun decodeWithFfmpeg(context: Context, input: File, ext: String): Result {
        ensureLoaded()
        val ffmpeg = ffmpegPath(context)
        require(ffmpeg.isFile && ffmpeg.canExecute()) { "FFmpeg 未打包进本版本" }
        val output = File(input.parentFile, input.nameWithoutExtension + ".preview.jpg")
        val error = nativeConvert(ffmpeg.absolutePath, input.absolutePath, output.absolutePath, MAX_EDGE)
        if (error != null) error(error)
        require(output.isFile && output.length() > 0L) { "FFmpeg 解码失败" }
        val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeFile(output.absolutePath, bounds)
        val width = bounds.outWidth
        val height = bounds.outHeight
        require(width > 0 && height > 0) { "图片超过浏览器解码安全限制" }
        require(width <= 8192 && height <= 8192) { "图片超过浏览器解码安全限制" }
        require(width.toLong() * height.toLong() <= MAX_PIXELS) { "图片超过浏览器解码安全限制" }
        return Result(output, width, height, "$ENGINE/$ext")
    }

    private fun ensureLoaded() {
        if (loaded.get()) return
        synchronized(this) {
            if (loaded.get()) return
            try {
                System.loadLibrary("zephyr_ffmpeg_android")
                loaded.set(true)
            } catch (failure: UnsatisfiedLinkError) {
                loadError = "FFmpeg 未打包进本版本"
                throw IllegalStateException(loadError)
            }
        }
    }

    fun extensionOf(name: String): String {
        val base = name.substringAfterLast('/').substringAfterLast('\\')
        val dot = base.lastIndexOf('.')
        if (dot <= 0 || dot == base.length - 1) return ""
        return base.substring(dot + 1).lowercase()
    }

    data class Result(val file: File, val width: Int, val height: Int, val engine: String)
}
