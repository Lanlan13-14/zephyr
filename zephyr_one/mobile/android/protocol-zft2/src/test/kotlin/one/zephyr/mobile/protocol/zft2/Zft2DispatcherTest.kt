package one.zephyr.mobile.protocol.zft2

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import one.zephyr.mobile.contracts.Zft2Op
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Provider-layer rules that no compiler can enforce.
 *
 * The read-only jail and the resource ceilings are the security-relevant half of ZFT2: a peer that
 * ignores the advertised capabilities must still be refused, and a hostile peer must not be able to
 * exhaust handles or memory. Those are behaviours, so they are asserted here rather than reviewed.
 */
class Zft2DispatcherTest {

    private fun dispatcher(
        provider: FakeFileProvider = FakeFileProvider(),
        readOnly: Boolean = false,
        maxChunkBytes: Int = 1024,
        maxOpenHandles: Int = 64,
        maxListEntries: Int = 2000,
    ): Zft2Dispatcher = Zft2Dispatcher(
        provider,
        Zft2ProviderConfig(
            shareName = "PHONE",
            readOnly = readOnly,
            maxChunkBytes = maxChunkBytes,
            maxOpenHandles = maxOpenHandles,
            maxListEntries = maxListEntries,
        ),
    )

    private suspend fun respond(subject: Zft2Dispatcher, frame: Zft2Frame): Zft2Frame =
        Zft2Codec.decode(subject.dispatch(frame))

    private inline fun expectCode(expected: String, block: () -> Unit) {
        try {
            block()
            fail("expected " + expected)
        } catch (failure: Zft2Exception) {
            assertEquals(expected, failure.code)
        }
    }

    // ---- read-only jail --------------------------------------------------------------------------

    /**
     * The jail is enforced here, not in the UI and not only via hello capabilities, because
     * DEVELOPMENT.md 13.2 takes the strictest of profile, connection and server, and a peer is free
     * to ignore what we advertised.
     */
    @Test
    fun readOnlyShareRefusesEveryWriteOpAndNeverReachesThePlatform() = runTest {
        val provider = FakeFileProvider()
        val subject = dispatcher(provider, readOnly = true)

        expectCode("read_only") { subject.dispatch(requestFrame(Zft2Op.WRITE, 1L, metaOf("handle" to "h1"))) }
        expectCode("read_only") { subject.dispatch(requestFrame(Zft2Op.MKDIR, 2L, metaOf("path" to "/d"))) }
        expectCode("read_only") { subject.dispatch(requestFrame(Zft2Op.DELETE, 3L, metaOf("path" to "/f"))) }
        expectCode("read_only") {
            subject.dispatch(requestFrame(Zft2Op.RENAME, 4L, metaOf("oldPath" to "/a", "newPath" to "/b")))
        }
        expectCode("read_only") { subject.dispatch(requestFrame(Zft2Op.TRUNCATE, 5L, metaOf("path" to "/f", "size" to 0))) }

        assertTrue("no mutating call may reach the provider", provider.calls.isEmpty())
    }

    /** A read-mode open is still allowed on a read-only share; a write-mode open is not. */
    @Test
    fun readOnlyShareAllowsReadOpenButRefusesWriteOpen() = runTest {
        val provider = FakeFileProvider()
        val subject = dispatcher(provider, readOnly = true)

        val opened = respond(subject, requestFrame(Zft2Op.OPEN, 1L, metaOf("path" to "/a.txt", "mode" to "read")))
        assertEquals("h1", opened.meta["handle"]!!.jsonPrimitive.content)

        expectCode("read_only") {
            subject.dispatch(requestFrame(Zft2Op.OPEN, 2L, metaOf("path" to "/a.txt", "mode" to "write")))
        }
    }

    @Test
    fun writableShareLetsMutatingOpsThrough() = runTest {
        val provider = FakeFileProvider()
        val subject = dispatcher(provider)
        respond(subject, requestFrame(Zft2Op.MKDIR, 1L, metaOf("path" to "/new/dir")))
        respond(subject, requestFrame(Zft2Op.DELETE, 2L, metaOf("path" to "/gone", "recursive" to true)))
        assertEquals(listOf("mkdir:/new/dir", "delete:/gone:true"), provider.calls)
    }

    // ---- serialisation keys ----------------------------------------------------------------------

