package one.zephyr.mobile.feature.remote

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.runTest
import one.zephyr.mobile.model.RdpQuality
import one.zephyr.mobile.model.RdpResolution
import one.zephyr.mobile.protocol.rdp.RdpDisplayPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RdpOperationPageTest {

    private val adapter = object : RemoteProtocolAdapter {
        override val isAvailable: Boolean = true
        override suspend fun send(sessionId: String, input: RemoteInput) = Unit
        override fun frames(sessionId: String): Flow<FramePatch> = emptyFlow()
        override suspend fun resize(sessionId: String, widthPx: Int, heightPx: Int) =
            RemoteSurfaceSize(widthPx, heightPx, serverResized = true)
        override suspend fun sendClipboard(sessionId: String, text: String) = Unit
        override fun clipboard(sessionId: String): Flow<String> = emptyFlow()
        override suspend fun disconnect(sessionId: String) = Unit
    }

    @Test
    fun cycleZoomWalksTheDemoFactorsThenReturnsToFit() = runTest {
        val subject = RemoteSessionController("s1", adapter, backgroundScope)
        subject.onRemoteSize(1_000, 1_000)
        subject.onViewportMeasured(500f, 500f)
        val fit = subject.state.value.transform.scale

        val first = subject.cycleZoom(RdpDisplayPolicy.ZOOM_FACTORS)
        assertEquals(1.25f, first)
        assertEquals(RemoteViewportMode.CUSTOM, subject.state.value.mode)
        assertEquals(1, subject.state.value.zoomIndex)

        subject.cycleZoom(RdpDisplayPolicy.ZOOM_FACTORS)
        subject.cycleZoom(RdpDisplayPolicy.ZOOM_FACTORS)
        val last = subject.cycleZoom(RdpDisplayPolicy.ZOOM_FACTORS)
        assertEquals(1f, last)
        assertEquals(0, subject.state.value.zoomIndex)
        assertEquals(RemoteViewportMode.FIT, subject.state.value.mode)
        assertEquals(fit, subject.state.value.transform.scale, 0.001f)
    }

    @Test
    fun fitToWindowResetsACustomZoom() = runTest {
        val subject = RemoteSessionController("s1", adapter, backgroundScope)
        subject.onRemoteSize(1_000, 1_000)
        subject.onViewportMeasured(400f, 400f)
        subject.cycleZoom(RdpDisplayPolicy.ZOOM_FACTORS)
        subject.fitToWindow()
        assertEquals(0, subject.state.value.zoomIndex)
        assertEquals(RemoteViewportMode.FIT, subject.state.value.mode)
    }

    @Test
    fun joystickModePansInsteadOfDrivingThePointer() = runTest {
        val subject = RemoteSessionController("s1", adapter, backgroundScope)
        subject.onRemoteSize(1_000, 1_000)
        subject.onViewportMeasured(400f, 400f)
        subject.onPinch(2f, 200f, 200f)
        val cursor = subject.state.value.pointer.cursor
        val offset = subject.state.value.transform.offsetXPx

        assertEquals(RemoteDragMode.VIEWPORT, subject.toggleDragMode())
        subject.onPan(20f, 0f)
        assertEquals(cursor, subject.state.value.pointer.cursor)
        assertTrue(subject.state.value.transform.offsetXPx > offset || subject.state.value.transform.offsetXPx != offset)
        assertEquals(RemoteDragMode.POINTER, subject.toggleDragMode())
    }

    @Test
    fun displayLabelsMatchTheDemoCopy() {
        val content = RemoteContent(
            connection = RemoteFixtures.connection(),
            surface = RemoteSurfaceState(zoomIndex = 1),
            status = RemoteSessionStatus(),
            transport = one.zephyr.mobile.data.session.SessionTransport.CONNECTED,
            dock = RemoteDockItem.forProtocol(one.zephyr.mobile.model.Protocol.RDP),
            engineAvailable = true,
            viewOnly = false,
            executionDisclosure = null,
            securityWarning = null,
            certificatePrompt = null,
            authPrompt = null,
            clipboardPrompt = null,
            quality = RdpQuality.BALANCED,
            resolution = RdpResolution.AUTO,
            fpsChoice = one.zephyr.mobile.model.RdpFps.F30,
        )
        assertEquals("平衡", content.qualityLabel)
        assertEquals("自动", content.resolutionLabel)
        assertEquals("30FPS", content.fpsLabel)
        assertEquals("125%", content.zoomLabel)
        assertFalse(content.dock.contains(RemoteDockItem.VNC_QUALITY))
    }
}
