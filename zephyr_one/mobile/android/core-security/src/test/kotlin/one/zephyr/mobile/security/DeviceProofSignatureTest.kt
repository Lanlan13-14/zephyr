package one.zephyr.mobile.security

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DeviceProofSignatureTest {

    @Test
    fun `DER signature converts to fixed width P1363`() {
        val r = ByteArray(32) { index -> if (index == 0) 0x80.toByte() else index.toByte() }
        val der = byteArrayOf(0x30, 0x26, 0x02, 0x21, 0x00) + r +
            byteArrayOf(0x02, 0x01, 0x01)

        val p1363 = derEcdsaToP1363(der)

        assertArrayEquals(r, p1363.copyOfRange(0, 32))
        assertArrayEquals(ByteArray(31) + byteArrayOf(0x01), p1363.copyOfRange(32, 64))
    }

    @Test
    fun `DER converter rejects negative and non-canonical integers`() {
        val negative = byteArrayOf(
            0x30, 0x06,
            0x02, 0x01, 0x80.toByte(),
            0x02, 0x01, 0x01,
        )
        val redundantZero = byteArrayOf(
            0x30, 0x07,
            0x02, 0x02, 0x00, 0x01,
            0x02, 0x01, 0x01,
        )

        assertThrows(IllegalArgumentException::class.java) { derEcdsaToP1363(negative) }
        assertThrows(IllegalArgumentException::class.java) { derEcdsaToP1363(redundantZero) }
    }
}
