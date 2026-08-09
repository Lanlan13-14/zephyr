package one.zephyr.mobile.protocol.zft2

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import one.zephyr.mobile.contracts.Zft2Contract
import one.zephyr.mobile.contracts.Zft2Op
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Session-level behaviour against a fake socket.
 *
 * These are the rules that only appear in time and concurrency: what a CANCEL does to an operation
 * already running, what a full in-flight window replies, and when a silent peer is declared dead.
 * Virtual time makes the 15 s heartbeat assertable without a 45 s test.
 */
class Zft2SessionTest {

    private val identity = Zft2Identity(
        deviceId = "device-1",
        deviceName = "Pixel",
        platform = "android",
        appVersion = "1.0.0",
        credential = "lease-token",
    )

    private class Harness(
        val wire: FakeWire,
        val provider: FakeFileProvider,
        val dispatcher: Zft2Dispatcher,
        val session: Zft2Session,
    )

    private fun TestScope.harness(
        readOnly: Boolean = false,
        maxChunkBytes: Int = 1024,
        maxInflight: Int = 8,
    ): Harness {
        val wire = FakeWire()
        val provider = FakeFileProvider()
        val config = Zft2ProviderConfig(
            shareName = "PHONE",
            readOnly = readOnly,
            maxChunkBytes = maxChunkBytes,
            maxInflight = maxInflight,
        )
        val dispatcher = Zft2Dispatcher(provider, config)
        // backgroundScope, not the test scope: the heartbeat loops by design, and runTest would wait
        // forever for a child job that never completes.
        val session = Zft2Session(wire, dispatcher, config, identity, backgroundScope) { 1_700_000_000_000L }
        return Harness(wire, provider, dispatcher, session)
    }

    private suspend fun Harness.online() {
        session.start()
        session.onText(helloAck(ok = true))
    }

    // ---- handshake -------------------------------------------------------------------------------

    /**
     * Capabilities are derived from the effective config, so the advertised share and the enforced
     * jail cannot drift apart. DEVELOPMENT.md 13.2 already narrowed readOnly to the strictest of
     * profile, connection and server before it reaches here.
     */
    @Test
    fun helloAdvertisesTheEffectiveShareAndNegotiatedLimits() = runTest {
        val harness = harness(readOnly = true, maxChunkBytes = 256 * 1024, maxInflight = 99)
        harness.session.start()

        val hello = harness.wire.lastJson()
        assertEquals("hello", hello["type"]!!.jsonPrimitive.content)
        assertEquals(Zft2Contract.VERSION, hello["protocolVersion"]!!.jsonPrimitive.int)
        assertEquals("lease-token", hello["token"]!!.jsonPrimitive.content)
        assertEquals("device-1", hello["deviceId"]!!.jsonPrimitive.content)

        val capabilities = hello["capabilities"]!!.jsonObject
        assertTrue(capabilities["read"]!!.jsonPrimitive.boolean)
        assertFalse("a read-only share must not advertise write", capabilities["write"]!!.jsonPrimitive.boolean)
        assertFalse(capabilities["delete"]!!.jsonPrimitive.boolean)
        assertFalse(capabilities["mkdir"]!!.jsonPrimitive.boolean)
        assertTrue(capabilities["cancel"]!!.jsonPrimitive.boolean)
        // Clamped to the frozen 1..16 window rather than forwarded raw.
        assertEquals(Zft2Contract.MAX_INFLIGHT_MAX, capabilities["maxInflight"]!!.jsonPrimitive.int)
        assertEquals(256 * 1024, capabilities["maxChunkSize"]!!.jsonPrimitive.int)

        val share = hello["share"]!!.jsonObject
        assertEquals("PHONE", share["name"]!!.jsonPrimitive.content)
        assertTrue(share["readOnly"]!!.jsonPrimitive.boolean)
        assertEquals(Zft2SessionState.AUTHENTICATING, harness.session.state.value)
    }

    @Test
    fun helloAckPromotesToOnlineAndRecordsTheAgentId() = runTest {
        val harness = harness()
        harness.online()
        assertEquals(Zft2SessionState.ONLINE, harness.session.state.value)
        assertEquals("agent_abc", harness.session.agentId)
    }

