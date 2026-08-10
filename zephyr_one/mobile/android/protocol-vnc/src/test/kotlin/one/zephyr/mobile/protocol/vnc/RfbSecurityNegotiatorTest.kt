package one.zephyr.mobile.protocol.vnc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The ADR-005 "未知 security type 拒绝" gate. */
class RfbSecurityNegotiatorTest {

    @Test
    fun `picks VncAuth when a password is available`() {
        val selection = RfbSecurityNegotiator.select(
            offered = listOf(RfbSecurityType.NONE, RfbSecurityType.VNC_AUTH),
            hasPassword = true,
        )
        // Choosing None here would silently discard the authentication the user configured.
        assertEquals(RfbSecuritySelection.Selected(RfbSecurityType.VNC_AUTH), selection)
    }

    @Test
    fun `picks None when the server offers it and no password is stored`() {
        val selection = RfbSecurityNegotiator.select(
            offered = listOf(RfbSecurityType.NONE, RfbSecurityType.VNC_AUTH),
            hasPassword = false,
        )
        assertEquals(RfbSecuritySelection.Selected(RfbSecurityType.NONE), selection)
    }

    @Test
    fun `reports a missing password instead of a generic failure`() {
        val selection = RfbSecurityNegotiator.select(listOf(RfbSecurityType.VNC_AUTH), hasPassword = false)
        val rejected = selection as RfbSecuritySelection.Rejected
        assertEquals(VncErrors.PASSWORD_REQUIRED, rejected.code)
    }

    @Test
    fun `rejects every unimplemented security type by name`() {
        val selection = RfbSecurityNegotiator.select(
            offered = listOf(RfbSecurityType.TLS, RfbSecurityType.VENCRYPT, RfbSecurityType.RA2),
            hasPassword = true,
        )
        val rejected = selection as RfbSecuritySelection.Rejected
        assertEquals(VncErrors.NO_SUPPORTED_SECURITY, rejected.code)
        assertTrue("names the mechanism so the user can act", rejected.detail.contains("TLS"))
        assertTrue(rejected.detail.contains("VeNCrypt"))
        assertTrue(rejected.detail.contains("RA2"))
    }

    @Test
    fun `an unknown number is refused rather than assumed to be None`() {
        // The failure this prevents: treating an unrecognised type as "no auth needed" and handing
        // the framebuffer to whatever answered the port.
        val selection = RfbSecurityNegotiator.select(listOf(200), hasPassword = true)
        val rejected = selection as RfbSecuritySelection.Rejected
        assertEquals(VncErrors.NO_SUPPORTED_SECURITY, rejected.code)
        assertTrue(rejected.detail.contains("Unknown(200)"))
    }

    @Test
    fun `an empty offer is rejected`() {
        val rejected = RfbSecurityNegotiator.select(emptyList(), hasPassword = true)
            as RfbSecuritySelection.Rejected
        assertEquals(VncErrors.NO_SUPPORTED_SECURITY, rejected.code)
    }

    @Test
    fun `only None and VncAuth are implemented`() {
        assertEquals(setOf(RfbSecurityType.NONE, RfbSecurityType.VNC_AUTH), RfbSecurityNegotiator.SUPPORTED)
    }
}
