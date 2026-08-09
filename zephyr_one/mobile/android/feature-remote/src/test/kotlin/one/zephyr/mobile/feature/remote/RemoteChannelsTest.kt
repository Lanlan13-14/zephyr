package one.zephyr.mobile.feature.remote

import one.zephyr.mobile.model.RdpChannel
import one.zephyr.mobile.model.RdpSettings
import one.zephyr.mobile.protocol.rdp.ChannelDecision
import one.zephyr.mobile.protocol.rdp.PermissionState
import one.zephyr.mobile.protocol.rdp.RdpChannelPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The S22 channels sheet over RdpChannelPolicy (REMOTE_DESKTOP_EXPERIENCE.md 8).
 *
 * The rows deliberately re-render the policy's reason code rather than re-deciding anything, so what
 * is tested here is the mapping from reason to what the user can do next: a denied permission offers
 * a re-request, a permanently denied one offers Settings, and an unavailable drive offers a picker.
 * One boolean could not tell those three apart, which is why the reason travels with the row.
 */
class RemoteChannelsTest {

    private val allChannelsOn = RdpSettings(
        microphone = true,
        camera = true,
        storage = true,
        location = true,
    )

    private fun rowsFor(
        settings: RdpSettings = allChannelsOn,
        permissions: Map<RdpChannel, PermissionState> = emptyMap(),
        driveAvailable: Boolean = false,
        permanentlyDenied: Set<RdpChannel> = emptySet(),
    ): List<RemoteChannelRow> = RemoteChannels.rows(
        decisions = RdpChannelPolicy.decide(settings, permissions, driveAvailable),
        permissions = permissions,
        permanentlyDenied = permanentlyDenied,
    )

    private fun row(rows: List<RemoteChannelRow>, channel: RdpChannel): RemoteChannelRow =
        rows.first { it.channel == channel }

    @Test
    fun everyChannelIsLabelled() {
        assertEquals("音频输出", RemoteChannels.labelOf(RdpChannel.AUDIO))
        assertEquals("剪贴板", RemoteChannels.labelOf(RdpChannel.CLIPBOARD))
        assertEquals("麦克风", RemoteChannels.labelOf(RdpChannel.MICROPHONE))
        assertEquals("摄像头", RemoteChannels.labelOf(RdpChannel.CAMERA))
        assertEquals("文件 drive", RemoteChannels.labelOf(RdpChannel.DRIVE))
        assertEquals("位置", RemoteChannels.labelOf(RdpChannel.LOCATION))

        val labels = RdpChannel.entries.map { RemoteChannels.labelOf(it) }
        assertEquals(labels.size, labels.toSet().size)
    }

    @Test
    fun onlyCaptureChannelsAreBackedByARuntimePermission() {
        /* Audio *output* and the clipboard need no grant on Android. Requesting one anyway would train
         * the user to deny prompts, which is what section 8's 实际请求时申请 rule is guarding. */
        assertEquals("android.permission.RECORD_AUDIO", RemoteChannels.permissionFor(RdpChannel.MICROPHONE))
        assertEquals("android.permission.CAMERA", RemoteChannels.permissionFor(RdpChannel.CAMERA))
        assertEquals("android.permission.ACCESS_FINE_LOCATION", RemoteChannels.permissionFor(RdpChannel.LOCATION))
        assertNull(RemoteChannels.permissionFor(RdpChannel.AUDIO))
        assertNull(RemoteChannels.permissionFor(RdpChannel.CLIPBOARD))
        assertNull(RemoteChannels.permissionFor(RdpChannel.DRIVE))
    }

    @Test
    fun rowsCoverEveryChannelInPolicyOrder() {
        // A dropped row would silently hide a live microphone from the sheet.
        val rows = rowsFor()
        assertEquals(RdpChannel.entries.size, rows.size)
        assertEquals(RdpChannel.entries.toList(), rows.map { it.channel })
    }

    @Test
    fun anUnrequestedChannelReadsAsNotRequestedRatherThanUnavailable() {
        /* Default settings enable sound and the clipboard only. The other four are off by choice, and
         * reporting them as 不可用 would send the user hunting for a permission that was never asked. */
        val rows = rowsFor(settings = RdpSettings())
        assertEquals("已启用", row(rows, RdpChannel.AUDIO).statusText)
        assertEquals("已启用", row(rows, RdpChannel.CLIPBOARD).statusText)

        val mic = row(rows, RdpChannel.MICROPHONE)
        assertFalse(mic.enabled)
        assertEquals(RemoteChannels.REASON_NOT_REQUESTED, mic.reason)
        assertEquals("未请求", mic.statusText)
        // Nothing to do: the switch is on the connection, not in this sheet.
        assertFalse(mic.actionable)
    }

