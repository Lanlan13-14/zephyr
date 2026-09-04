package one.zephyr.mobile.app

import java.net.InetAddress
import java.net.URI
import java.net.UnknownHostException

/**
 * Turns a Link peer URL into an IP literal plus the original hostname.
 *
 * The embedded Go core is built CGO_ENABLED=0, so it has no Android DNS
 * (cgo resolver) and no /etc/resolv.conf in the app netns. Dialing
 * `https://example.com/...` from Go therefore fails even when OkHttp on the
 * same device can already reach the host. Resolve here with
 * [InetAddress.getAllByName], then tell Go to connect to the IP while keeping
 * the original hostname for TLS SNI and the HTTP Host header.
 */
internal data class LinkPeerTarget(
    val url: String,
    val serverName: String,
)

internal object LinkPeerResolver {

    fun resolve(
        serverUrl: String,
        lookup: (String) -> Array<InetAddress> = { InetAddress.getAllByName(it) },
    ): LinkPeerTarget {
        val uri = URI(serverUrl)
        val host = uri.host?.takeIf { it.isNotBlank() }
            ?: throw IllegalArgumentException("Link URL missing host")
        if (isLiteralIp(host)) return LinkPeerTarget(serverUrl, host)
        val ip = lookup(host).firstOrNull()?.hostAddress
            ?.let(::canonicalIpLiteral)
            ?: throw UnknownHostException(host)
        val encodedIp = if (ip.contains(':')) "[$ip]" else ip
        val authority = if (uri.port != -1) "$encodedIp:${uri.port}" else encodedIp
        val rewritten = URI(uri.scheme, authority, uri.path, uri.query, uri.fragment).toString()
        return LinkPeerTarget(rewritten, host)
    }

    internal fun canonicalIpLiteral(hostAddress: String): String = hostAddress.substringBefore('%')

    internal fun isLiteralIp(host: String): Boolean {
        val value = host.removePrefix("[").removeSuffix("]")
        if (value.contains(':')) return true
        val parts = value.split('.')
        if (parts.size != 4) return false
        return parts.all { part ->
            part.isNotEmpty() && part.all(Char::isDigit) && part.toInt() in 0..255
        }
    }
}
