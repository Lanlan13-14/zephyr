package one.zephyr.mobile.feature.remote

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class RemoteSessionControllerPerformanceTest {

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
    fun aFrameBurstHasOnePendingRenderWakeAndKeepsEveryPatchInTheMailbox() = runTest {
        val subject = RemoteSessionController("s1", adapter, backgroundScope)
        subject.onRemoteSize(100, 100)
        subject.frameRequests.first()
        val stateBeforeFrames = subject.state.value

        repeat(10) { x -> subject.onFrame(RemoteFixtures.patch(x = x, width = 1, height = 1)) }

        subject.frameRequests.first()
        assertNull(withTimeoutOrNull(1) { subject.frameRequests.first() })
        assertSame(stateBeforeFrames, subject.state.value)
        assertEquals(10, subject.drainFrames().patches.size)
    }

    @Test
    fun panUpdatesTheRendererStateWithoutInvalidatingPageContentState() = runTest {
        val subject = RemoteSessionController("s1", adapter, backgroundScope)
        subject.onRemoteSize(1_000, 1_000)
        subject.onViewportMeasured(500f, 250f)
        subject.onPinch(factor = 2f, focusXPx = 250f, focusYPx = 125f)
        val contentBeforePan = subject.contentState.value
        val transformBeforePan = subject.state.value.transform

        subject.onPan(dxPx = 20f, dyPx = 10f)

        assertSame(contentBeforePan, subject.contentState.value)
        assertNotEquals(transformBeforePan, subject.state.value.transform)
    }
}
