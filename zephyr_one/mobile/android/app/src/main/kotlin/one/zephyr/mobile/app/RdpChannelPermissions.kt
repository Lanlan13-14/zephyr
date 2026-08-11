package one.zephyr.mobile.app

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import one.zephyr.mobile.feature.remote.RemoteChannels
import one.zephyr.mobile.feature.remote.RemotePermissionOutcome
import one.zephyr.mobile.model.RdpChannel
import one.zephyr.mobile.protocol.rdp.PermissionState

/** User-driven Android system actions for one RDP channel row. */
internal class RdpChannelPermissionActions(
    val request: (RdpChannel) -> Unit,
    val openSettings: (RdpChannel) -> Unit,
    /** Reads existing grants only. It never launches a system permission dialog. */
    val refreshExisting: () -> Unit,
)

/**
 * Owns the Activity Result launchers for RDP channel permissions.
 *
 * A launcher is called only from [RdpChannelPermissionActions.request] or `openSettings`, which are
 * wired to explicit buttons in the channels panel. The saved pending channel lets a result survive
 * Activity recreation and also prevents rapid taps or recomposition from stacking system dialogs.
 */
@Composable
internal fun rememberRdpChannelPermissionActions(
    onObserved: (RdpChannel, PermissionState, Boolean) -> Unit,
    onResult: (RdpChannel, PermissionState, Boolean) -> Unit,
): RdpChannelPermissionActions {
    val context = LocalContext.current
    val activity = context.findActivity()
    val sdkInt = Build.VERSION.SDK_INT
    val preferences = remember(context.applicationContext) {
        context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    }
    val currentOnObserved by rememberUpdatedState(onObserved)
    val currentOnResult by rememberUpdatedState(onResult)

    var pendingRequestChannel by rememberSaveable { mutableStateOf<String?>(null) }
    var pendingSettingsChannel by rememberSaveable { mutableStateOf<String?>(null) }

    fun currentOutcome(
        channel: RdpChannel,
        activityResult: Map<String, Boolean> = emptyMap(),
    ): RemotePermissionOutcome {
        val permissions = RemoteChannels.permissionsFor(channel, sdkInt)
        val granted = permissions.filterTo(linkedSetOf()) { permission ->
            activityResult[permission] == true ||
                ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
        }
        val requestable = if (activity == null) {
            // Failing open here avoids labelling a denial permanent when no Activity is available to
            // answer the rationale query. The normal app host always resolves to an Activity.
            permissions.toSet()
        } else {
            permissions.filterTo(linkedSetOf()) { permission ->
                ActivityCompat.shouldShowRequestPermissionRationale(activity, permission)
            }
        }
        return RemoteChannels.permissionOutcome(channel, sdkInt, granted, requestable)
    }

    fun reportResult(channel: RdpChannel, outcome: RemotePermissionOutcome) {
        currentOnResult(channel, outcome.state, outcome.permanentlyDenied)
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        val channel = pendingRequestChannel.toRdpChannelOrNull()
        pendingRequestChannel = null
        if (channel != null) reportResult(channel, currentOutcome(channel, result))
    }

    val settingsLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult(),
    ) {
        val channel = pendingSettingsChannel.toRdpChannelOrNull()
        pendingSettingsChannel = null
        if (channel != null) reportResult(channel, currentOutcome(channel))
    }

    return remember(context, activity, sdkInt, permissionLauncher, settingsLauncher, preferences) {
        RdpChannelPermissionActions(
            request = request@{ channel ->
                if (pendingRequestChannel != null || pendingSettingsChannel != null) return@request
                val permissions = RemoteChannels.permissionsFor(channel, sdkInt)
                if (permissions.isEmpty()) return@request

                val existing = currentOutcome(channel)
                if (existing.state == PermissionState.GRANTED) {
                    reportResult(channel, existing)
                    return@request
                }

                val requestedBefore = preferences.getBoolean(channel.requestedKey(), false)
                if (requestedBefore && existing.permanentlyDenied) {
                    reportResult(channel, existing)
                    return@request
                }

                preferences.edit().putBoolean(channel.requestedKey(), true).apply()
                pendingRequestChannel = channel.name
                runCatching { permissionLauncher.launch(permissions.toTypedArray()) }
                    .onFailure {
                        pendingRequestChannel = null
                        reportResult(
                            channel,
                            RemotePermissionOutcome(PermissionState.DENIED, permanentlyDenied = false),
                        )
                    }
            },
            openSettings = openSettings@{ channel ->
                if (pendingRequestChannel != null || pendingSettingsChannel != null) return@openSettings
                pendingSettingsChannel = channel.name
                val intent = Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.fromParts("package", context.packageName, null),
                )
                runCatching { settingsLauncher.launch(intent) }
                    .onFailure {
                        pendingSettingsChannel = null
                        reportResult(channel, currentOutcome(channel))
                    }
            },
            refreshExisting = refresh@{
                if (pendingRequestChannel != null || pendingSettingsChannel != null) return@refresh
                for (channel in RdpChannel.entries) {
                    if (RemoteChannels.permissionsFor(channel, sdkInt).isEmpty()) continue
                    val outcome = currentOutcome(channel)
                    val wasRequested = preferences.getBoolean(channel.requestedKey(), false)
                    if (outcome.state == PermissionState.GRANTED || wasRequested) {
                        currentOnObserved(channel, outcome.state, outcome.permanentlyDenied)
                    }
                }
            },
        )
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

private fun String?.toRdpChannelOrNull(): RdpChannel? =
    this?.let { name -> RdpChannel.entries.firstOrNull { it.name == name } }

private fun RdpChannel.requestedKey(): String = "requested_" + name.lowercase()

private const val PREFERENCES_NAME = "rdp_channel_permissions"