    @Test
    fun aMissingPermissionEntryIsNotRequestedNotDenied() {
        // Absent from the map means never asked. Defaulting to DENIED would show a false rejection.
        val rows = rowsFor()
        assertEquals(PermissionState.NOT_REQUESTED, row(rows, RdpChannel.MICROPHONE).permission)
        assertEquals(PermissionState.NOT_REQUESTED, row(rows, RdpChannel.CAMERA).permission)
    }

    @Test
    fun aDeniedPermissionClosesOneChannelAndOffersARetry() {
        val rows = rowsFor(permissions = mapOf(RdpChannel.MICROPHONE to PermissionState.DENIED))
        val mic = row(rows, RdpChannel.MICROPHONE)
        assertFalse(mic.enabled)
        assertEquals(RemoteChannels.REASON_PERMISSION_DENIED, mic.reason)
        assertEquals("权限未授予", mic.statusText)
        assertTrue(mic.actionable)
        assertFalse(mic.needsSettings)

        // The rest of the session is untouched: losing the desktop over a declined mic is the failure
        // this rule exists to prevent.
        assertTrue(row(rows, RdpChannel.AUDIO).enabled)
        assertTrue(row(rows, RdpChannel.CLIPBOARD).enabled)
    }

    @Test
    fun aPermanentDenialSaysSoRatherThanRePrompting() {
        val rows = rowsFor(
            permissions = mapOf(RdpChannel.CAMERA to PermissionState.DENIED),
            permanentlyDenied = setOf(RdpChannel.CAMERA),
        )
        val camera = row(rows, RdpChannel.CAMERA)
        assertTrue(camera.needsSettings)
        assertEquals("权限被永久拒绝", camera.statusText)
        // Still actionable, but the action is the Settings deep link rather than a prompt the OS will
        // now silently refuse to show.
        assertTrue(camera.actionable)
    }

    @Test
    fun anUnavailableDriveIsReportedAsADirectoryProblem() {
        /* Specific rather than a generic connect failure: the fix is to re-pick a directory, and the
         * user cannot guess that from "连接失败". */
        val rows = rowsFor(driveAvailable = false)
        val drive = row(rows, RdpChannel.DRIVE)
        assertFalse(drive.enabled)
        assertEquals(RemoteChannels.REASON_FILE_SHARE, drive.reason)
        assertEquals("目录授权不可用", drive.statusText)
        assertTrue(drive.actionable)
    }

    @Test
    fun anAuthorisedDriveIsSimplyEnabled() {
        val rows = rowsFor(driveAvailable = true)
        val drive = row(rows, RdpChannel.DRIVE)
        assertTrue(drive.enabled)
        assertEquals(RemoteChannels.REASON_GRANTED, drive.reason)
        assertEquals("已启用", drive.statusText)
        // An enabled row has nothing to fix, so it must not look tappable.
        assertFalse(drive.actionable)
    }

    @Test
    fun aGrantedPermissionEnablesItsChannel() {
        val rows = rowsFor(
            permissions = mapOf(
                RdpChannel.MICROPHONE to PermissionState.GRANTED,
                RdpChannel.CAMERA to PermissionState.GRANTED,
                RdpChannel.LOCATION to PermissionState.GRANTED,
            ),
            driveAvailable = true,
        )
        assertTrue(rows.all { it.enabled })
        assertTrue(rows.all { it.reason == RemoteChannels.REASON_GRANTED })
    }

    @Test
    fun onlyChannelsTheSessionAskedForArePrompted() {
        /* The frozen rule: asking for the microphone at connect time when the remote never opens an
         * audio-input channel is exactly what teaches users to hit Deny. */
        val rows = rowsFor(
            permissions = mapOf(
                RdpChannel.MICROPHONE to PermissionState.DENIED,
                RdpChannel.CAMERA to PermissionState.DENIED,
            ),
        )
        val requested = RemoteChannels.toRequest(rows, requestedByRemote = setOf(RdpChannel.MICROPHONE))
        assertEquals(listOf("android.permission.RECORD_AUDIO"), requested)
    }

