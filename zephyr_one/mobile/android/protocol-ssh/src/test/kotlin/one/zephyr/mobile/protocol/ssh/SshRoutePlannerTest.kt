package one.zephyr.mobile.protocol.ssh

import one.zephyr.mobile.model.ConnectionMode
import one.zephyr.mobile.model.ProxyType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Route planning is resolved before any socket opens, so every rejection here is a configuration
 * error the user can fix rather than a connect timeout they have to guess at.
 */
class SshRoutePlannerTest {

    private fun plan(
        connection: one.zephyr.mobile.model.Connection,
        proxies: Map<String, one.zephyr.mobile.model.Proxy> = emptyMap(),
        jumps: Map<String, one.zephyr.mobile.model.JumpHost> = emptyMap(),
        connections: Map<String, one.zephyr.mobile.model.Connection> = emptyMap(),
    ): RoutePlanResult = SshRoutePlanner.plan(connection, proxies, jumps, connections)

    @Test
    fun `a direct connection is a single target hop`() {
        val route = (plan(connection()) as RoutePlanResult.Planned).route

        assertEquals(1, route.hops.size)
        assertEquals(RouteHop.Target("10.0.0.5", 22), route.target)
        assertEquals(0, route.jumpDepth)
    }

    @Test
    fun `a SOCKS5 proxy is dialled before the target`() {
        val result = plan(
            connection(mode = ConnectionMode.PROXY, proxyId = "proxy-1"),
            proxies = mapOf("proxy-1" to proxy()),
        )

        val route = (result as RoutePlanResult.Planned).route
        assertEquals(
            listOf(
                RouteHop.Socks5("proxy.internal", 1080, "agent"),
                RouteHop.Target("10.0.0.5", 22),
            ),
            route.hops,
        )
    }

    @Test
    fun `an HTTP CONNECT proxy maps to its own hop type`() {
        val result = plan(
            connection(mode = ConnectionMode.PROXY, proxyId = "proxy-2"),
            proxies = mapOf(
                "proxy-2" to proxy(id = "proxy-2", type = ProxyType.HTTP_CONNECT, host = "gw.corp", port = 8080),
            ),
        )

        val route = (result as RoutePlanResult.Planned).route
        assertEquals(RouteHop.HttpConnect("gw.corp", 8080, "agent"), route.hops.first())
    }

    @Test
    fun `proxy mode without a proxy id is a configuration error`() {
        val rejected = plan(connection(mode = ConnectionMode.PROXY)) as RoutePlanResult.Rejected

        assertEquals("proxy_not_configured", rejected.code)
    }

    @Test
    fun `a proxy id that no longer resolves is reported as a missing dependency`() {
        // The proxy row was deleted or its grant was revoked. Distinct from proxy_not_configured
        // because the fix is different: re-share or re-create, not pick one.
        val rejected = plan(
            connection(mode = ConnectionMode.PROXY, proxyId = "gone"),
        ) as RoutePlanResult.Rejected

        assertEquals("dependency_missing", rejected.code)
        assertTrue(rejected.detail.contains("gone"))
    }

    @Test
    fun `jump mode with no jump hosts is a configuration error`() {
        val rejected = plan(connection(mode = ConnectionMode.JUMP)) as RoutePlanResult.Rejected

        assertEquals("jump_not_configured", rejected.code)
    }

    @Test
    fun `a single jump becomes one intermediate hop`() {
        val via = connection(id = "bastion", host = "bastion.corp", port = 2222, username = "ops")
        val result = plan(
            connection(mode = ConnectionMode.JUMP, jumpHostIds = listOf("jump-1")),
            jumps = mapOf("jump-1" to jumpHost("jump-1", "bastion")),
            connections = mapOf("bastion" to via),
        )

        val route = (result as RoutePlanResult.Planned).route
        assertEquals(
            listOf(
                RouteHop.SshJump("bastion.corp", 2222, "ops", "bastion"),
                RouteHop.Target("10.0.0.5", 22),
            ),
            route.hops,
        )
        assertEquals(1, route.jumpDepth)
    }

    @Test
    fun `jumps keep their configured order`() {
        val (ids, jumps, vias) = jumpChain(2)
        val result = plan(
            connection(mode = ConnectionMode.JUMP, jumpHostIds = ids),
            jumps = jumps,
            connections = vias,
        )

        val route = (result as RoutePlanResult.Planned).route
        // Order is the dial order, so reversing it would tunnel through the wrong bastion first.
        assertEquals("via-jump-1.internal", route.hops[0].host)
        assertEquals("via-jump-2.internal", route.hops[1].host)
        assertTrue(route.hops[2] is RouteHop.Target)
    }

    @Test
    fun `eight jumps is the documented maximum and is accepted`() {
        val (ids, jumps, vias) = jumpChain(SshRoutePlanner.MAX_JUMP_DEPTH)
        val result = plan(
            connection(mode = ConnectionMode.JUMP, jumpHostIds = ids),
            jumps = jumps,
            connections = vias,
        )

        val route = (result as RoutePlanResult.Planned).route
        assertEquals(8, route.jumpDepth)
        assertEquals(9, route.hops.size)
        assertEquals(RouteHop.Target("10.0.0.5", 22), route.target)
    }

