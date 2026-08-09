package one.zephyr.mobile.protocol.rdp

import one.zephyr.mobile.model.FileSyncDirectoryIntent
import one.zephyr.mobile.model.RdpChannel
import one.zephyr.mobile.model.RdpSettings
import one.zephyr.mobile.model.RdpSoundMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Channel gating and the drive read-only rule.
 *
 * The behaviour worth pinning is that a refused permission costs one channel and not the session:
 * losing a whole remote desktop because the user declined the microphone is the regression these
 * tests exist to catch.
 */
class RdpPolicyTest {

    private fun decisions(
        settings: RdpSettings,
        permissions: Map<RdpChannel, PermissionState> = emptyMap(),
        driveAvailable: Boolean = false,
    ): Map<RdpChannel, ChannelDecision> =
        RdpChannelPolicy.decide(settings, permissions, driveAvailable).associateBy { it.channel }

    @Test
    fun `the default settings request audio and clipboard only`() {
        val granted = RdpChannelPolicy.granted(RdpSettings(), emptyMap(), driveAvailable = false)

        assertEquals(setOf(RdpChannel.AUDIO, RdpChannel.CLIPBOARD), granted)
    }

    @Test
    fun `every channel gets exactly one decision in enum order`() {
        val decided = RdpChannelPolicy.decide(RdpSettings(), emptyMap(), driveAvailable = false)

        assertEquals(RdpChannel.entries.size, decided.size)
        assertEquals(RdpChannel.entries.toList(), decided.map { it.channel })
    }

    @Test
    fun `a channel the connection never asked for is reported as not requested`() {
        val decided = decisions(RdpSettings())

        assertEquals("not_requested", decided.getValue(RdpChannel.MICROPHONE).reason)
        assertFalse(decided.getValue(RdpChannel.MICROPHONE).enabled)
    }

    @Test
    fun `sound off withdraws the audio channel`() {
        val decided = decisions(RdpSettings(soundMode = RdpSoundMode.OFF))

        assertFalse(decided.getValue(RdpChannel.AUDIO).enabled)
        assertEquals("not_requested", decided.getValue(RdpChannel.AUDIO).reason)
    }

    @Test
    fun `a granted OS permission opens a permission backed channel`() {
        val decided = decisions(
            RdpSettings(microphone = true, camera = true, location = true),
            permissions = mapOf(
                RdpChannel.MICROPHONE to PermissionState.GRANTED,
                RdpChannel.CAMERA to PermissionState.GRANTED,
                RdpChannel.LOCATION to PermissionState.GRANTED,
            ),
        )

        assertTrue(decided.getValue(RdpChannel.MICROPHONE).enabled)
        assertTrue(decided.getValue(RdpChannel.CAMERA).enabled)
        assertTrue(decided.getValue(RdpChannel.LOCATION).enabled)
    }

    @Test
    fun `a denied permission closes that one channel and leaves the rest open`() {
        val decided = decisions(
            RdpSettings(microphone = true),
            permissions = mapOf(RdpChannel.MICROPHONE to PermissionState.DENIED),
        )

        assertFalse(decided.getValue(RdpChannel.MICROPHONE).enabled)
        assertEquals("permission_denied", decided.getValue(RdpChannel.MICROPHONE).reason)
        // The desktop still works. This is the whole point of per-channel gating.
        assertTrue(decided.getValue(RdpChannel.AUDIO).enabled)
        assertTrue(decided.getValue(RdpChannel.CLIPBOARD).enabled)
    }

    @Test
    fun `a permission never asked for counts as not granted`() {
        // Absent is treated like denied: requesting the channel would open it before the user has
        // answered the OS prompt.
        val decided = decisions(RdpSettings(camera = true))

        assertEquals("permission_denied", decided.getValue(RdpChannel.CAMERA).reason)
        assertEquals(
            "permission_denied",
            decisions(
                RdpSettings(camera = true),
                permissions = mapOf(RdpChannel.CAMERA to PermissionState.NOT_REQUESTED),
            ).getValue(RdpChannel.CAMERA).reason,
        )
    }

    @Test
    fun `channels with no OS permission behind them ignore the permission map`() {
        // Clipboard and audio playback need no runtime grant, so a stray DENIED entry must not
        // close them.
        val decided = decisions(
            RdpSettings(),
            permissions = mapOf(
                RdpChannel.CLIPBOARD to PermissionState.DENIED,
                RdpChannel.AUDIO to PermissionState.DENIED,
            ),
        )

        assertTrue(decided.getValue(RdpChannel.CLIPBOARD).enabled)
        assertTrue(decided.getValue(RdpChannel.AUDIO).enabled)
    }

    @Test
    fun `only microphone camera and location are permission backed`() {
        assertEquals(
            setOf(RdpChannel.MICROPHONE, RdpChannel.CAMERA, RdpChannel.LOCATION),
            RdpChannelPolicy.PERMISSION_BACKED,
        )
    }

