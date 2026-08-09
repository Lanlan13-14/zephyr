package one.zephyr.mobile.feature.remote

import one.zephyr.mobile.model.RdpChannel
import one.zephyr.mobile.protocol.rdp.ChannelDecision
import one.zephyr.mobile.protocol.rdp.PermissionState

/**
 * One channel row as S22 draws it.
 *
 * The reason code from [RdpChannelPolicy] is kept alongside the rendered text so the row can offer the
 * right action: a permission that was denied once needs a re-request, a permission denied permanently
 * needs the system settings deep link REMOTE_DESKTOP_EXPERIENCE.md 8 requires, and an unavailable
 * drive needs a directory picker. One boolean could not tell those apart.
 */
data class RemoteChannelRow(
    val channel: RdpChannel,
    val label: String,
    val enabled: Boolean,
    val reason: String,
    val permission: PermissionState,
    /** True when the OS will no longer show a prompt, so the only route left is Settings. */
    val needsSettings: Boolean,
) {
    val statusText: String
        get() = when {
            enabled -> "已启用"
            reason == RemoteChannels.REASON_NOT_REQUESTED -> "未请求"
            reason == RemoteChannels.REASON_PERMISSION_DENIED && needsSettings -> "权限被永久拒绝"
            reason == RemoteChannels.REASON_PERMISSION_DENIED -> "权限未授予"
            reason == RemoteChannels.REASON_FILE_SHARE -> "目录授权不可用"
            else -> "不可用"
        }

    /** Whether tapping the row can do anything. A row with no action must not look tappable. */
    val actionable: Boolean
        get() = !enabled && (
            reason == RemoteChannels.REASON_PERMISSION_DENIED || reason == RemoteChannels.REASON_FILE_SHARE
            )
}

/**
 * Channel state for the S22 channels sheet.
 *
 * Wraps [RdpChannelPolicy] rather than re-deciding: the policy already encodes the frozen rule that a
 * denied permission closes one channel and never the session, and duplicating that decision in the UI
 * layer is exactly how the two would drift.
 */
object RemoteChannels {

    const val REASON_NOT_REQUESTED = "not_requested"
    const val REASON_PERMISSION_DENIED = "permission_denied"
    const val REASON_FILE_SHARE = "file_share_unavailable"
    const val REASON_GRANTED = "granted"

    fun labelOf(channel: RdpChannel): String = when (channel) {
        RdpChannel.AUDIO -> "音频输出"
        RdpChannel.CLIPBOARD -> "剪贴板"
        RdpChannel.MICROPHONE -> "麦克风"
        RdpChannel.CAMERA -> "摄像头"
        RdpChannel.DRIVE -> "文件 drive"
        RdpChannel.LOCATION -> "位置"
    }

    /** Android runtime permission for a channel, or null when the channel needs no grant. */
    fun permissionFor(channel: RdpChannel): String? = when (channel) {
        RdpChannel.MICROPHONE -> "android.permission.RECORD_AUDIO"
        RdpChannel.CAMERA -> "android.permission.CAMERA"
        RdpChannel.LOCATION -> "android.permission.ACCESS_FINE_LOCATION"
        else -> null
    }

    fun rows(
        decisions: List<ChannelDecision>,
        permissions: Map<RdpChannel, PermissionState>,
        permanentlyDenied: Set<RdpChannel>,
    ): List<RemoteChannelRow> = decisions.map { decision ->
        RemoteChannelRow(
            channel = decision.channel,
            label = labelOf(decision.channel),
            enabled = decision.enabled,
            reason = decision.reason,
            permission = permissions[decision.channel] ?: PermissionState.NOT_REQUESTED,
            needsSettings = decision.channel in permanentlyDenied,
        )
    }

    /**
     * Channels whose permission should be requested now.
     *
     * Only the ones the session actually asked for, which is the frozen "实际请求时申请" rule: asking
     * for the microphone at connect time when the remote never opens an audio-input channel trains the
     * user to deny prompts, and section 8 additionally forbids re-prompting after a permanent denial.
     */
    fun toRequest(
        rows: List<RemoteChannelRow>,
        requestedByRemote: Set<RdpChannel>,
    ): List<String> = rows
        .filter { it.channel in requestedByRemote }
        .filter { it.reason == REASON_PERMISSION_DENIED && !it.needsSettings }
        .mapNotNull { permissionFor(it.channel) }
        .distinct()

    /** A mic or camera that is live must stay visible; section 8 requires a persistent pill. */
    fun activeCaptureLabels(rows: List<RemoteChannelRow>): List<String> = rows
        .filter { it.enabled && (it.channel == RdpChannel.MICROPHONE || it.channel == RdpChannel.CAMERA) }
        .map { it.label }
}
