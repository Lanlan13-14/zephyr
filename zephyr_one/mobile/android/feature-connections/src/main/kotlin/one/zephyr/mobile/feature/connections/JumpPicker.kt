package one.zephyr.mobile.feature.connections

import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.JumpHost
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Proxy
import one.zephyr.mobile.model.SshKey

/**
 * Snapshot of every route dependency the hop picker and validator need.
 *
 * Held separately from [ConnectionEditorUiState] so an emission that arrives while the editor is
 * still [one.zephyr.mobile.model.PageState.InitialLoading] can be replayed onto the opened form
 * instead of being dropped on the floor.
 */
data class AgentBastionCandidate(
    val agentId: String,
    val label: String,
) {
    val hopId: String get() = "agent:$agentId"
}

internal data class JumpInventory(
    val proxies: List<Proxy> = emptyList(),
    val keys: List<SshKey> = emptyList(),
    val jumps: List<JumpHost> = emptyList(),
    val rows: List<Connection> = emptyList(),
    val agents: List<AgentBastionCandidate> = emptyList(),
)

/**
 * Main-end `jumpConnectionOptions`: every live SSH connection except the one being edited.
 *
 * Capability.USE is required because a hop without USE cannot be authenticated. Owned rows carry
 * the full owner set, so this does not hide the user's own hosts.
 */
internal object JumpPicker {

    fun connections(rows: List<Connection>, editingId: String?): List<Connection> =
        rows.filter { row ->
            row.protocol == Protocol.SSH &&
                !row.isDeleted &&
                row.capabilities.canUse &&
                row.id != editingId
        }

    fun usableIds(
        connections: List<Connection>,
        jumps: List<JumpHost>,
        agents: List<AgentBastionCandidate> = emptyList(),
    ): Set<String> = buildSet {
        addAll(connections.map { it.id })
        addAll(jumps.filter { it.capabilities.canUse && it.deletedAt == null }.map { it.id })
        addAll(agents.map { it.hopId })
    }

    fun labels(
        connections: List<Connection>,
        jumps: List<JumpHost>,
        agents: List<AgentBastionCandidate> = emptyList(),
    ): Map<String, String> = buildMap {
        for (connection in connections) {
            put(
                connection.id,
                connection.name.ifBlank { connection.host } + " · " + connection.host + ":" + connection.port,
            )
        }
        for (host in jumps) {
            put(host.id, host.name)
        }
        for (agent in agents) {
            put(agent.hopId, agent.label)
        }
    }

    fun addable(
        connections: List<Connection>,
        jumps: List<JumpHost>,
        chain: List<String>,
        usableIds: Set<String>,
        agents: List<AgentBastionCandidate> = emptyList(),
    ): List<Pair<String, String>> {
        val names = labels(connections, jumps, agents)
        val seen = mutableSetOf<String>()
        val agentAlready = chain.any { it.startsWith("agent:") }
        return buildList {
            if (!agentAlready) {
                for (agent in agents) {
                    if (agent.hopId !in chain && agent.hopId in usableIds && seen.add(agent.hopId)) {
                        add(agent.hopId to (names[agent.hopId] ?: agent.label))
                    }
                }
            }
            for (connection in connections) {
                if (connection.id !in chain && connection.id in usableIds && seen.add(connection.id)) {
                    add(connection.id to (names[connection.id] ?: connection.host))
                }
            }
            for (host in jumps) {
                if (host.id !in chain && host.id in usableIds && host.connectionId !in chain && seen.add(host.id)) {
                    add(host.id to (names[host.id] ?: host.name))
                }
            }
        }
    }
}

internal fun ConnectionEditorUiState.withJumpInventory(
    snapshot: JumpInventory,
    editingId: String?,
): ConnectionEditorUiState {
    val jumpConnections = JumpPicker.connections(snapshot.rows, editingId)
    return copy(
        inventory = RouteInventory(
            usableProxyIds = snapshot.proxies
                .filter { it.capabilities.canUse && it.deletedAt == null }
                .map { it.id }
                .toSet(),
            usableSshKeyIds = snapshot.keys
                .filter { it.capabilities.canUse && it.deletedAt == null }
                .map { it.id }
                .toSet(),
            usableJumpHostIds = JumpPicker.usableIds(jumpConnections, snapshot.jumps, snapshot.agents),
        ),
        proxies = snapshot.proxies,
        sshKeys = snapshot.keys,
        jumpHosts = snapshot.jumps,
        jumpConnections = jumpConnections,
        agentBastions = snapshot.agents,
    )
}
