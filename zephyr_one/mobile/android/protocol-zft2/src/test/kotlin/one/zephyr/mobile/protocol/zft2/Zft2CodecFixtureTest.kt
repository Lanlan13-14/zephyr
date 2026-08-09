package one.zephyr.mobile.protocol.zft2

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.int
import one.zephyr.mobile.contracts.Zft2Contract
import one.zephyr.mobile.contracts.Zft2Op
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Byte-level parity with the Node and Dart codecs.
 *
 * Asserting the exact hex rather than a round-trip is the point: a round-trip would pass even if
 * Kotlin serialised metadata differently from JavaScript, and the metadata byte length is carried in
 * the header, so a formatting difference desynchronises the peer rather than producing a clean error.
 */
class Zft2CodecFixtureTest {

    @Test
    fun encodesEveryFixtureFrameToTheExactBytes() {
        val frames = Zft2Fixtures.frames()
        assertEquals(5, frames.size)
        for (node in frames) {
            val name = node["name"]!!.jsonPrimitive.content
            val encoded = Zft2Codec.encode(
                op = Zft2Fixtures.op(node),
                requestId = Zft2Fixtures.requestId(node),
                flags = Zft2Fixtures.flags(node),
                meta = Zft2Fixtures.meta(node),
                payload = Zft2Fixtures.payload(node),
            )
            assertEquals(name, node["expectedHex"]!!.jsonPrimitive.content, Zft2Fixtures.hex(encoded))
            assertEquals(name, node["expectedLength"]!!.jsonPrimitive.int, encoded.size)
        }
    }

    @Test
    fun decodesEveryFixtureFrameBackToItsFields() {
        for (node in Zft2Fixtures.frames()) {
            val name = node["name"]!!.jsonPrimitive.content
            val frame = Zft2Codec.decode(Zft2Fixtures.unhex(node["expectedHex"]!!.jsonPrimitive.content))
            assertEquals(name, Zft2Fixtures.op(node), frame.op)
            assertEquals(name, Zft2Fixtures.requestId(node), frame.requestId)
            assertEquals(name, Zft2Fixtures.flags(node), frame.flags)
            assertEquals(name, Zft2Fixtures.meta(node), frame.meta)
            assertArrayEquals(name, Zft2Fixtures.payload(node) ?: ByteArray(0), frame.payload)
        }
    }

    /** 0xFFFFFFFF is a legal id that would be -1 as a signed Int. */
    @Test
    fun carriesTheMaximumRequestIdWithoutSignLoss() {
        val frame = Zft2Codec.decode(
            Zft2Codec.encode(op = Zft2Op.LIST.code, requestId = 0xFFFFFFFFL, meta = JsonObject(emptyMap())),
        )
        assertEquals(4294967295L, frame.requestId)
    }

    @Test
    fun rejectsEveryFixtureRejectWithItsCode() {
        val rejects = Zft2Fixtures.rejects()
        assertEquals(5, rejects.size)
        for (node in rejects) {
            val name = node["name"]!!.jsonPrimitive.content
            val expected = node["expectedCode"]!!.jsonPrimitive.content
            try {
                Zft2Codec.decode(Zft2Fixtures.unhex(node["hex"]!!.jsonPrimitive.content))
                fail(name + " should have been rejected")
            } catch (failure: Zft2Exception) {
                assertEquals(name, expected, failure.code)
            }
        }
    }

    @Test
    fun rejectsAnOpOutsideOneByteAndAnIdOutsideFourBytes() {
        try {
            Zft2Codec.encode(op = 256, requestId = 1L)
            fail("op 256 should be rejected")
        } catch (failure: Zft2Exception) {
            assertEquals("invalid_type", failure.code)
        }
        try {
            Zft2Codec.encode(op = 1, requestId = 0x1_0000_0000L)
            fail("id 2^32 should be rejected")
        } catch (failure: Zft2Exception) {
            assertEquals("invalid_request_id", failure.code)
        }
    }

    @Test
    fun rejectsMetadataThatIsNotJson() {
        // magic|v2|PING|flags 0|id 1|metaLen 3|payloadLen 0, then body "abc": a structurally valid
        // frame whose metadata is not JSON.
        val header = Zft2Fixtures.unhex("5a465432020c00000000000100000003" + "00000000")
        val raw = header + "abc".toByteArray(Charsets.UTF_8)
        try {
            Zft2Codec.decode(raw)
            fail("non-JSON metadata should be rejected")
        } catch (failure: Zft2Exception) {
            assertEquals("bad_metadata", failure.code)
        }
    }

    @Test
    fun writeOpsMatchTheContract() {
        val expected = Zft2Fixtures.ints("writeOps").sorted()
        val actual = Zft2Op.entries.filter { it.isWrite }.map { it.code }.sorted()
        assertEquals(expected, actual)
    }

    @Test
    fun clampsInflightToTheFrozenWindow() {
        for (node in Zft2Fixtures.cases("inflight")) {
            assertEquals(
                node["expected"]!!.jsonPrimitive.int,
                Zft2Codec.clampInflight(node["input"]!!.jsonPrimitive.int),
            )
        }
        assertEquals(Zft2Contract.MAX_INFLIGHT_DEFAULT, Zft2Codec.clampInflight(null))
    }

    @Test
    fun negotiatesChunkToTheSmallerCapability() {
        for (node in Zft2Fixtures.cases("chunkNegotiation")) {
            assertEquals(
                node["expected"]!!.jsonPrimitive.int,
                Zft2Codec.negotiateChunk(node["local"]!!.jsonPrimitive.int, node["remote"]!!.jsonPrimitive.int),
            )
        }
        assertEquals(1, Zft2Codec.negotiateChunk(0, 0))
    }

    @Test
    fun errorFrameCarriesOnlyCodeAndMessage() {
        val request = Zft2Codec.decode(
            Zft2Codec.encode(op = Zft2Op.OPEN.code, requestId = 5L, meta = JsonObject(emptyMap())),
        )
        val error = Zft2Codec.decode(Zft2Codec.encodeError(request, "read_only", "Share is read-only"))
        assertTrue(error.isResponse)
        assertTrue(error.isError)
        assertEquals(Zft2Op.OPEN.code, error.op)
        assertEquals(5L, error.requestId)
        assertEquals(setOf("code", "message"), error.meta.keys)
    }
}
