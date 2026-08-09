package one.zephyr.mobile.app.filebridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import one.zephyr.mobile.R
import one.zephyr.mobile.app.ZephyrOneApplication

/**
 * Keeps 本机共享 online while One is in the background.
 *
 * SCREEN_CATALOG.md 22 requires this to be a foreground service with a visible stop action: a file
 * share that keeps serving a remote session after the user leaves the app is exactly the kind of
 * background access that must be disclosed rather than silently maintained. The notification is the
 * disclosure, and its stop action is the off switch.
 *
 * A [LifecycleService] so the ZFT2 session can be scoped to the service rather than to a bare
 * CoroutineScope: stopSelf then cancels the transfer coroutines rather than leaving them to finish
 * against a provider whose SAF grant may already be gone.
 */
class FileBridgeForegroundService : LifecycleService() {

    override fun onBind(intent: Intent): IBinder? {
        super.onBind(intent)
        // Started, never bound: a bound service would die with the last client, and the point of
        // this one is to outlive the UI.
        return null
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)

        if (intent?.action == ACTION_STOP) {
            stopBridgeAndSelf()
            return START_NOT_STICKY
        }

        createChannel()
        startForeground(NOTIFICATION_ID, buildNotification())
        return START_NOT_STICKY
    }

    /**
     * Stops the session before the service.
     *
     * The ZFT2 peer is told the share is going away rather than discovering it as a dropped socket,
     * which is what lets the remote side report 已停止 instead of a transport error.
     */
    private fun stopBridgeAndSelf() {
        val account = (application as? ZephyrOneApplication)?.container?.account
        if (account == null) {
            stopSelf()
            return
        }
        lifecycleScope.launch {
            account.stopFileBridge()
            stopSelf()
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.file_bridge_channel_name),
            // LOW, not DEFAULT: the notification is a disclosure the user must be able to see, not
            // an alert. A sound every time a share comes online would be noise.
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.file_bridge_channel_description)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val stop = PendingIntent.getService(
            this,
            REQUEST_STOP,
            Intent(this, FileBridgeForegroundService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.file_bridge_notification_title))
            .setContentText(getString(R.string.file_bridge_notification_text))
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            // Neither the share name nor any path appears here. A notification is visible on the lock
            // screen, and SHARED_RESOURCE_RESIDENCY.md keeps file paths out of anything ambient.
            .addAction(0, getString(R.string.file_bridge_stop), stop)
            .build()
    }

    companion object {
        const val ACTION_STOP = "one.zephyr.mobile.action.STOP_FILE_BRIDGE"

        private const val CHANNEL_ID = "zephyr-one-file-bridge"
        private const val NOTIFICATION_ID = 4201
        private const val REQUEST_STOP = 1

        fun start(context: Context) {
            context.startForegroundService(Intent(context, FileBridgeForegroundService::class.java))
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, FileBridgeForegroundService::class.java).setAction(ACTION_STOP),
            )
        }
    }
}