    /**
     * A rejected credential must not be retried on a timer: DEVELOPMENT.md 13.5 wants the binding
     * state and the lease re-verified first, and a tight reconnect loop against a revoked token is
     * how a device gets rate-limited.
     */
    @Test
    fun rejectedHelloAckFailsWithoutRetrying() = runTest {
        val harness = harness()
        harness.session.start()
        harness.session.onText(helloAck(ok = false))
        assertEquals(Zft2SessionState.FAILED, harness.session.state.value)
        assertEquals(Zft2StopReason.AUTH_REJECTED, harness.session.stopReason)
        assertEquals("unauthorized", harness.session.lastError.value)
        assertNull(harness.session.agentId)
    }

    // ---- binary request path ---------------------------------------------------------------------

    @Test
    fun aPingFrameIsAnswered() = runTest {
        val harness = harness()
        harness.online()
        harness.session.onBinary(Zft2Codec.encode(op = Zft2Op.PING.code, requestId = 1L))
        runCurrent()

        val response = harness.wire.lastFrame()
        assertTrue(response.isResponse)
        assertFalse(response.isError)
        assertEquals(1L, response.requestId)
    }

    /** This side only ever answers, so a stray response frame is dropped rather than dispatched. */
    @Test
    fun responseFramesAreIgnored() = runTest {
        val harness = harness()
        harness.online()
        val before = harness.wire.binary.size
        harness.session.onBinary(
            Zft2Codec.encode(op = Zft2Op.READ.code, requestId = 1L, flags = Zft2Contract.FLAG_RESPONSE),
        )
        runCurrent()
        assertEquals(before, harness.wire.binary.size)
        assertTrue(harness.provider.calls.isEmpty())
    }

    @Test
    fun aReadOnlyShareAnswersWritesWithAnErrorFrameAndStaysOnline() = runTest {
        val harness = harness(readOnly = true)
        harness.online()
        harness.session.onBinary(
            Zft2Codec.encode(
                op = Zft2Op.WRITE.code,
                requestId = 4L,
                meta = metaOf("handle" to "h1"),
                payload = ByteArray(8),
            ),
        )
        runCurrent()

        val response = harness.wire.lastFrame()
        assertTrue(response.isError)
        assertEquals("read_only", response.meta["code"]!!.jsonPrimitive.content)
        assertEquals(4L, response.requestId)
        assertEquals(Zft2SessionState.ONLINE, harness.session.state.value)
        assertFalse(harness.provider.didWrite())
    }

    /**
     * Back-pressure, not failure: the main end's callBinaryV2 polls for a free slot every 4 ms, so a
     * busy reply makes it wait instead of failing a large-file copy.
     */
    @Test
    fun aFullInflightWindowRepliesBusy() = runTest {
        val harness = harness(maxInflight = 1)
        harness.online()
        harness.provider.readGate = CompletableDeferred()

        harness.session.onBinary(Zft2Codec.encode(op = Zft2Op.READ.code, requestId = 1L, meta = metaOf("handle" to "h1")))
        runCurrent()
        harness.session.onBinary(Zft2Codec.encode(op = Zft2Op.READ.code, requestId = 2L, meta = metaOf("handle" to "h1")))
        runCurrent()

        val busy = harness.wire.lastFrame()
        assertTrue(busy.isError)
        assertEquals("busy", busy.meta["code"]!!.jsonPrimitive.content)
        assertEquals(2L, busy.requestId)

        harness.provider.readGate!!.complete(Unit)
        runCurrent()
        // The first read still completes normally once the window frees up.
        assertTrue(harness.wire.frames().any { it.requestId == 1L && it.isResponse && !it.isError })
    }