    /**
     * Two spellings of one path must share a queue key, or the session would run them concurrently
     * and DEVELOPMENT.md 13.3's serialisation requirement would be silently defeated.
     */
    @Test
    fun queueKeyIsNormalisedSoPathSpellingsCannotRace() {
        val subject = dispatcher()
        val canonical = subject.queueKey(requestFrame(Zft2Op.MKDIR, 1L, metaOf("path" to "/a/b")))
        val sloppy = subject.queueKey(requestFrame(Zft2Op.MKDIR, 2L, metaOf("path" to "a/b/")))
        assertEquals("/a/b", canonical)
        assertEquals(canonical, sloppy)
    }

    @Test
    fun concurrencySafeOpsHaveNoQueueKey() {
        val subject = dispatcher()
        assertNull(subject.queueKey(requestFrame(Zft2Op.READ, 1L, metaOf("handle" to "h1"))))
        assertNull(subject.queueKey(requestFrame(Zft2Op.STAT, 2L, metaOf("path" to "/a"))))
        assertNull(subject.queueKey(requestFrame(Zft2Op.LIST, 3L, metaOf("path" to "/a"))))
        assertNull(subject.queueKey(requestFrame(Zft2Op.PING, 4L)))
    }

    /** WRITE and CLOSE queue on the opened path so they serialise against OPEN and TRUNCATE. */
    @Test
    fun writeAndCloseQueueOnTheOpenedPath() = runTest {
        val subject = dispatcher()
        val opened = respond(subject, requestFrame(Zft2Op.OPEN, 1L, metaOf("path" to "/data/report.txt", "mode" to "write")))
        val handle = opened.meta["handle"]!!.jsonPrimitive.content

        assertEquals("/data/report.txt", subject.queueKey(requestFrame(Zft2Op.WRITE, 2L, metaOf("handle" to handle))))
        assertEquals("/data/report.txt", subject.queueKey(requestFrame(Zft2Op.CLOSE, 3L, metaOf("handle" to handle))))
        // An unknown handle still gets a stable key so two frames on it cannot interleave.
        assertEquals("handle:zzz", subject.queueKey(requestFrame(Zft2Op.WRITE, 4L, metaOf("handle" to "zzz"))))
    }

    /** Queued on the source: the destination does not exist until the move completes. */
    @Test
    fun renameQueuesOnTheSourcePath() {
        val subject = dispatcher()
        assertEquals(
            "/a/old.txt",
            subject.queueKey(requestFrame(Zft2Op.RENAME, 1L, metaOf("oldPath" to "/a/old.txt", "newPath" to "/a/new.txt"))),
        )
    }

    // ---- transfer ops ----------------------------------------------------------------------------

    /**
     * A short read is legal in RDPDR and the remote re-requests the remainder, so clamping an
     * over-large request is safer than refusing it: it keeps a peer that ignored hello.maxChunkSize
     * working instead of failing the copy.
     */
    @Test
    fun readClampsToTheNegotiatedChunkAndReportsEof() = runTest {
        val provider = FakeFileProvider()
        provider.readBytes = ByteArray(4096) { 7 }
        val subject = dispatcher(provider, maxChunkBytes = 1024)

        val response = respond(subject, requestFrame(Zft2Op.READ, 1L, metaOf("handle" to "h1", "offset" to 0, "length" to 999_999)))
        assertEquals(1024, response.payload.size)
        assertEquals(1024, response.meta["bytesRead"]!!.jsonPrimitive.int)
        assertFalse(response.meta["eof"]!!.jsonPrimitive.boolean)
        assertEquals(listOf("read:h1:0:1024"), provider.calls)
    }

    @Test
    fun anEmptyReadIsReportedAsEof() = runTest {
        val provider = FakeFileProvider()
        provider.readBytes = ByteArray(0)
        val response = respond(dispatcher(provider), requestFrame(Zft2Op.READ, 1L, metaOf("handle" to "h1")))
        assertEquals(0, response.meta["bytesRead"]!!.jsonPrimitive.int)
        assertTrue(response.meta["eof"]!!.jsonPrimitive.boolean)
        assertEquals(0, response.payload.size)
    }

    /** Android SAF crosses a Binder transaction, so an over-large write is refused, not clamped. */
    @Test
    fun writeRefusesAChunkAboveTheNegotiatedCeiling() = runTest {
        val provider = FakeFileProvider()
        val subject = dispatcher(provider, maxChunkBytes = 1024)
        expectCode("payload_too_large") {
            subject.dispatch(requestFrame(Zft2Op.WRITE, 1L, metaOf("handle" to "h1"), ByteArray(2048)))
        }
        assertFalse(provider.didWrite())
    }

