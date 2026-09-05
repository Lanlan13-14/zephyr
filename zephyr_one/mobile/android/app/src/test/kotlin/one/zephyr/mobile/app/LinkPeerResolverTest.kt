package one.zephyr.mobile.app

import java.net.InetAddress
import java.net.UnknownHostException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LinkPeerResolverTest {

    @Test
    fun `literal IPv4 is left alone and reused as SNI`() {
        val url = "https://203.0.113.9:24443/api/link/v2"
        val target = LinkPeerResolver.resolve(url) { error("must not look up a literal") }
        assertEquals(url, target.url)
        assertEquals("203.0.113.9", target.serverName)
    }

    @Test
    fun `hostname is rewritten to the looked-up IP and keeps the original SNI`() {
        val loopback = InetAddress.getByName("127.0.0.1")
        val target = LinkPeerResolver.resolve(
            "https://zephyr.example:8443/api/link/v2",
        ) { host ->
            assertEquals("zephyr.example", host)
            arrayOf(loopback)
        }
        assertEquals("https://127.0.0.1:8443/api/link/v2", target.url)
        assertEquals("zephyr.example", target.serverName)
    }

    @Test
    fun `AAAA-first lookup still dials IPv4 first and keeps every address`() {
        val v6 = InetAddress.getByName("2001:db8::1")
        val v4 = InetAddress.getByName("203.0.113.9")
        val targets = LinkPeerResolver.resolveAll("https://zephyr.example:8443/api/link/v2") {
            arrayOf(v6, v4)
        }
        assertEquals(2, targets.size)
        assertEquals("https://203.0.113.9:8443/api/link/v2", targets[0].url)
        assertTrue(targets[1].url.startsWith("https://[") && targets[1].url.contains("]:8443/api/link/v2"))
        assertTrue(targets.all { it.serverName == "zephyr.example" })
        assertEquals("https://203.0.113.9:8443/api/link/v2", LinkPeerResolver.resolve(
            "https://zephyr.example:8443/api/link/v2",
        ) { arrayOf(v6, v4) }.url)
    }

    @Test
    fun `IPv6 zone ids are stripped before rewriting the URL`() {
        assertEquals("fe80::1", LinkPeerResolver.canonicalIpLiteral("fe80::1%wlan0"))
        val loopback6 = InetAddress.getByName("::1")
        val target = LinkPeerResolver.resolve("https://zephyr.example/api/link/v2") {
            arrayOf(loopback6)
        }
        assertFalse(target.url.contains('%'))
        assertTrue(target.url.contains("[") && target.url.contains("]"))
        assertEquals("zephyr.example", target.serverName)
    }

    @Test
    fun `IPv6 literals are not re-resolved`() {
        val url = "https://[2001:db8::1]:8443/api/link/v2"
        val target = LinkPeerResolver.resolve(url) { error("must not look up a literal") }
        assertEquals(url, target.url)
        assertEquals("2001:db8::1", target.serverName)
        assertFalse(target.serverName.startsWith("["))
        assertFalse(target.serverName.contains(']'))
    }

    @Test(expected = UnknownHostException::class)
    fun `empty lookup fails closed`() {
        LinkPeerResolver.resolve("https://missing.example/api/link/v2") { emptyArray() }
    }

    @Test
    fun `isLiteralIp rejects hostnames`() {
        assertTrue(LinkPeerResolver.isLiteralIp("10.0.0.8"))
        assertTrue(LinkPeerResolver.isLiteralIp("2001:db8::1"))
        assertFalse(LinkPeerResolver.isLiteralIp("zephyr.example"))
        assertFalse(LinkPeerResolver.isLiteralIp("10.0.0"))
    }
}