    /** A read changes nothing, so a CANCEL interrupts it for real. */
    @Test
    fun cancelInterruptsAReadAndSuppressesItsResponse() = runTest {
        val harness = harness()
        harness.online()
        harness.provider.readGate = CompletableDeferred()

        harness.session.onBinary(Zft2Codec.encode(op = Zft2Op.READ.code, requestId = 7L, meta = metaOf("handle" to "h1")))
        runCurrent()
        harness.session.onBinary(
            Zft2Codec.encode(op = Zft2Op.CANCEL.code, requestId = 8L, meta = metaOf("targetRequestId" to 7)),
        )
        runCurrent()
        harness.provider.readGate!!.complete(Unit)
        runCurrent()

        assertTrue("no reply may be sent for a cancelled request", harness.wire.frames().none { it.requestId == 7L })
        assertEquals(Zft2SessionState.ONLINE, harness.session.state.value)
    }

    /**
     * A write is allowed to finish. Interrupting one mid-flush would leave a half-written file that
     * neither side can reason about, and the peer has stopped waiting either way.
     */
    @Test
    fun cancelLetsAWriteFinishButSuppressesItsResponse() = runTest {
        val harness = harness()
        harness.online()
        harness.provider.writeGate = CompletableDeferred()

        harness.session.onBinary(
            Zft2Codec.encode(
                op = Zft2Op.WRITE.code,
                requestId = 9L,
                meta = metaOf("handle" to "h1"),
                payload = ByteArray(16),
            ),
        )
        runCurrent()
        harness.session.onBinary(
            Zft2Codec.encode(op = Zft2Op.CANCEL.code, requestId = 10L, meta = metaOf("targetRequestId" to 9)),
        )
        runCurrent()
        harness.provider.writeGate!!.complete(Unit)
        runCurrent()

        assertTrue("the write must still reach the platform", harness.provider.didWrite())
        assertTrue("but its reply must be suppressed", harness.wire.frames().none { it.requestId == 9L })
    }

    @Test
    fun cancelForAnUnknownRequestIsIgnored() = runTest {
        val harness = harness()
        harness.online()
        val before = harness.wire.binary.size
        harness.session.onBinary(
            Zft2Codec.encode(op = Zft2Op.CANCEL.code, requestId = 1L, meta = metaOf("targetRequestId" to 4242)),
        )
        runCurrent()
        assertEquals(before, harness.wire.binary.size)
        assertEquals(Zft2SessionState.ONLINE, harness.session.state.value)
    }

    /**
     * An over-large write is a refusal, not a protocol violation: the frame decoded cleanly, so
     * there is a requestId to answer and the session must survive.
     */
    @Test
    fun anOversizedWriteIsRefusedWithoutKillingTheSession() = runTest {
        val harness = harness(maxChunkBytes = 1024)
        harness.online()
        harness.session.onBinary(
            Zft2Codec.encode(
                op = Zft2Op.WRITE.code,
                requestId = 3L,
                meta = metaOf("handle" to "h1"),
                payload = ByteArray(4096),
            ),
        )
        runCurrent()

        val response = harness.wire.lastFrame()
        assertTrue(response.isError)
        assertEquals("payload_too_large", response.meta["code"]!!.jsonPrimitive.content)
        assertEquals(Zft2SessionState.ONLINE, harness.session.state.value)
        assertFalse(harness.provider.didWrite())
    }

    /**
     * A frame that fails to decode has no trustworthy requestId, so there is nobody to answer and
     * stream alignment is gone. Scanning forward for the next magic would let a peer choose the next
     * frame boundary, so the session ends instead.
     */
    @Test
    fun aStructurallyInvalidFrameEndsTheSession() = runTest {
        val harness = harness()
        harness.online()
        // metaLen claims 0x40 bytes that are not present.
        harness.session.onBinary(Zft2Fixtures.unhex("5a465432020c0000000000010000004000000000"))
        runCurrent()

        assertEquals(Zft2SessionState.FAILED, harness.session.state.value)
        assertEquals(Zft2StopReason.PROTOCOL_VIOLATION, harness.session.stopReason)
        assertEquals("length_mismatch", harness.session.lastError.value)
    }

    @Test
    fun nonZft2BinaryIsDroppedWithoutEndingTheSession() = runTest {
        val harness = harness()
        harness.online()
        harness.session.onBinary(byteArrayOf(1, 2, 3, 4, 5))
        runCurrent()
        assertEquals(Zft2SessionState.ONLINE, harness.session.state.value)
    }