    @Test
    fun aPermanentlyDeniedChannelIsNeverPromptedAgain() {
        val rows = rowsFor(
            permissions = mapOf(RdpChannel.MICROPHONE to PermissionState.DENIED),
            permanentlyDenied = setOf(RdpChannel.MICROPHONE),
        )
        val requested = RemoteChannels.toRequest(rows, requestedByRemote = setOf(RdpChannel.MICROPHONE))
        // The OS would not show the dialog, so a request here is a no-op that looks like a bug.
        assertTrue(requested.isEmpty())
    }

    @Test
    fun anAlreadyGrantedChannelIsNotPromptedAgain() {
        val rows = rowsFor(permissions = mapOf(RdpChannel.MICROPHONE to PermissionState.GRANTED))
        assertTrue(RemoteChannels.toRequest(rows, setOf(RdpChannel.MICROPHONE)).isEmpty())
    }

    @Test
    fun anUnrequestedChannelIsNotPromptedByTheSheet() {
        // reason is not_requested, so there is nothing to grant until the connection enables it.
        val rows = rowsFor(settings = RdpSettings())
        assertTrue(RemoteChannels.toRequest(rows, setOf(RdpChannel.MICROPHONE)).isEmpty())
    }

    @Test
    fun aChannelWithNoPermissionNeverProducesAnEmptyRequest() {
        /* DRIVE is denied by a missing directory, not by a permission. mapNotNull is what keeps a null
         * permission name out of the request array, where it would throw at the framework boundary. */
        val decisions = listOf(
            ChannelDecision(RdpChannel.DRIVE, false, RemoteChannels.REASON_PERMISSION_DENIED),
        )
        val rows = RemoteChannels.rows(decisions, emptyMap(), emptySet())
        assertTrue(RemoteChannels.toRequest(rows, setOf(RdpChannel.DRIVE)).isEmpty())
    }

    @Test
    fun duplicatePermissionsAreRequestedOnce() {
        // Two rows can share one Android permission; asking twice stacks two identical dialogs.
        val decisions = listOf(
            ChannelDecision(RdpChannel.MICROPHONE, false, RemoteChannels.REASON_PERMISSION_DENIED),
            ChannelDecision(RdpChannel.MICROPHONE, false, RemoteChannels.REASON_PERMISSION_DENIED),
        )
        val rows = RemoteChannels.rows(decisions, emptyMap(), emptySet())
        assertEquals(
            listOf("android.permission.RECORD_AUDIO"),
            RemoteChannels.toRequest(rows, setOf(RdpChannel.MICROPHONE)),
        )
    }

    @Test
    fun aLiveMicOrCameraStaysVisibleInThePill() {
        /* Section 8 requires a persistent indicator. Silently capturing audio because a channel opened
         * mid-session is the outcome this list prevents. */
        val rows = rowsFor(
            permissions = mapOf(
                RdpChannel.MICROPHONE to PermissionState.GRANTED,
                RdpChannel.CAMERA to PermissionState.GRANTED,
                RdpChannel.LOCATION to PermissionState.GRANTED,
            ),
            driveAvailable = true,
        )
        assertEquals(listOf("麦克风", "摄像头"), RemoteChannels.activeCaptureLabels(rows))
    }

    @Test
    fun theCapturePillIgnoresChannelsThatAreNotCapture() {
        // Audio output and the clipboard are not capture, however loud the session is.
        val rows = rowsFor(settings = RdpSettings(), driveAvailable = true)
        assertTrue(RemoteChannels.activeCaptureLabels(rows).isEmpty())
    }

    @Test
    fun theCapturePillIgnoresADeniedMic() {
        val rows = rowsFor(permissions = mapOf(RdpChannel.MICROPHONE to PermissionState.DENIED))
        assertTrue(RemoteChannels.activeCaptureLabels(rows).isEmpty())
    }

    @Test
    fun anUnknownReasonFallsBackToUnavailableRatherThanClaimingSuccess() {
        /* Defensive on purpose: a reason code added to the policy without a row mapping must read as
         * 不可用, never as 已启用. */
        val decisions = listOf(ChannelDecision(RdpChannel.AUDIO, false, "some_future_reason"))
        val rows = RemoteChannels.rows(decisions, emptyMap(), emptySet())
        assertEquals("不可用", rows[0].statusText)
        assertFalse(rows[0].actionable)
    }
}