    @Test
    fun writeReportsBytesWritten() = runTest {
        val response = respond(
            dispatcher(),
            requestFrame(Zft2Op.WRITE, 1L, metaOf("handle" to "h1", "offset" to 64), ByteArray(512)),
        )
        assertEquals(512, response.meta["bytesWritten"]!!.jsonPrimitive.int)
    }

    /** A failed close must still drop the handle, or its queue key would block that path forever. */
    @Test
    fun closeForgetsTheHandleEvenWhenThePlatformFails() = runTest {
        val provider = FakeFileProvider()
        val subject = dispatcher(provider)
        val handle = respond(subject, requestFrame(Zft2Op.OPEN, 1L, metaOf("path" to "/a.txt")))
            .meta["handle"]!!.jsonPrimitive.content
        assertEquals(1, subject.openHandleCount)

        respond(subject, requestFrame(Zft2Op.CLOSE, 2L, metaOf("handle" to handle)))
        assertEquals(0, subject.openHandleCount)
    }

    @Test
    fun pingIsAnsweredLocallyWithAnAgentTimestamp() = runTest {
        val response = respond(dispatcher(), requestFrame(Zft2Op.PING, 1L))
        assertTrue(response.meta["agentTime"]!!.jsonPrimitive.long > 0L)
    }

    // ---- resource ceilings -----------------------------------------------------------------------

    @Test
    fun refusesToOpenMoreHandlesThanTheCeiling() = runTest {
        val provider = FakeFileProvider()
        val subject = dispatcher(provider, maxOpenHandles = 2)
        respond(subject, requestFrame(Zft2Op.OPEN, 1L, metaOf("path" to "/a")))
        respond(subject, requestFrame(Zft2Op.OPEN, 2L, metaOf("path" to "/b")))
        expectCode("too_many_handles") { subject.dispatch(requestFrame(Zft2Op.OPEN, 3L, metaOf("path" to "/c"))) }
        // Refused before the platform call, so a handle-exhaustion attempt costs nothing.
        assertEquals(2, provider.calls.size)
    }

    /** A directory with 100k entries would blow the 256 KiB metadata ceiling. */
    @Test
    fun refusesAListingLargerThanTheCeiling() = runTest {
        val provider = FakeFileProvider()
        provider.listResult = (1..5).map {
            Zft2FileStat("f" + it, "/d/f" + it, false, 1L, 1L, canRead = true, canWrite = false)
        }
        expectCode("too_many_entries") {
            dispatcher(provider, maxListEntries = 2).dispatch(requestFrame(Zft2Op.LIST, 1L, metaOf("path" to "/d")))
        }
    }

    // ---- path safety -----------------------------------------------------------------------------

    @Test
    fun traversalAndAbsoluteHostPathsAreRefused() = runTest {
        val subject = dispatcher()
        expectCode("invalid_path") { subject.dispatch(requestFrame(Zft2Op.MKDIR, 1L, metaOf("path" to "/a/../../etc"))) }
        expectCode("invalid_path") { subject.dispatch(requestFrame(Zft2Op.MKDIR, 2L, metaOf("path" to "C:/Windows"))) }
        expectCode("invalid_path") { subject.dispatch(requestFrame(Zft2Op.MKDIR, 3L, metaOf("path" to "//server/share"))) }
        expectCode("invalid_path") { subject.dispatch(requestFrame(Zft2Op.MKDIR, 4L, metaOf("path" to null))) }
    }

    @Test
    fun renameOntoItselfAndNegativeTruncateAreRefused() = runTest {
        val subject = dispatcher()
        expectCode("invalid_path") {
            subject.dispatch(requestFrame(Zft2Op.RENAME, 1L, metaOf("oldPath" to "/a", "newPath" to "a/")))
        }
        expectCode("invalid_argument") {
            subject.dispatch(requestFrame(Zft2Op.TRUNCATE, 2L, metaOf("path" to "/a", "size" to -1)))
        }
    }