    /** Counts real file bytes, so the UI figure is not inflated by frame metadata. */
    @Test
    fun transferredBytesCountsOnlyFileBytes() = runTest {
        val harness = harness()
        harness.online()
        harness.provider.readBytes = ByteArray(300)

        harness.session.onBinary(Zft2Codec.encode(op = Zft2Op.READ.code, requestId = 1L, meta = metaOf("handle" to "h1")))
        runCurrent()
        assertEquals(300L, harness.session.transferredBytes.value)

        harness.session.onBinary(
            Zft2Codec.encode(
                op = Zft2Op.WRITE.code,
                requestId = 2L,
                meta = metaOf("handle" to "h1"),
                payload = ByteArray(50),
            ),
        )
        runCurrent()
        assertEquals(350L, harness.session.transferredBytes.value)
    }

    // ---- JSON-RPC path ---------------------------------------------------------------------------

    /** ai-agent-device-tools.js still drives these over text frames against a protocol-v2 agent. */
    @Test
    fun aJsonRpcListIsAnsweredAsText() = runTest {
        val harness = harness()
        harness.online()
        harness.session.onText(rpcRequest("rpc_1", "list", metaOf("path" to "/docs")))
        runCurrent()

        val reply = harness.wire.lastJson()
        assertEquals("rpc_1", reply["id"]!!.jsonPrimitive.content)
        assertEquals("response", reply["type"]!!.jsonPrimitive.content)
        assertTrue(reply["ok"]!!.jsonPrimitive.boolean)
        assertEquals(1, reply["result"]!!.jsonObject["entries"]!!.jsonArray.size)
    }

