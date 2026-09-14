package one.zephyr.mobile.app

import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.InetAddress
import java.net.UnknownHostException

/**
 * Model discovery must rewrite the provider URL to an IP literal for the CGO-less Go runtime
 * (no DNS on Android), while the original hostname travels as serverName for TLS SNI and the
 * HTTP Host header. A resolution failure passes the URL through untouched.
 */
class EmbeddedAiRuntimeApiDnsRewriteTest {

    @Test
    fun `resolvable host is rewritten to an ip literal keeping the server name`() {
        val literal = InetAddress.getByAddress(byteArrayOf(1, 2, 3, 4))
        val (url, serverName) = EmbeddedAiRuntimeApi.rewriteProviderEndpoint(
            "https://provider.example:8443/v1",
        ) { arrayOf(literal) }
        assertEquals("https://1.2.3.4:8443/v1", url)
        assertEquals("provider.example", serverName)
    }

    @Test
    fun `unresolvable host passes through untouched`() {
        val (url, serverName) = EmbeddedAiRuntimeApi.rewriteProviderEndpoint(
            "https://provider.example/v1",
        ) { throw UnknownHostException("provider.example") }
        assertEquals("https://provider.example/v1", url)
        assertEquals("", serverName)
    }
}