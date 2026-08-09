package one.zephyr.mobile.protocol.zft2

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import one.zephyr.mobile.contracts.Zft2Op
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Stream reassembly.
 *
 * These cases are the ones that break a hand-rolled binary client in the field: a header split
 * across two reads, several frames in one read, and a length that has not fully arrived. None of
 * them are visible over a WebSocket (where a message is already a whole frame), which is exactly
 * why they need a test rather than a manual check.
 */
class Zft2FrameReaderTest {

    private fun ping(id: Long): ByteArray =
        Zft2Codec.encode(op = Zft2Op.PING.code, requestId = id, meta = JsonObject(emptyMap()))

    @Test
    fun returnsNothingUntilAWholeFrameHasArrived() {
        val reader = Zft2FrameReader()
        val frame = ping(1L)
        assertTrue(reader.feed(frame.copyOfRange(0, 10)).isEmpty())
        assertEquals(10, reader.bufferedBytes)
        assertTrue(reader.feed(frame.copyOfRange(10, 20)).isEmpty())
        val frames = reader.feed(frame.copyOfRange(20, frame.size))
        assertEquals(1, frames.size)
        assertEquals(1L, frames[0].requestId)
        assertEquals(0, reader.bufferedBytes)
    }

    @Test
    fun splitsSeveralFramesDeliveredInOneRead() {
        val reader = Zft2FrameReader()
        val frames = reader.feed(ping(1L) + ping(2L) + ping(3L))
        assertEquals(listOf(1L, 2L, 3L), frames.map { it.requestId })
        assertEquals(0, reader.bufferedBytes)
    }

    @Test
    fun keepsTheRemainderOfATrailingPartialFrame() {
        val reader = Zft2FrameReader()
        val second = ping(2L)
        val frames = reader.feed(ping(1L) + second.copyOfRange(0, 12))
        assertEquals(listOf(1L), frames.map { it.requestId })
        assertEquals(12, reader.bufferedBytes)
        assertEquals(listOf(2L), reader.feed(second.copyOfRange(12, second.size)).map { it.requestId })
    }

    @Test
    fun carriesPayloadAndMetadataThroughReassembly() {
        val reader = Zft2FrameReader()
        val body = "hello".toByteArray(Charsets.UTF_8)
        val encoded = Zft2Codec.encode(
            op = Zft2Op.WRITE.code,
            requestId = 9L,
            meta = buildJsonObject { put("handle", JsonPrimitive("h1")) },
            payload = body,
        )
        assertTrue(reader.feed(encoded.copyOfRange(0, 25)).isEmpty())
        val frames = reader.feed(encoded.copyOfRange(25, encoded.size))
        assertEquals(1, frames.size)
        assertArrayEquals(body, frames[0].payload)
        assertEquals("h1", (frames[0].meta["handle"] as JsonPrimitive).content)
    }

    /**
     * A stream that has lost alignment cannot be resynchronised: scanning forward for the next magic
     * would let a peer choose the next frame boundary, so the reader refuses instead.
     */
    @Test
    fun rejectsBadMagicWithoutBufferingTheAdvertisedLength() {
        val reader = Zft2FrameReader()
        val hostile = Zft2Fixtures.unhex("5846543200000000000000000000000000000000")
        try {
            reader.feed(hostile)
            org.junit.Assert.fail("bad magic should be rejected")
        } catch (failure: Zft2Exception) {
            assertEquals("bad_magic", failure.code)
        }
    }

    @Test
    fun rejectsAMetadataLengthBombBeforeBuffering() {
        val reader = Zft2FrameReader()
        try {
            reader.feed(Zft2Fixtures.unhex("5a4654320206000000000001ffffffff00000000"))
            org.junit.Assert.fail("length bomb should be rejected")
        } catch (failure: Zft2Exception) {
            assertEquals("metadata_too_large", failure.code)
        }
    }

    @Test
    fun rejectsAnUnsupportedVersionEvenBeforeTheBodyArrives() {
        val reader = Zft2FrameReader()
        try {
            reader.feed(Zft2Fixtures.unhex("5a46543203000000000000000000000000000000"))
            org.junit.Assert.fail("version 3 should be rejected")
        } catch (failure: Zft2Exception) {
            assertEquals("unsupported_version", failure.code)
        }
    }

    @Test
    fun resetDropsPartialState() {
        val reader = Zft2FrameReader()
        reader.feed(ping(1L).copyOfRange(0, 8))
        assertEquals(8, reader.bufferedBytes)
        reader.reset()
        assertEquals(0, reader.bufferedBytes)
    }
}
