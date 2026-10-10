package one.zephyr.mobile.feature.notes

import android.content.Context
import org.videolan.libvlc.LibVLC

/**
 * One LibVLC per process, as the official libvlc-android demo requires.
 *
 * LibVLC 3.x keeps global native state: creating and releasing an engine per
 * preview pane (every Compose entry/exit) reliably crashes the process with a
 * native SIGSEGV on the second engine teardown. The engine is therefore
 * process-lived and never released; [org.videolan.libvlc.MediaPlayer] and
 * [org.videolan.libvlc.Media] stay per-preview and are released normally.
 */
object VlcEngine {
    @Volatile private var instance: LibVLC? = null

    fun obtain(context: Context): LibVLC =
        instance ?: synchronized(this) {
            instance ?: LibVLC(
                context.applicationContext,
                arrayListOf("--no-video-title-show", "--network-caching=1200"),
            ).also { instance = it }
        }
}
