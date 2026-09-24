package one.zephyr.mobile.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress

/**
 * Contract v2 TransportTarget construction: every resolved IP travels (IPv4
 * first), TLS SNI and Host keep the original hostname, and resolution failure
 * yields an empty dial list so Go surfaces the original DNS error.
 */
class TransportTargetTest {

    private fun literal(bytes: ByteArray): InetAddress = InetAddress.getByAddress(bytes)

    @Test
    fun `all resolved ips travel with ipv4 first`() {
        val v6 = literal(byteArrayOf(0x26, 0x06, 0x47, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0x68, 0x12, 0x07, 0x0c.toByte()))
        val v4 = literal(byteArrayOf(104, 18, 7, 192.toByte()))
        val target = EmbeddedAiRuntimeApi.buildTransportTarget("https://api.openai.com/v1") { arrayOf(v6, v4) }
        assertEquals("api.openai.com", target.effectiveHost)
        assertEquals(443, target.effectivePort)
        assertEquals("api.openai.com", target.tlsServerName)
        assertEquals("android-jvm-dns", target.resolutionSource)
        assertEquals(2, target.dialTargets.size)
        assertEquals("104.18.7.192", target.dialTargets[0].ip)
        assertEquals("ipv4", target.dialTargets[0].family)
        assertEquals("ipv6", target.dialTargets[1].family)
        assertTrue(target.requestUrl.contains("104.18.7.192"))
    }

    @Test
    fun `resolution failure yields empty dial list`() {
        val target = EmbeddedAiRuntimeApi.buildTransportTarget("https://api.openai.com/v1") {
            throw java.net.UnknownHostException("api.openai.com")
        }
        assertTrue(target.dialTargets.isEmpty())
        assertEquals("api.openai.com", target.effectiveHost)
        assertEquals("api.openai.com", target.tlsServerName)
    }

    @Test
    fun `literal ip passes through with itself as server name`() {
        val target = EmbeddedAiRuntimeApi.buildTransportTarget("https://1.2.3.4:8443/v1") {
            throw AssertionError("resolver must not run for literals")
        }
        assertEquals(1, target.dialTargets.size)
        assertEquals("1.2.3.4", target.dialTargets[0].ip)
        assertEquals(8443, target.effectivePort)
    }
}
