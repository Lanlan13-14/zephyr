package one.zephyr.mobile.app.session

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import one.zephyr.mobile.data.session.SessionRegistry
import one.zephyr.mobile.data.session.SessionSnapshot
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Residency

/**
 * Persists the 会话 list across process death.
 *
 * Only what [SessionSnapshot] carries: an id, a protocol and an endpoint. No credential, no
 * capability set and no residency, because those are re-resolved from the mirror at restore time -
 * a capability persisted here would outlive an ACL change and re-open a session the server has since
 * revoked. [SessionRegistry.restore] takes the resolvers for exactly that reason.
 *
 * Sessions restore as history rather than as live transports: the process died, so every socket died
 * with it. Restoring them as live would show a connected session that cannot carry a keystroke.
 */
class WorkspaceStatePersistence(context: Context) {

    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    /** Mirrors [SessionSnapshot] rather than serialising it, so a model change cannot silently
     * repurpose a stored field: this class fails to compile instead. */
    @Serializable
    private data class StoredSession(
        val sessionId: String,
        val connectionId: String,
        val protocol: String,
        val name: String,
        val host: String,
        val port: Int,
        val startedAt: Long,
        val endedAt: Long?,
    )

    fun save(registry: SessionRegistry) {
        val stored = registry.snapshot().map {
            StoredSession(
                sessionId = it.sessionId,
                connectionId = it.connectionId,
                protocol = it.protocol.wireName,
                name = it.name,
                host = it.host,
                port = it.port,
                startedAt = it.startedAt,
                endedAt = it.endedAt,
            )
        }
        prefs.edit().putString(KEY_SESSIONS, json.encodeToString(stored)).apply()
    }

    /**
     * @param capabilitiesFor resolved from the live mirror. Returning null drops the session, which
     *   is the correct outcome for a connection that was deleted or unshared while One was dead.
     */
    fun restore(
        registry: SessionRegistry,
        capabilitiesFor: (String) -> CapabilitySet?,
        residencyFor: (String) -> Residency = { Residency.OWNED },
    ) {
        val raw = prefs.getString(KEY_SESSIONS, null) ?: return
        val stored = runCatching { json.decodeFromString<List<StoredSession>>(raw) }.getOrNull()
        if (stored == null) {
            // A payload written by an older build is dropped rather than partially applied: a session
            // list is a convenience, and half a restored workspace is worse than an empty one.
            prefs.edit().remove(KEY_SESSIONS).apply()
            return
        }

        val snapshots = stored.mapNotNull { row ->
            val protocol = Protocol.fromWire(row.protocol) ?: return@mapNotNull null
            SessionSnapshot(
                sessionId = row.sessionId,
                connectionId = row.connectionId,
                protocol = protocol,
                name = row.name,
                host = row.host,
                port = row.port,
                startedAt = row.startedAt,
                endedAt = row.endedAt,
            )
        }
        registry.restore(snapshots, capabilitiesFor, residencyFor)
    }

    fun clear() {
        prefs.edit().remove(KEY_SESSIONS).apply()
    }

    private companion object {
        const val PREFS = "zephyr-one-workspace"
        const val KEY_SESSIONS = "sessions"
    }
}
