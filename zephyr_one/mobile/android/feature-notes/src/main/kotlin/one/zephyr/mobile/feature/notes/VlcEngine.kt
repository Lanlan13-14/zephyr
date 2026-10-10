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
 *
 * Per-player teardown order is stop(), then detachViews(), then release().
 * libvlc 3.6's detachViews() disables the video track while the vout is still
 * attached; doing that (or clearing the main looper, which drops the player's
 * own surface update) and then playing again SIGSEGVs the process.
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
