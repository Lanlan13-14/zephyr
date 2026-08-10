package one.zephyr.mobile.protocol.vnc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RfbVersionTest {

    @Test
    fun `wire format is the exact twelve byte greeting`() {
        assertEquals("RFB 003.008\n", RfbVersion.V3_8.wire)
        assertEquals(RfbVersion.WIRE_LENGTH, RfbVersion.V3_8.encode().size)
        assertEquals("524642203030332e3030380a", RfbVersion.V3_8.encode().toHex())
        assertEquals("524642203030332e3030330a", RfbVersion.V3_3.encode().toHex())
    }

    @Test
    fun `parse accepts the three supported greetings`() {
        assertEquals(RfbVersion.V3_3, RfbVersion.parse("RFB 003.003\n".toByteArray()))
        assertEquals(RfbVersion.V3_7, RfbVersion.parse("RFB 003.007\n".toByteArray()))
        assertEquals(RfbVersion.V3_8, RfbVersion.parse("RFB 003.008\n".toByteArray()))
    }

    @Test
    fun `parse rejects anything that is not an RFB greeting`() {
        // A web server or SSH daemon answering on 5900 must not be coerced into a version.
        assertNull(RfbVersion.parse("HTTP/1.1 400".toByteArray()))
        assertNull(RfbVersion.parse("SSH-2.0-Open".toByteArray()))
        assertNull(RfbVersion.parse("RFB 003.008".toByteArray()))
        assertNull(RfbVersion.parse("RFB 003_008\n".toByteArray()))
        assertNull(RfbVersion.parse("RFB 0x3.008\n".toByteArray()))
        assertNull(RfbVersion.parse(ByteArray(0)))
    }

    @Test
    fun `negotiate picks the highest mutually supported version`() {
        assertEquals(RfbVersion.V3_8, RfbVersion.negotiate(RfbVersion.V3_8))
        assertEquals(RfbVersion.V3_7, RfbVersion.negotiate(RfbVersion.V3_7))
        assertEquals(RfbVersion.V3_3, RfbVersion.negotiate(RfbVersion.V3_3))
    }

    @Test
    fun `negotiate clamps a newer server down to 3 point 8`() {
        // Apple Remote Desktop announces 003.889; echoing it back would claim support we lack.
        assertEquals(RfbVersion.V3_8, RfbVersion.negotiate(RfbVersion(3, 889)))
        assertEquals(RfbVersion.V3_8, RfbVersion.negotiate(RfbVersion(4, 1)))
    }

    @Test
    fun `negotiate falls back to 3 point 3 for an unsupported minor in between`() {
        assertEquals(RfbVersion.V3_3, RfbVersion.negotiate(RfbVersion(3, 4)))
        assertEquals(RfbVersion.V3_3, RfbVersion.negotiate(RfbVersion(3, 6)))
    }

    @Test
    fun `negotiate refuses anything older than 3 point 3`() {
        assertNull(RfbVersion.negotiate(RfbVersion(3, 2)))
        assertNull(RfbVersion.negotiate(RfbVersion(2, 9)))
    }

    @Test
    fun `version flags encode the behavioural differences between versions`() {
        assertFalse("3.3 has the server dictate security", RfbVersion.V3_3.clientChoosesSecurity)
        assertTrue(RfbVersion.V3_7.clientChoosesSecurity)
        assertTrue(RfbVersion.V3_8.clientChoosesSecurity)

        // Reading a SecurityResult that 3.3/3.7 never send would eat the first bytes of ServerInit.
        assertFalse(RfbVersion.V3_3.sendsSecurityResultForNone)
        assertFalse(RfbVersion.V3_7.sendsSecurityResultForNone)
        assertTrue(RfbVersion.V3_8.sendsSecurityResultForNone)

        assertFalse(RfbVersion.V3_3.securityFailureHasReason)
        assertFalse(RfbVersion.V3_7.securityFailureHasReason)
        assertTrue(RfbVersion.V3_8.securityFailureHasReason)
    }

    @Test
    fun `versions order by major then minor`() {
        assertTrue(RfbVersion.V3_3 < RfbVersion.V3_7)
        assertTrue(RfbVersion.V3_7 < RfbVersion.V3_8)
        assertTrue(RfbVersion.V3_8 < RfbVersion(4, 0))
        assertEquals(3, RfbVersion.SUPPORTED.size)
    }
}