    @Test
    fun `a ninth jump is refused`() {
        val (ids, jumps, vias) = jumpChain(SshRoutePlanner.MAX_JUMP_DEPTH + 1)
        val rejected = plan(
            connection(mode = ConnectionMode.JUMP, jumpHostIds = ids),
            jumps = jumps,
            connections = vias,
        ) as RoutePlanResult.Rejected

        assertEquals("jump_chain_too_deep", rejected.code)
    }

    @Test
    fun `the depth limit is checked before dependencies are resolved`() {
        // A 20-deep chain must be refused on the limit, not produce a dependency error that hides
        // the real problem.
        val rejected = plan(
            connection(mode = ConnectionMode.JUMP, jumpHostIds = (1..20).map { "missing-" + it }),
        ) as RoutePlanResult.Rejected

        assertEquals("jump_chain_too_deep", rejected.code)
    }

    @Test
    fun `a jump host that no longer resolves is a missing dependency`() {
        val rejected = plan(
            connection(mode = ConnectionMode.JUMP, jumpHostIds = listOf("jump-1")),
        ) as RoutePlanResult.Rejected

        assertEquals("dependency_missing", rejected.code)
    }

    @Test
    fun `a jump host pointing at a deleted connection is a missing dependency`() {
        val rejected = plan(
            connection(mode = ConnectionMode.JUMP, jumpHostIds = listOf("jump-1")),
            jumps = mapOf("jump-1" to jumpHost("jump-1", "deleted-conn")),
        ) as RoutePlanResult.Rejected

        assertEquals("dependency_missing", rejected.code)
        assertTrue(rejected.detail.contains("missing connection"))
    }

    @Test
    fun `a jump host pointing back at the connection being dialled is a cycle`() {
        // Left unchecked this recurses until the socket budget is gone rather than failing.
        val self = connection(id = "conn-1", mode = ConnectionMode.JUMP, jumpHostIds = listOf("jump-1"))
        val rejected = plan(
            self,
            jumps = mapOf("jump-1" to jumpHost("jump-1", "conn-1")),
            connections = mapOf("conn-1" to self),
        ) as RoutePlanResult.Rejected

        assertEquals("jump_cycle", rejected.code)
        assertTrue(rejected.detail.contains("conn-1"))
    }

    @Test
    fun `two jump hosts resolving to the same connection is a cycle`() {
        val via = connection(id = "bastion", host = "bastion.corp")
        val rejected = plan(
            connection(mode = ConnectionMode.JUMP, jumpHostIds = listOf("jump-1", "jump-2")),
            jumps = mapOf(
                "jump-1" to jumpHost("jump-1", "bastion"),
                "jump-2" to jumpHost("jump-2", "bastion"),
            ),
            connections = mapOf("bastion" to via),
        ) as RoutePlanResult.Rejected

        assertEquals("jump_cycle", rejected.code)
    }

    @Test
    fun `a blank target host is refused before anything else`() {
        val rejected = plan(connection(host = "   ")) as RoutePlanResult.Rejected

        assertEquals("invalid_host", rejected.code)
    }

    @Test
    fun `a port outside 1 to 65535 is refused`() {
        assertEquals("invalid_port", (plan(connection(port = 0)) as RoutePlanResult.Rejected).code)
        assertEquals("invalid_port", (plan(connection(port = 65536)) as RoutePlanResult.Rejected).code)
        assertEquals("invalid_port", (plan(connection(port = -1)) as RoutePlanResult.Rejected).code)
        assertTrue(plan(connection(port = 65535)) is RoutePlanResult.Planned)
        assertTrue(plan(connection(port = 1)) is RoutePlanResult.Planned)
    }

    @Test
    fun `a jump host with a blank host is refused`() {
        val rejected = plan(
            connection(mode = ConnectionMode.JUMP, jumpHostIds = listOf("jump-1")),
            jumps = mapOf("jump-1" to jumpHost("jump-1", "bastion")),
            connections = mapOf("bastion" to connection(id = "bastion", host = "")),
        ) as RoutePlanResult.Rejected

        assertEquals("invalid_host", rejected.code)
    }

    @Test
    fun `the target is always the final hop`() {
        val (ids, jumps, vias) = jumpChain(3)
        val jumped = (
            plan(
                connection(mode = ConnectionMode.JUMP, jumpHostIds = ids),
                jumps = jumps,
                connections = vias,
            ) as RoutePlanResult.Planned
            ).route
        val proxied = (
            plan(
                connection(mode = ConnectionMode.PROXY, proxyId = "proxy-1"),
                proxies = mapOf("proxy-1" to proxy()),
            ) as RoutePlanResult.Planned
            ).route

        // route.target casts the last hop, so a planner that appended the target anywhere else
        // would throw here rather than dial the wrong machine.
        assertEquals(RouteHop.Target("10.0.0.5", 22), jumped.target)
        assertEquals(RouteHop.Target("10.0.0.5", 22), proxied.target)
    }
}
