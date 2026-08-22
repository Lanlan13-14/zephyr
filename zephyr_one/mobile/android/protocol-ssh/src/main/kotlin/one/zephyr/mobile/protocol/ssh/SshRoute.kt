package one.zephyr.mobile.protocol.ssh

import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.ConnectionMode
import one.zephyr.mobile.model.JumpHost
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Proxy
import one.zephyr.mobile.model.ProxyType

/** One hop in a resolved route. */
sealed interface RouteHop {
    val host: String
    val port: Int

    data class Socks5(override val host: String, override val port: Int, val username: String) : RouteHop
    data class HttpConnect(override val host: String, override val port: Int, val username: String) : RouteHop

    /** An intermediate SSH server the next hop is tunnelled through. */
    data class SshJump(
        override val host: String,
        override val port: Int,
        val username: String,
        val connectionId: String,
    ) : RouteHop

    data class Target(override val host: String, override val port: Int) : RouteHop
}

/**
 * A fully resolved path to the target, in dial order.
 *
 * Resolved ahead of the dial rather than discovered during it, so a cycle or an over-deep chain is
 * reported as a configuration error before any socket opens.
 */
data class SshRoute(val hops: List<RouteHop>) {
    val target: RouteHop.Target get() = hops.last() as RouteHop.Target
    val jumpDepth: Int get() = hops.count { it is RouteHop.SshJump }
}

sealed interface RoutePlanResult {
    data class Planned(val route: SshRoute) : RoutePlanResult

    /** [code] is a stable error code; the UI maps it to text. */
    data class Rejected(val code: String, val detail: String) : RoutePlanResult
}

/**
 * Builds the hop list for a connection.
 *
 * Shared by SSH, Telnet, RDP and VNC because DEVELOPMENT.md 14.1 wants one route planner rather than
 * per-protocol proxy handling: a proxy bug fixed for SSH but not VNC is the failure this prevents.
 */
object SshRoutePlanner {

    /** DEVELOPMENT.md 14.1: at most eight SSH jump levels. */
    const val MAX_JUMP_DEPTH = 8

    fun plan(
        connection: Connection,
        proxies: Map<String, Proxy>,
        jumpHosts: Map<String, JumpHost>,
        connections: Map<String, Connection>,
    ): RoutePlanResult {
        if (connection.host.isBlank()) return RoutePlanResult.Rejected("invalid_host", "Host is empty")
        if (connection.port !in 1..65535) return RoutePlanResult.Rejected("invalid_port", "Port out of range")

        val hops = mutableListOf<RouteHop>()

        when (connection.connectionMode) {
            ConnectionMode.DIRECT -> Unit

            ConnectionMode.PROXY -> {
                val proxyId = connection.proxyId
                    ?: return RoutePlanResult.Rejected("proxy_not_configured", "Proxy mode without a proxy")
                val proxy = proxies[proxyId]
                    ?: return RoutePlanResult.Rejected("dependency_missing", "Proxy " + proxyId + " is unavailable")
                hops += when (proxy.type) {
                    ProxyType.SOCKS5 -> RouteHop.Socks5(proxy.host, proxy.port, proxy.username)
                    ProxyType.HTTP_CONNECT -> RouteHop.HttpConnect(proxy.host, proxy.port, proxy.username)
                }
            }

            ConnectionMode.JUMP -> {
                if (connection.jumpHostIds.isEmpty()) {
                    return RoutePlanResult.Rejected("jump_not_configured", "Jump mode without a jump host")
                }
                if (connection.jumpHostIds.size > MAX_JUMP_DEPTH) {
                    return RoutePlanResult.Rejected(
                        "jump_chain_too_deep",
                        "Chain of " + connection.jumpHostIds.size + " exceeds " + MAX_JUMP_DEPTH,
                    )
                }
                // A jump host pointing back at the connection it is dialling would recurse until the
                // socket budget is gone, so the whole chain is checked for repeats up front.
                val seen = mutableSetOf(connection.id)
                for (jumpId in connection.jumpHostIds) {
                    /* Main-end resolveRoutePlan semantics: a stored jump id names a jumpHost
                     * resource whose connectionId is the hop; when no such resource exists the
                     * id *is* the connection id. Rejecting a bare connection id here is what made
                     * every jump route configured on the server read as "not configured" on
                     * mobile. */
                    val jump = jumpHosts[jumpId]
                    val via = connections[jump?.connectionId ?: jumpId]
                        ?: return RoutePlanResult.Rejected(
                            "dependency_missing",
                            "Jump host " + jumpId + " points at a missing connection",
                        )
                    if (!seen.add(via.id)) {
                        return RoutePlanResult.Rejected("jump_cycle", "Jump chain revisits " + via.id)
                    }
                    if (via.protocol != Protocol.SSH) {
                        return RoutePlanResult.Rejected(
                            "jump_protocol_unsupported",
                            "Jump host " + (via.name.ifBlank { via.host }) + " is not SSH",
                        )
                    }
                    if (via.host.isBlank()) {
                        return RoutePlanResult.Rejected("invalid_host", "Jump host " + jumpId + " has no host")
                    }
                    hops += RouteHop.SshJump(
                        host = via.host,
                        port = via.port,
                        username = via.username,
                        connectionId = via.id,
                    )
                }
            }
        }

        hops += RouteHop.Target(connection.host, connection.port)
        return RoutePlanResult.Planned(SshRoute(hops))
    }
}
