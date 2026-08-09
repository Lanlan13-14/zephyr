package one.zephyr.mobile.feature.remote

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.protocol.rdp.RdpConnectOutcome
import one.zephyr.mobile.protocol.rdp.RdpConnectRequest
import one.zephyr.mobile.protocol.rdp.RdpEngine
import one.zephyr.mobile.protocol.rdp.RdpFrame
import one.zephyr.mobile.protocol.rdp.RdpGeometry
import one.zephyr.mobile.protocol.rdp.RdpInputEvent
import one.zephyr.mobile.protocol.vnc.VncConnectOutcome
import one.zephyr.mobile.protocol.vnc.VncConnectRequest
import one.zephyr.mobile.protocol.vnc.VncEngine
import one.zephyr.mobile.protocol.vnc.VncFrame
import one.zephyr.mobile.protocol.vnc.VncInputEvent
import one.zephyr.mobile.protocol.vnc.VncSurfaceSize
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The protocol hand-off.
 *
 * These tests exist because the two protocols disagree about three specific things, and every
 * disagreement is a place where a plausible-looking adapter is silently wrong: the wheel (RDP counts
 * rotation in units of 120 with the opposite sign, RFB has no wheel at all and uses buttons 4..7),
 * resize (RDP cannot report what the server accepted, RFB can), and printable characters (RDP has no
 * scan code for one, RFB needs no table). A test that only checked "the event reached the engine"
 * would pass on all three while scrolling backwards, claiming a resize that never happened and
 * dropping every CJK keystroke.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RemoteProtocolAdapterTest {

    // ---- fakes ---------------------------------------------------------------------------------

    /** Records what reached the wire. Only the transport is faked; the mapping under test is real. */
    private class FakeRdpEngine(
        override val isAvailable: Boolean = true,
        private val frameList: List<RdpFrame> = emptyList(),
    ) : RdpEngine {
        val sent = ArrayList<RdpInputEvent>()
        val resizes = ArrayList<Pair<Int, Int>>()
        val clipboardOut = ArrayList<String>()
        var disconnected = 0

        override suspend fun connect(request: RdpConnectRequest): RdpConnectOutcome =
            RdpConnectOutcome.Failed(MobileError.local("unused", "connect is not under test"))

        override fun frames(sessionId: String): Flow<RdpFrame> =
            if (frameList.isEmpty()) emptyFlow() else flowOf(*frameList.toTypedArray())

        override suspend fun send(sessionId: String, event: RdpInputEvent) {
            sent += event
        }

        override suspend fun resize(sessionId: String, widthPx: Int, heightPx: Int) {
            resizes += widthPx to heightPx
        }

        override suspend fun sendClipboard(sessionId: String, text: String) {
            clipboardOut += text
        }

        override fun clipboard(sessionId: String): Flow<String> = flowOf("from-rdp")

        override suspend fun disconnect(sessionId: String) {
            disconnected++
        }
    }

    private class FakeVncEngine(
        override val isAvailable: Boolean = true,
        private val frameList: List<VncFrame> = emptyList(),
        private val resizeAnswer: VncSurfaceSize = VncSurfaceSize(0, 0, false),
    ) : VncEngine {
        val sent = ArrayList<VncInputEvent>()
        val resizes = ArrayList<Pair<Int, Int>>()
        val clipboardOut = ArrayList<String>()
        var disconnected = 0

        override suspend fun connect(request: VncConnectRequest): VncConnectOutcome =
            VncConnectOutcome.Failed(MobileError.local("unused", "connect is not under test"))

        override fun frames(sessionId: String): Flow<VncFrame> =
            if (frameList.isEmpty()) emptyFlow() else flowOf(*frameList.toTypedArray())

        override suspend fun send(sessionId: String, event: VncInputEvent) {
            sent += event
        }

        override suspend fun resize(sessionId: String, widthPx: Int, heightPx: Int): VncSurfaceSize {
            resizes += widthPx to heightPx
            return resizeAnswer
        }

        override suspend fun sendClipboard(sessionId: String, text: String) {
            clipboardOut += text
        }

        override fun clipboard(sessionId: String): Flow<String> = flowOf("from-vnc")

        override suspend fun disconnect(sessionId: String) {
            disconnected++
        }
    }

    private val session = "s1"

    // ---- availability ---------------------------------------------------------------------------

    @Test
    fun anUnavailableEngineIsReportedThroughTheAdapter() {
        /* The page renders 引擎不可用 from this flag. If the adapter hardcoded true, a build without
         * the native engine would show a black surface and a spinner instead of the reason. */
        assertFalse(RdpProtocolAdapter(FakeRdpEngine(isAvailable = false)).isAvailable)
        assertTrue(RdpProtocolAdapter(FakeRdpEngine(isAvailable = true)).isAvailable)
        assertFalse(VncProtocolAdapter(FakeVncEngine(isAvailable = false)).isAvailable)
        assertTrue(VncProtocolAdapter(FakeVncEngine(isAvailable = true)).isAvailable)
    }

    // ---- pointer --------------------------------------------------------------------------------

    @Test
    fun rdpPointerMoveCarriesTheHeldButtonMask() = runTest {
        val engine = FakeRdpEngine()
        RdpProtocolAdapter(engine).send(session, RemoteInput.PointerMove(10, 20, RemoteButton.PRIMARY))

        assertEquals(1, engine.sent.size)
        assertEquals(RdpInputEvent.Pointer(10, 20, RemoteButton.PRIMARY, 0), engine.sent[0])
    }

    @Test
    fun aButtonTransitionSendsTheResultingMaskNotTheChangedButton() = runTest {
        /* PointerButton carries both: the mask after the transition, and which button moved. RDP's
         * pointer PDU is a mask, so sending .button here would release every other held button on a
         * chord - a middle-drag would end the moment the user pressed primary. */
        val engine = FakeRdpEngine()
        val mask = RemoteButton.PRIMARY or RemoteButton.MIDDLE
        RdpProtocolAdapter(engine).send(
            session,
            RemoteInput.PointerButton(x = 3, y = 4, buttons = mask, button = RemoteButton.MIDDLE, down = true),
        )

        assertEquals(RdpInputEvent.Pointer(3, 4, mask, 0), engine.sent[0])
    }

    @Test
    fun vncPointerEventsAreTheMaskItself() = runTest {
        /* RFB has no press/release event: the mask *is* the event. Both neutral events therefore
         * collapse onto one RFB event, which is why the neutral mask uses RFB's bit order. */
        val engine = FakeVncEngine()
        val adapter = VncProtocolAdapter(engine)
        adapter.send(session, RemoteInput.PointerMove(10, 20, RemoteButton.NONE))
        adapter.send(
            session,
            RemoteInput.PointerButton(10, 20, RemoteButton.PRIMARY, RemoteButton.PRIMARY, true),
        )

        assertEquals(
            listOf(
                VncInputEvent.Pointer(10, 20, RemoteButton.NONE),
                VncInputEvent.Pointer(10, 20, RemoteButton.PRIMARY),
            ),
            engine.sent,
        )
    }

    // ---- wheel ----------------------------------------------------------------------------------

    @Test
    fun rdpWheelIsNegatedAndScaledToRotationUnits() = runTest {
        /* One notch is 120 units of rotation, and the sign is inverted: RDP counts positive when the
         * wheel turns away from the user, which scrolls content *up*, while a positive notch here
         * means toward the bottom. Getting this wrong scrolls backwards, which reads as a bug in the
         * remote application rather than in the adapter. */
        val engine = FakeRdpEngine()
        RdpProtocolAdapter(engine).send(session, RemoteInput.Wheel(5, 6, notches = 1))

        assertEquals(RdpInputEvent.Pointer(5, 6, RemoteButton.NONE, -120), engine.sent[0])
    }

    @Test
    fun rdpWheelSendsNoButtonsWithTheRotation() = runTest {
        val engine = FakeRdpEngine()
        RdpProtocolAdapter(engine).send(session, RemoteInput.Wheel(0, 0, notches = -3))

        val event = engine.sent[0] as RdpInputEvent.Pointer
        assertEquals(360, event.wheelDelta)
        assertEquals(RemoteButton.NONE, event.buttons)
    }

    @Test
    fun vncWheelBecomesOnePressReleasePairPerNotch() = runTest {
        /* RFB spends buttons 4..7 on the wheel and has no delta field, so three notches is three
         * press/release pairs. Sending one event with a count would scroll exactly one line. */
        val engine = FakeVncEngine()
        VncProtocolAdapter(engine).send(session, RemoteInput.Wheel(1, 2, notches = 3))

        assertEquals(6, engine.sent.size)
        for (index in 0 until 6 step 2) {
            assertEquals(VncInputEvent.Pointer(1, 2, 16), engine.sent[index])
            assertEquals(VncInputEvent.Pointer(1, 2, RemoteButton.NONE), engine.sent[index + 1])
        }
    }

    @Test
    fun vncWheelPicksTheButtonForEachDirection() = runTest {
        /* 8 up, 16 down, 32 left, 64 right - RFB buttons 4, 5, 6 and 7 as mask bits. */
        val cases = listOf(
            Triple(1, false, 16),
            Triple(-1, false, 8),
            Triple(1, true, 64),
            Triple(-1, true, 32),
        )
        for ((notches, horizontal, expected) in cases) {
            val engine = FakeVncEngine()
            VncProtocolAdapter(engine).send(session, RemoteInput.Wheel(0, 0, notches, horizontal))
            val first = engine.sent[0] as VncInputEvent.Pointer
            assertEquals("notches=" + notches + " horizontal=" + horizontal, expected, first.buttonMask)
        }
    }

    @Test
    fun aZeroNotchWheelIsNotExpandedIntoNothing() = runTest {
        /* The controller already refuses a zero-notch wheel, so this only proves the adapter does not
         * turn one into an infinite or negative repeat if a caller bypasses it. */
        val engine = FakeVncEngine()
        VncProtocolAdapter(engine).send(session, RemoteInput.Wheel(0, 0, notches = 0))

        assertTrue(engine.sent.isEmpty())
    }

    // ---- keyboard -------------------------------------------------------------------------------

    @Test
    fun aNamedKeyTravelsAsItsScanCodeWithTheExtendedFlag() = runTest {
        val engine = FakeRdpEngine()
        RdpProtocolAdapter(engine).send(session, RemoteInput.Key(RemoteKey.ArrowUp, down = true))

        assertEquals(RdpInputEvent.Key(0x48, true, true), engine.sent[0])
    }

    @Test
    fun aNonExtendedKeyKeepsTheFlagClear() = runTest {
        val engine = FakeRdpEngine()
        RdpProtocolAdapter(engine).send(session, RemoteInput.Key(RemoteKey.Enter, down = false))

        assertEquals(RdpInputEvent.Key(0x1C, false, false), engine.sent[0])
    }

    @Test
    fun aPrintableCharacterFallsBackToTheRdpUnicodeChannel() = runTest {
        /* RdpKeyMap deliberately returns null for a character: a scan code names a physical key and
         * the remote layout decides what it produces, so guessing one types the wrong glyph on a
         * non-US layout. The Unicode PDU is the correct channel and this is the fallback that uses it. */
        val engine = FakeRdpEngine()
        RdpProtocolAdapter(engine).send(session, RemoteInput.Key(RemoteKey.Character(0x4E2D), true))

        assertEquals(RdpInputEvent.Unicode(0x4E2D, true), engine.sent[0])
    }

    @Test
    fun aCharacterKeyIsNotDroppedOnTheWayToRdp() = runTest {
        /* The regression this guards: an early version returned from the when branch when scanCode
         * was null, which silently discarded every CJK and emoji keystroke. */
        val engine = FakeRdpEngine()
        val adapter = RdpProtocolAdapter(engine)
        adapter.send(session, RemoteInput.Key(RemoteKey.Character('a'.code), true))
        adapter.send(session, RemoteInput.Key(RemoteKey.Character('a'.code), false))

        assertEquals(2, engine.sent.size)
        assertEquals(RdpInputEvent.Unicode('a'.code, true), engine.sent[0])
        assertEquals(RdpInputEvent.Unicode('a'.code, false), engine.sent[1])
    }

    @Test
    fun vncSendsAKeysymForEveryKeyIncludingPrintableOnes() = runTest {
        /* The mirror of the RDP case: Latin-1 code points are their own keysyms, so VNC needs no
         * fallback and a character must not take one. */
        val engine = FakeVncEngine()
        val adapter = VncProtocolAdapter(engine)
        adapter.send(session, RemoteInput.Key(RemoteKey.Escape, true))
        adapter.send(session, RemoteInput.Key(RemoteKey.Character('A'.code), true))
        adapter.send(session, RemoteInput.Key(RemoteKey.Character(0x4E2D), true))

        assertEquals(
            listOf(
                VncInputEvent.Key(0xFF1B, true),
                VncInputEvent.Key(0x41, true),
                VncInputEvent.Key(0x0100_0000 + 0x4E2D, true),
            ),
            engine.sent,
        )
    }

    // ---- committed text -------------------------------------------------------------------------

    @Test
    fun rdpTextIsDecomposedIntoOneUnicodePairPerCodePoint() = runTest {
        val engine = FakeRdpEngine()
        RdpProtocolAdapter(engine).send(session, RemoteInput.Text("ab"))

        assertEquals(
            listOf(
                RdpInputEvent.Unicode('a'.code, true),
                RdpInputEvent.Unicode('a'.code, false),
                RdpInputEvent.Unicode('b'.code, true),
                RdpInputEvent.Unicode('b'.code, false),
            ),
            engine.sent,
        )
    }

    @Test
    fun anAstralCharacterIsOneCodePointNotTwoSurrogates() = runTest {
        /* Iterating by Char would send a surrogate pair as two invalid code points, which the remote
         * renders as two replacement glyphs. codePointAt plus charCount is what makes an emoji commit
         * arrive as one character. */
        val engine = FakeRdpEngine()
        RdpProtocolAdapter(engine).send(session, RemoteInput.Text(String(Character.toChars(0x1F600))))

        assertEquals(2, engine.sent.size)
        assertEquals(RdpInputEvent.Unicode(0x1F600, true), engine.sent[0])
        assertEquals(RdpInputEvent.Unicode(0x1F600, false), engine.sent[1])
    }

    @Test
    fun vncTextIsHandedOverWholeSoTheEngineCanSplitIt() = runTest {
        /* Split here it would become broken keysyms; the engine expands it per code point with the
         * pixel format and encoding context this layer does not have. */
        val engine = FakeVncEngine()
        VncProtocolAdapter(engine).send(session, RemoteInput.Text("中文"))

        assertEquals(listOf(VncInputEvent.Text("中文")), engine.sent)
    }

    @Test
    fun anEmptyTextCommitSendsNothing() = runTest {
        val rdp = FakeRdpEngine()
        RdpProtocolAdapter(rdp).send(session, RemoteInput.Text(""))
        assertTrue(rdp.sent.isEmpty())
    }

    // ---- sendAll --------------------------------------------------------------------------------

    @Test
    fun sendAllPreservesOrder() = runTest {
        /* Order is the whole contract of the input path: a release that overtakes its press leaves a
         * stuck button on the remote desktop. */
        val engine = FakeRdpEngine()
        RdpProtocolAdapter(engine).sendAll(
            session,
            listOf(
                RemoteInput.PointerMove(1, 1, RemoteButton.NONE),
                RemoteInput.PointerButton(1, 1, RemoteButton.PRIMARY, RemoteButton.PRIMARY, true),
                RemoteInput.PointerButton(1, 1, RemoteButton.NONE, RemoteButton.PRIMARY, false),
            ),
        )

        assertEquals(3, engine.sent.size)
        assertEquals(RdpInputEvent.Pointer(1, 1, RemoteButton.NONE, 0), engine.sent[0])
        assertEquals(RdpInputEvent.Pointer(1, 1, RemoteButton.PRIMARY, 0), engine.sent[1])
        assertEquals(RdpInputEvent.Pointer(1, 1, RemoteButton.NONE, 0), engine.sent[2])
    }

    // ---- frames ---------------------------------------------------------------------------------

    @Test
    fun rdpFramesBecomePatchesWithTheSameRegionAndPixels() = runTest {
        val pixels = ByteArray(4 * 4) { it.toByte() }
        val engine = FakeRdpEngine(frameList = listOf(RdpFrame(2, 3, 4, 1, pixels)))

        val patches = RdpProtocolAdapter(engine).frames(session).toList()

        assertEquals(1, patches.size)
        assertEquals(FrameRegion(2, 3, 4, 1), patches[0].region)
        assertArrayEquals(pixels, patches[0].pixels)
    }

    @Test
    fun vncFramesBecomePatchesWithTheSameRegionAndPixels() = runTest {
        val pixels = ByteArray(2 * 2 * 4) { 7 }
        val engine = FakeVncEngine(frameList = listOf(VncFrame(0, 0, 2, 2, pixels)))

        val patches = VncProtocolAdapter(engine).frames(session).toList()

        assertEquals(FrameRegion(0, 0, 2, 2), patches[0].region)
        assertArrayEquals(pixels, patches[0].pixels)
    }

    @Test
    fun anEngineWithNoFramesYieldsNoPatches() = runTest {
        assertTrue(RdpProtocolAdapter(FakeRdpEngine()).frames(session).toList().isEmpty())
        assertTrue(VncProtocolAdapter(FakeVncEngine()).frames(session).toList().isEmpty())
    }

    // ---- resize ---------------------------------------------------------------------------------

    @Test
    fun rdpResizeNormalizesBeforeItReachesTheEngine() = runTest {
        /* Odd widths break several RDP codecs and a tiny surface is refused outright, so the odd
         * number is rounded down and the minimum applied before the request leaves. */
        val engine = FakeRdpEngine()
        val size = RdpProtocolAdapter(engine).resize(session, 1081, 50)

        assertEquals(listOf(1080 to RdpGeometry.MIN_DIMENSION), engine.resizes)
        assertEquals(1080, size.widthPx)
        assertEquals(RdpGeometry.MIN_DIMENSION, size.heightPx)
    }

    @Test
    fun rdpResizeNeverClaimsTheServerAgreed() = runTest {
        /* RdpEngine.resize returns nothing, so there is no answer to report. Reporting true here
         * would tell the viewport to stop scaling, and a server that refused dynamic resolution would
         * then clip the desktop forever. The real size is observed from the next damage rectangle. */
        val size = RdpProtocolAdapter(FakeRdpEngine()).resize(session, 800, 600)

        assertFalse(size.serverResized)
    }

    @Test
    fun vncResizeReportsWhatTheServerActuallyDid() = runTest {
        val engine = FakeVncEngine(resizeAnswer = VncSurfaceSize(1024, 768, true))
        val size = VncProtocolAdapter(engine).resize(session, 800, 600)

        assertEquals(listOf(800 to 600), engine.resizes)
        assertEquals(1024, size.widthPx)
        assertEquals(768, size.heightPx)
        assertTrue(size.serverResized)
    }

    @Test
    fun aServerThatKeptItsOwnSizeIsReportedAsSuch() = runTest {
        /* The common case: most RFB servers have a fixed framebuffer, so the viewer scales. The page
         * shows 服务器保持原分辨率 from this flag rather than pretending the request worked. */
        val engine = FakeVncEngine(resizeAnswer = VncSurfaceSize(1920, 1080, false))
        val size = VncProtocolAdapter(engine).resize(session, 800, 600)

        assertFalse(size.serverResized)
        assertEquals(1920, size.widthPx)
    }

    // ---- clipboard and teardown -----------------------------------------------------------------

    @Test
    fun clipboardPassesThroughBothWaysOnBothProtocols() = runTest {
        val rdp = FakeRdpEngine()
        val rdpAdapter = RdpProtocolAdapter(rdp)
        rdpAdapter.sendClipboard(session, "to-remote")
        assertEquals(listOf("to-remote"), rdp.clipboardOut)
        assertEquals(listOf("from-rdp"), rdpAdapter.clipboard(session).toList())

        val vnc = FakeVncEngine()
        val vncAdapter = VncProtocolAdapter(vnc)
        vncAdapter.sendClipboard(session, "to-remote")
        assertEquals(listOf("to-remote"), vnc.clipboardOut)
        assertEquals(listOf("from-vnc"), vncAdapter.clipboard(session).toList())
    }

    @Test
    fun disconnectReachesTheEngineExactlyOnce() = runTest {
        val rdp = FakeRdpEngine()
        RdpProtocolAdapter(rdp).disconnect(session)
        assertEquals(1, rdp.disconnected)

        val vnc = FakeVncEngine()
        VncProtocolAdapter(vnc).disconnect(session)
        assertEquals(1, vnc.disconnected)
    }
}