    @Test
    fun aFailedJsonRpcCallReportsItsCode() = runTest {
        val harness = harness()
        harness.online()
        harness.session.onText(rpcRequest("rpc_2", "chmod", metaOf("path" to "/a")))
        runCurrent()

        val reply = harness.wire.lastJson()
        assertFalse(reply["ok"]!!.jsonPrimitive.boolean)
        assertEquals("unsupported", reply["error"]!!.jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun aJsonRpcMutatingMethodIsRefusedOnAReadOnlyShare() = runTest {
        val harness = harness(readOnly = true)
        harness.online()
        harness.session.onText(rpcRequest("rpc_3", "mkdir", metaOf("path" to "/a")))
        runCurrent()

        val reply = harness.wire.lastJson()
        assertFalse(reply["ok"]!!.jsonPrimitive.boolean)
        assertEquals("read_only", reply["error"]!!.jsonObject["code"]!!.jsonPrimitive.content)
        assertTrue(harness.provider.calls.isEmpty())
    }

    /** readBinary answers with a ZFB1 binary envelope: base64 in JSON would inflate it by a third. */
    @Test
    fun readBinaryRpcIsAnsweredWithAZfb1Frame() = runTest {
        val harness = harness()
        harness.online()
        harness.provider.readBytes = "payload".toByteArray(Charsets.UTF_8)
        harness.session.onText(rpcRequest("rpc_4", "readBinary", metaOf("handle" to "h1", "offset" to 0, "length" to 7)))
        runCurrent()

        val sent = harness.wire.binary.last()
        assertEquals(0x5A.toByte(), sent[0])
        assertEquals(0x46.toByte(), sent[1])
        assertEquals(0x42.toByte(), sent[2])
        assertEquals(0x31.toByte(), sent[3])
        val idLength = ((sent[4].toInt() and 0xFF) shl 8) or (sent[5].toInt() and 0xFF)
        assertEquals("rpc_4", String(sent, 6, idLength, Charsets.UTF_8))
        assertEquals("payload", String(sent, 6 + idLength, sent.size - 6 - idLength, Charsets.UTF_8))
        assertEquals(7L, harness.session.transferredBytes.value)
    }

    @Test
    fun anUnknownTextMessageTypeIsIgnored() = runTest {
        val harness = harness()
        harness.online()
        val before = harness.wire.text.size
        harness.session.onText("{\"type\":\"something_new\",\"value\":1}")
        harness.session.onText("not json at all")
        runCurrent()
        assertEquals(before, harness.wire.text.size)
        assertEquals(Zft2SessionState.ONLINE, harness.session.state.value)
    }

    // ---- heartbeat -------------------------------------------------------------------------------

    /**
     * The provider drives the heartbeat; the main end increments a miss counter on its own timer and
     * unregisters the agent after three misses, so a silent provider looks offline even though the
     * socket is fine.
     */
    @Test
    fun theProviderPingsOnTheServerChosenInterval() = runTest {
        val harness = harness()
        harness.online()
        advanceTimeBy(15_001)
        runCurrent()

        val ping = harness.wire.lastJson()
        assertEquals("ping", ping["type"]!!.jsonPrimitive.content)
        assertEquals(Zft2SessionState.ONLINE, harness.session.state.value)
    }

    @Test
    fun threeMissedHeartbeatsEndTheSession() = runTest {
        val harness = harness()
        harness.online()
        advanceTimeBy(45_001)
        runCurrent()

        assertEquals(Zft2SessionState.FAILED, harness.session.state.value)
        assertEquals(Zft2StopReason.HEARTBEAT_TIMEOUT, harness.session.stopReason)
        // Handles are released when the peer goes quiet, not only on a clean stop.
        assertEquals(1, harness.provider.closeAllCount)
    }

    @Test
    fun aPongResetsTheMissCounter() = runTest {
        val harness = harness()
        harness.online()
        advanceTimeBy(15_001)
        runCurrent()
        harness.session.onText("{\"type\":\"pong\",\"time\":1}")

        // Without the reset this would be the third miss and the session would be dead.
        advanceTimeBy(30_000)
        runCurrent()
        assertEquals(Zft2SessionState.ONLINE, harness.session.state.value)
    }

    // ---- teardown --------------------------------------------------------------------------------

    /** DEVELOPMENT.md 13.4: disconnect closes every handle, because they are local descriptors. */
    @Test
    fun stopReleasesHandlesTellsThePeerAndClosesTheSocket() = runTest {
        val harness = harness()
        harness.online()
        harness.session.onBinary(Zft2Codec.encode(op = Zft2Op.OPEN.code, requestId = 1L, meta = metaOf("path" to "/a.txt")))
        runCurrent()

        harness.session.stop()
        runCurrent()

        assertEquals(Zft2SessionState.OFFLINE, harness.session.state.value)
        assertEquals(Zft2StopReason.LOCAL_STOP, harness.session.stopReason)
        assertEquals(1, harness.provider.closeAllCount)
        assertEquals(0, harness.dispatcher.openHandleCount)
        assertEquals(Zft2Session.NORMAL_CLOSURE, harness.wire.closed!!.first)
        // The peer is told, so it drops the agent immediately instead of waiting three misses.
        assertTrue(harness.wire.jsonMessages().any { it["type"]!!.jsonPrimitive.content == "auto_shutdown" })
    }

    @Test
    fun aDroppedSocketStillReleasesHandles() = runTest {
        val harness = harness()
        harness.online()
        harness.session.onBinary(Zft2Codec.encode(op = Zft2Op.OPEN.code, requestId = 1L, meta = metaOf("path" to "/a.txt")))
        runCurrent()

        harness.session.onTransportClosed("network lost")
        runCurrent()

        assertEquals(Zft2SessionState.OFFLINE, harness.session.state.value)
        assertEquals(Zft2StopReason.TRANSPORT_CLOSED, harness.session.stopReason)
        assertEquals(1, harness.provider.closeAllCount)
        assertEquals("network lost", harness.session.lastError.value)
    }

    @Test
    fun stopCancelsInflightWork() = runTest {
        val harness = harness()
        harness.online()
        harness.provider.readGate = CompletableDeferred()
        harness.session.onBinary(Zft2Codec.encode(op = Zft2Op.READ.code, requestId = 1L, meta = metaOf("handle" to "h1")))
        runCurrent()

        harness.session.stop()
        harness.provider.readGate!!.complete(Unit)
        runCurrent()

        assertTrue(harness.wire.frames().none { it.requestId == 1L && it.isResponse })
    }
}