    @Test
    fun `a requested drive with no authorised directory is reported specifically`() {
        val decided = decisions(RdpSettings(storage = true), driveAvailable = false)

        // Not a generic connect failure: the fix is to re-pick a directory, and the user cannot
        // guess that from "connection failed".
        assertEquals("file_share_unavailable", decided.getValue(RdpChannel.DRIVE).reason)
        assertFalse(decided.getValue(RdpChannel.DRIVE).enabled)
    }

    @Test
    fun `a requested drive with an authorised directory opens`() {
        val decided = decisions(RdpSettings(storage = true), driveAvailable = true)

        assertTrue(decided.getValue(RdpChannel.DRIVE).enabled)
        assertEquals("granted", decided.getValue(RdpChannel.DRIVE).reason)
    }

    @Test
    fun `an unrequested drive is not reported as unavailable`() {
        // Reason order matters: a user who never enabled storage must not see a share error.
        val decided = decisions(RdpSettings(storage = false), driveAvailable = false)

        assertEquals("not_requested", decided.getValue(RdpChannel.DRIVE).reason)
    }

    @Test
    fun `storage redirection off never maps a drive`() {
        val resolution = RdpDrivePolicy.resolve(
            intent = FileSyncDirectoryIntent.OFF,
            profile = FileSyncShareProfile("p1", "PHONE", readOnly = false, grantValid = true),
            connectionAllowsWrite = true,
            serverAllowsWrite = true,
        )

        // Even with a perfectly good grant: the connection said off.
        val unavailable = resolution as RdpDriveResolution.Unavailable
        assertEquals("storage_disabled", unavailable.code)
    }

    @Test
    fun `ask with no directory yet waits for the user`() {
        val resolution = RdpDrivePolicy.resolve(
            intent = FileSyncDirectoryIntent.ASK,
            profile = null,
            connectionAllowsWrite = true,
            serverAllowsWrite = true,
        )

        assertTrue(resolution is RdpDriveResolution.NeedsUserChoice)
    }

    @Test
    fun `ask with a directory already chosen maps it`() {
        val resolution = RdpDrivePolicy.resolve(
            intent = FileSyncDirectoryIntent.ASK,
            profile = FileSyncShareProfile("p1", "DOCS", readOnly = false, grantValid = true),
            connectionAllowsWrite = true,
            serverAllowsWrite = true,
        )

        assertEquals("DOCS", (resolution as RdpDriveResolution.Mapped).mapping.shareName)
    }

    @Test
    fun `a share intent with no profile is unavailable rather than a user prompt`() {
        for (intent in listOf(FileSyncDirectoryIntent.LOCAL_SHARE, FileSyncDirectoryIntent.SERVER_BRIDGE)) {
            val resolution = RdpDrivePolicy.resolve(intent, null, true, true)
            assertEquals(
                "file_share_unavailable",
                (resolution as RdpDriveResolution.Unavailable).code,
            )
        }
    }

    @Test
    fun `a revoked grant is caught before the mapping is built`() {
        // FreeRDP stats the mapped path while assembling settings, so a stale SAF grant would fail
        // the entire connection instead of just the drive.
        val resolution = RdpDrivePolicy.resolve(
            intent = FileSyncDirectoryIntent.LOCAL_SHARE,
            profile = FileSyncShareProfile("p1", "PHONE", readOnly = false, grantValid = false),
            connectionAllowsWrite = true,
            serverAllowsWrite = true,
        )

        val unavailable = resolution as RdpDriveResolution.Unavailable
        assertEquals("file_share_unavailable", unavailable.code)
        assertTrue(unavailable.detail.contains("no longer valid"))
    }

    @Test
    fun `write access needs all three of profile connection and server to allow it`() {
        fun readOnlyFor(profileReadOnly: Boolean, connection: Boolean, server: Boolean): Boolean {
            val resolution = RdpDrivePolicy.resolve(
                intent = FileSyncDirectoryIntent.LOCAL_SHARE,
                profile = FileSyncShareProfile("p1", "PHONE", profileReadOnly, grantValid = true),
                connectionAllowsWrite = connection,
                serverAllowsWrite = server,
            )
            return (resolution as RdpDriveResolution.Mapped).mapping.readOnly
        }

        assertFalse("all three allow writes", readOnlyFor(false, true, true))
        assertTrue("the directory itself is read-only", readOnlyFor(true, true, true))
        assertTrue("the connection forbids writes", readOnlyFor(false, false, true))
        assertTrue("the server forbids writes", readOnlyFor(false, true, false))
        assertTrue("nothing allows writes", readOnlyFor(true, false, false))
    }

    @Test
    fun `a blank share name falls back to the default label`() {
        val resolution = RdpDrivePolicy.resolve(
            intent = FileSyncDirectoryIntent.LOCAL_SHARE,
            profile = FileSyncShareProfile("p1", "   ", readOnly = false, grantValid = true),
            connectionAllowsWrite = true,
            serverAllowsWrite = true,
        )

        val mapping = (resolution as RdpDriveResolution.Mapped).mapping
        assertEquals(RdpDrivePolicy.DEFAULT_SHARE_NAME, mapping.shareName)
        assertEquals("PHONE", mapping.shareName)
        assertEquals("p1", mapping.profileId)
    }
}
