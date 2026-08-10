package one.zephyr.mobile.protocol.vnc

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Vectors cross-checked against an independent DES implementation, which was itself first validated
 * against the published DES vector key=0123456789abcdef / plaintext=0123456789abcdef ->
 * 56cc09e7cfdc4cef. Without that second implementation these numbers would only prove the code
 * agrees with itself.
 */
class VncAuthTest {

    @Test
    fun `key is the password bytes with every bit mirrored`() {
        assertEquals("0e86ceceeef64e26", VncAuth.mirrorKey("password".toCharArray()).toHex())
    }

    @Test
    fun `a short password is zero padded to eight bytes`() {
        // "zephyr" is six characters; the trailing two key bytes stay zero.
        assertEquals("5ea60e169e4e0000", VncAuth.mirrorKey("zephyr".toCharArray()).toHex())
        assertEquals(VncAuth.KEY_BYTES, VncAuth.mirrorKey("z".toCharArray()).size)
    }

    @Test
    fun `a long password silently loses everything past the eighth character`() {
        // Matches what servers do. Surprising, but changing it would break interoperability.
        val truncated = VncAuth.mirrorKey("abcdefghij".toCharArray()).toHex()
        assertEquals("8646c626a666e616", truncated)
        assertEquals(truncated, VncAuth.mirrorKey("abcdefgh".toCharArray()).toHex())
    }

    @Test
    fun `an empty password yields the all zero key`() {
        assertEquals("0000000000000000", VncAuth.mirrorKey(CharArray(0)).toHex())
    }

    @Test
    fun `mirrorByte reverses bit order`() {
        assertEquals(0x00, VncAuth.mirrorByte(0x00))
        assertEquals(0xFF, VncAuth.mirrorByte(0xFF))
        assertEquals(0x80, VncAuth.mirrorByte(0x01))
        assertEquals(0x01, VncAuth.mirrorByte(0x80))
        // 'p' = 0x70 = 0111 0000 -> 0000 1110 = 0x0E
        assertEquals(0x0E, VncAuth.mirrorByte(0x70))
    }

    @Test
    fun `response encrypts the challenge as two independent DES blocks`() {
        val response = VncAuth.response("password".toCharArray(), SEQUENTIAL_CHALLENGE)
        assertEquals(VncAuth.CHALLENGE_BYTES, response.size)
        assertEquals("b866924125c8eebb9debc1db61c538e2", response.toHex())
    }

    @Test
    fun `response vector for a six character password`() {
        val response = VncAuth.response("zephyr".toCharArray(), SEQUENTIAL_CHALLENGE)
        assertEquals("d553bf38c266cdab7287fd29a093b59e", response.toHex())
    }

    @Test
    fun `passwords beyond eight characters produce the same response`() {
        val long = VncAuth.response("abcdefghij".toCharArray(), SEQUENTIAL_CHALLENGE).toHex()
        val short = VncAuth.response("abcdefgh".toCharArray(), SEQUENTIAL_CHALLENGE).toHex()
        assertEquals(short, long)
        assertEquals("eae3a1cb74ca6daac183f66460190bb5", long)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a challenge of the wrong length is refused`() {
        VncAuth.response("zephyr".toCharArray(), ByteArray(8))
    }
}
