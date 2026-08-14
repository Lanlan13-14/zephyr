package one.zephyr.mobile.feature.connections

import one.zephyr.mobile.model.Protocol
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolPickerCopyTest {

    @Test
    fun `every protocol has a demo-aligned title and risk-honest detail`() {
        val ssh = protocolPickerCopy(Protocol.SSH)
        assertEquals("SSH", ssh.first)
        assertTrue(ssh.second.contains("SFTP"))

        val telnet = protocolPickerCopy(Protocol.TELNET)
        assertEquals("Telnet", telnet.first)
        assertTrue(telnet.second.contains("未加密"))

        val rdp = protocolPickerCopy(Protocol.RDP)
        assertEquals("RDP", rdp.first)
        assertTrue(rdp.second.contains("远程桌面"))

        val vnc = protocolPickerCopy(Protocol.VNC)
        assertEquals("VNC", vnc.first)
        assertTrue(vnc.second.contains("不自动降级"))
    }
}
