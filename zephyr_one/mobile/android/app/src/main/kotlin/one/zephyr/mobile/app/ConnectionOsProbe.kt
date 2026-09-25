package one.zephyr.mobile.app

import kotlinx.coroutines.withTimeout
import one.zephyr.mobile.feature.connections.RemoteOsIcon
import one.zephyr.mobile.feature.sessions.TerminalHost
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.Protocol

/**
 * Identifies the remote OS of a connection One just opened and writes the icon back.
 *
 * The main end does this from its own SSH session. One opens its own, so it has to do it too:
 * otherwise a connection created on the phone keeps the placeholder until someone happens to open
 * it on the main end. The write goes through the repository, which is what syncs it back.
 */
internal class ConnectionOsProbe(
    private val host: TerminalHost,
    private val findConnection: suspend (String) -> Connection?,
    private val saveIcon: suspend (Connection, List<String>) -> Unit,
) {
    suspend fun probe(sessionId: String, connection: Connection) {
        if (connection.protocol != Protocol.SSH) return
        if (connection.ephemeral) return
        val stored = findConnection(connection.id) ?: return
        val detected = detect(sessionId) ?: return
        /* A stored icon other than `auto` was either the user's pick or an earlier probe. One
         * cannot tell those apart, and overwriting a pick the user made on the main end would undo
         * it, so only `auto` is replaced here. The editor's test probes a row the user is looking
         * at and applies the stricter rule there. */
        if (stored.icon.isNotBlank() && stored.icon != "auto") return
        val update = RemoteOsIcon.updateFor(stored, detected, manual = false) ?: return
        saveIcon(update.connection, update.mask)
    }

    private suspend fun detect(sessionId: String): String? = runCatching {
        withTimeout(PROBE_TIMEOUT_MS) {
            val output = host.exec(sessionId, RemoteOsIcon.PROBE_COMMAND).getOrNull() ?: return@withTimeout null
            RemoteOsIcon.iconKeyFromProbe(output.stdout.toString(Charsets.UTF_8))
        }
    }.getOrNull()

    private companion object {
        const val PROBE_TIMEOUT_MS = 8_000L
    }
}
