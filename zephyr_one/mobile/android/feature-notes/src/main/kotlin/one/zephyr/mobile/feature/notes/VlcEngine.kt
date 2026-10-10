package one.zephyr.mobile.feature.notes

import android.content.Context
import android.util.Log
import org.videolan.libvlc.LibVLC
import java.io.File

/**
 * One LibVLC per process, as the official libvlc-android demo requires.
 *
 * LibVLC 3.x keeps global native state: creating and releasing an engine per
 * preview pane (every Compose entry/exit) reliably crashes the process with a
 * native SIGSEGV on the second engine teardown. The engine is therefore
 * process-lived and never released; [org.videolan.libvlc.MediaPlayer] and
 * [org.videolan.libvlc.Media] stay per-preview and are released normally.
 *
 * Per-player teardown order is stop(), then detachViews(), then release().
 * libvlc 3.6's detachViews() disables the video track while the vout is still
 * attached; doing that (or clearing the main looper, which drops the player's
 * own surface update) and then playing again SIGSEGVs the process.
 *
 * The stock loader terminates the process when libvlc or libvlcjni fails to
 * load. On Android 16 that is an instant death the moment a preview opens,
 * with no stack. Load the two libraries here first and keep the failure as a
 * message instead.
 */
object VlcEngine {
    private const val TAG = "VlcEngine"
    @Volatile private var instance: LibVLC? = null
    @Volatile private var failure: String? = null

    fun failure(): String? = failure

    fun obtain(context: Context): LibVLC? {
        failure?.let { return null }
        instance?.let { return it }
        return synchronized(this) {
            failure?.let { return null }
            instance?.let { return it }
            val app = context.applicationContext
            val loaded = runCatching { loadNative(app) }
            if (loaded.isFailure) {
                failure = loaded.exceptionOrNull()?.message ?: "LibVLC 原生库加载失败"
                Log.e(TAG, failure, loaded.exceptionOrNull())
                return null
            }
            runCatching {
                LibVLC(app, arrayListOf("--no-video-title-show", "--network-caching=1200"))
            }.fold(
                onSuccess = { created -> instance = created; created },
                onFailure = { error ->
                    failure = error.message ?: "LibVLC 初始化失败"
                    Log.e(TAG, failure, error)
                    null
                },
            )
        }
    }

    private fun loadNative(context: Context) {
        // libvlcjni is linked against libvlc. Load that one first so a missing
        // dependency fails here, with a message, instead of inside the stock
        // loader's process-termination path.
        val dir = nativeDir(context)
        loadOne(dir, "c++_shared", required = false)
        loadOne(dir, "vlc", required = true)
        loadOne(dir, "vlcjni", required = true)
    }

    private fun loadOne(dir: String?, name: String, required: Boolean) {
        val bundled = dir?.let { File(it, "lib$name.so") }
        val error = runCatching {
            if (bundled != null && bundled.isFile) System.load(bundled.absolutePath)
            else System.loadLibrary(name)
        }.exceptionOrNull() ?: return
        val where = bundled?.absolutePath ?: "lib$name.so"
        val message = "无法加载 $where：${error.javaClass.simpleName}: ${error.message}"
        if (required) error(message)
        Log.w(TAG, message, error)
    }

    private fun nativeDir(context: Context): String? =
        runCatching { context.applicationInfo.nativeLibraryDir }.getOrNull()
}