    /**
     * DEVELOPMENT.md 13.4 forbids a fixed canWrite. The Dart agent hardcodes true; a share
     * advertised as writable that then refuses every write produces a half-copied file on the
     * Windows side instead of a clean refusal.
     */
    @Test
    fun statReportsThePlatformsRealWritability() = runTest {
        val provider = FakeFileProvider(canWriteDefault = false)
        val response = respond(dispatcher(provider), requestFrame(Zft2Op.STAT, 1L, metaOf("path" to "/a.txt")))
        assertFalse(response.meta["canWrite"]!!.jsonPrimitive.boolean)
        assertTrue(response.meta["canRead"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun unknownOpsAndCancelAreRefusedAtDispatch() = runTest {
        val subject = dispatcher()
        expectCode("unsupported") { subject.dispatch(requestFrame(Zft2Op.CANCEL, 1L, metaOf("targetRequestId" to 9))) }
        // Op 0x7f is not in the registry; decoding keeps it so the refusal is explicit.
        val unknown = Zft2Codec.decode(Zft2Codec.encode(op = 0x7F, requestId = 2L, meta = JsonObject(emptyMap())))
        expectCode("unsupported") { subject.dispatch(unknown) }
    }

    // ---- JSON-RPC surface ------------------------------------------------------------------------

    /**
     * Still live: ai-agent-device-tools.js drives these over text frames even against a v2 agent.
     */
    @Test
    fun jsonRpcCoversTheMetadataOpsTheAiToolsUse() = runTest {
        val provider = FakeFileProvider()
        val subject = dispatcher(provider)

        val listed = subject.dispatchRpc("list", metaOf("path" to "/docs"))
        assertEquals(1, listed["entries"]!!.jsonArray.size)

        val stat = subject.dispatchRpc("stat", metaOf("path" to "/docs/a.txt"))
        assertEquals("a.txt", stat["name"]!!.jsonPrimitive.content)

        val handle = subject.dispatchRpc("open", metaOf("path" to "/docs/a.txt"))["handle"]!!.jsonPrimitive.content
        assertEquals(1, subject.openHandleCount)
        subject.dispatchRpc("close", metaOf("handle" to handle))
        assertEquals(0, subject.openHandleCount)

        subject.dispatchRpc("mkdir", metaOf("path" to "/docs/sub"))
        subject.dispatchRpc("rename", metaOf("oldPath" to "/docs/a.txt", "newPath" to "/docs/b.txt"))
        subject.dispatchRpc("truncate", metaOf("path" to "/docs/b.txt", "size" to 10))
        assertTrue(provider.calls.contains("truncate:/docs/b.txt:10"))
    }

    /** Base64 transfers inflate bytes by a third and cannot be cancelled; ZFT2 exists to replace them. */
    @Test
    fun jsonRpcRefusesBase64TransfersAndUnknownMethods() = runTest {
        val subject = dispatcher()
        expectCode("unsupported") { subject.dispatchRpc("read", metaOf("handle" to "h1")) }
        expectCode("unsupported") { subject.dispatchRpc("write", metaOf("handle" to "h1")) }
        expectCode("unsupported") { subject.dispatchRpc("chmod", metaOf("path" to "/a")) }
    }

    @Test
    fun jsonRpcHonoursTheReadOnlyJail() = runTest {
        val provider = FakeFileProvider()
        val subject = dispatcher(provider, readOnly = true)
        expectCode("read_only") { subject.dispatchRpc("mkdir", metaOf("path" to "/a")) }
        expectCode("read_only") { subject.dispatchRpc("delete", metaOf("path" to "/a")) }
        expectCode("read_only") { subject.dispatchRpc("open", metaOf("path" to "/a", "mode" to "write")) }
        assertTrue(provider.calls.isEmpty())
    }

    @Test
    fun readForRpcClampsToTheNegotiatedChunk() = runTest {
        val provider = FakeFileProvider()
        provider.readBytes = ByteArray(4096)
        val subject = dispatcher(provider, maxChunkBytes = 512)
        assertEquals(512, subject.readForRpc("h1", 0L, 999_999).size)
    }

    /** DEVELOPMENT.md 13.4: disconnect closes every handle, because they are local descriptors. */
    @Test
    fun releaseAllClosesEveryHandle() = runTest {
        val provider = FakeFileProvider()
        val subject = dispatcher(provider)
        respond(subject, requestFrame(Zft2Op.OPEN, 1L, metaOf("path" to "/a")))
        respond(subject, requestFrame(Zft2Op.OPEN, 2L, metaOf("path" to "/b")))
        subject.releaseAll()
        assertEquals(1, provider.closeAllCount)
        assertEquals(0, subject.openHandleCount)
    }
}
