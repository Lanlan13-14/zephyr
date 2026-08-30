package one.zephyr.mobile.app.sync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import one.zephyr.mobile.R
import one.zephyr.mobile.app.ZephyrOneApplication

/**
 * Discloses that the user asked One to keep the sync/wake channel online in the background.
 *
 * WakeCoordinator otherwise drops the socket on process background because Android will not keep a
 * silent connection alive. Opting in starts this foreground service: the ongoing notification is
 * the disclosure, and its stop action is the off switch. SCREEN_CATALOG.md 22 uses the same shape
 * for the file bridge; this is that shape for the account channel.
 */
class ConnectionKeepAliveService : LifecycleService() {

    override fun onBind(intent: Intent): IBinder? {
        super.onBind(intent)
        return null
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        val app = application as? ZephyrOneApplication
        if (intent?.action == ACTION_STOP) {
            app?.container?.setKeepAliveEnabled(false)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        createChannel()
        try {
            val notification = buildNotification()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (_: RuntimeException) {
            stopSelf()
            return START_NOT_STICKY
        }

        if (app == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        lifecycleScope.launch {
            app.ready.first { it }
            if (!app.container.shouldHoldAlive()) {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return@launch
            }
            app.container.applyKeepAliveToCurrentAccount()
        }
        return START_STICKY
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.keep_alive_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.keep_alive_channel_description)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val stop = PendingIntent.getService(
            this,
            REQUEST_STOP,
            Intent(this, ConnectionKeepAliveService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
            PendingIntent.getActivity(
                this,
                REQUEST_OPEN,
                launch,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.keep_alive_notification_title))
            .setContentText(getString(R.string.keep_alive_notification_text))
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, getString(R.string.keep_alive_stop), stop)
            .build()
    }

    companion object {
        const val ACTION_STOP = "one.zephyr.mobile.action.STOP_KEEP_ALIVE"

        private const val CHANNEL_ID = "zephyr-one-keep-alive"
        private const val NOTIFICATION_ID = 4202
        private const val REQUEST_STOP = 1
        private const val REQUEST_OPEN = 2

        fun start(context: Context) {
            val app = context.applicationContext
            try {
                app.startForegroundService(Intent(app, ConnectionKeepAliveService::class.java))
            } catch (_: RuntimeException) {
                // Missing notification permission or a background-start restriction: the preference
                // stays so a later foreground attempt can start the disclosure. The wake stream
                // still drops on background until the service actually runs.
            }
        }

        fun stop(context: Context) {
            val app = context.applicationContext
            app.stopService(Intent(app, ConnectionKeepAliveService::class.java))
        }
    }
}
