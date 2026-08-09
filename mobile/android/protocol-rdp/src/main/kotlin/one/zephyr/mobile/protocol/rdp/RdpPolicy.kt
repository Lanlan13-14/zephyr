package one.zephyr.mobile.protocol.rdp

import one.zephyr.mobile.model.FileSyncDirectoryIntent
import one.zephyr.mobile.model.RdpChannel
import one.zephyr.mobile.model.RdpSettings

/** Whether the OS permission behind a channel has been granted. */
enum class PermissionState { GRANTED, DENIED, NOT_REQUESTED }

/** The outcome of gating one channel. */
data class ChannelDecision(val channel: RdpChannel, val enabled: Boolean, val reason: String)

/**
 * Decides which RDP channels open.
 *
 * DEVELOPMENT.md 14.3: a channel is requested only when the connection enabled it *and* the session
 * actually needs it, and a denied permission closes that one channel rather than failing the whole
 * session. Losing the whole desktop because the user declined the microphone is the failure this
 * prevents.
 */
object RdpChannelPolicy {

    /** Channels backed by an OS permission prompt. The rest need no runtime grant. */
    val PERMISSION_BACKED = setOf(RdpChannel.MICROPHONE, RdpChannel.CAMERA, RdpChannel.LOCATION)

    fun decide(
        settings: RdpSettings,
        permissions: Map<RdpChannel, PermissionState>,
        driveAvailable: Boolean,
    ): List<ChannelDecision> = RdpChannel.entries.map { channel ->
        when {
            channel !in settings.requestedChannels ->
                ChannelDecision(channel, false, "not_requested")

            channel == RdpChannel.DRIVE && !driveAvailable ->
                // Reported specifically rather than as a generic connect failure, because the fix is
                // to re-pick a directory and the user cannot guess that from "connection failed".
                ChannelDecision(channel, false, "file_share_unavailable")

            channel in PERMISSION_BACKED && permissions[channel] != PermissionState.GRANTED ->
                ChannelDecision(channel, false, "permission_denied")

            else -> ChannelDecision(channel, true, "granted")
        }
    }

    fun granted(
        settings: RdpSettings,
        permissions: Map<RdpChannel, PermissionState>,
        driveAvailable: Boolean,
    ): Set<RdpChannel> =
        decide(settings, permissions, driveAvailable).filter { it.enabled }.map { it.channel }.toSet()
}

/** A directory offered to the remote Windows session as an RDPDR drive. */
data class RdpDriveMapping(
    /** Share name the remote sees: PHONE, DOCUMENTS or a user-chosen label. */
    val shareName: String,
    val profileId: String,
    val readOnly: Boolean,
)

sealed interface RdpDriveResolution {
    data class Mapped(val mapping: RdpDriveMapping) : RdpDriveResolution

    /** No drive this session, with a reason the UI can act on. */
    data class Unavailable(val code: String, val detail: String) : RdpDriveResolution

    /** `storageIntent=ask`: the user picks per session, so nothing is mapped until they answer. */
    data object NeedsUserChoice : RdpDriveResolution
}

/** One authorised directory as the platform reports it, not as the config hopes. */
data class FileSyncShareProfile(
    val profileId: String,
    val shareName: String,
    val readOnly: Boolean,
    /** False once a SAF grant is revoked or a security-scoped bookmark goes stale. */
    val grantValid: Boolean,
)

/**
 * Resolves the drive mapping for one session.
 *
 * The read-only rule is the important part: DEVELOPMENT.md 13.2 takes the *strictest* of profile,
 * connection and server, and ADR-004 adds that `readOnly` must reach the provider's operation
 * checks because "there is no trustworthy single read-only directory product switch" at the protocol
 * layer. So this returns the narrowed value and the ZFT2 provider enforces it per operation.
 */
object RdpDrivePolicy {

    fun resolve(
        intent: FileSyncDirectoryIntent,
        profile: FileSyncShareProfile?,
        connectionAllowsWrite: Boolean,
        serverAllowsWrite: Boolean,
    ): RdpDriveResolution {
        if (intent == FileSyncDirectoryIntent.OFF) {
            return RdpDriveResolution.Unavailable("storage_disabled", "Storage redirection is off")
        }
        if (intent == FileSyncDirectoryIntent.ASK && profile == null) {
            return RdpDriveResolution.NeedsUserChoice
        }
        val resolved = profile
            ?: return RdpDriveResolution.Unavailable("file_share_unavailable", "No directory is authorised")

        // Checked before the mapping is built: FreeRDP stats the path while assembling settings, and
        // a stale grant would fail the entire connection instead of just the drive.
        if (!resolved.grantValid) {
            return RdpDriveResolution.Unavailable("file_share_unavailable", "The directory grant is no longer valid")
        }

        val readOnly = resolved.readOnly || !connectionAllowsWrite || !serverAllowsWrite
        return RdpDriveResolution.Mapped(
            RdpDriveMapping(
                shareName = resolved.shareName.ifBlank { DEFAULT_SHARE_NAME },
                profileId = resolved.profileId,
                readOnly = readOnly,
            ),
        )
    }

    const val DEFAULT_SHARE_NAME = "PHONE"
}
