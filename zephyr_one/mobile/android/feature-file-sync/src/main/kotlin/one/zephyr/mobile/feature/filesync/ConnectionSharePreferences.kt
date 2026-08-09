package one.zephyr.mobile.feature.filesync

/**
 * Which authorised directory each connection uses.
 *
 * Device-local by contract, not by convenience. DEVELOPMENT.md 13.2 keeps the directory *intent*
 * (`off` / `ask` / `local_share` / `server_bridge`) on the synced connection and the chosen profile id
 * on the device, because a profile id names a SAF grant that exists on exactly one device. Syncing it
 * would give the other device a row pointing at a tree URI it cannot resolve, and the share would
 * fail on first read rather than ask to be re-authorised.
 *
 * Separate from [PersistentShareStore] because the two answer different questions and have different
 * lifetimes: a grant outlives every connection that used it, and forgetting a connection must not
 * release a directory another connection still shares.
 */
class ConnectionSharePreferences(
    private val store: KeyValueStore,
) {

    /** The profile chosen for [connectionId], or null when the user has not chosen one. */
    fun profileFor(connectionId: String): String? =
        store.string(key(connectionId))?.takeIf { it.isNotEmpty() }

    fun choose(connectionId: String, profileId: String) {
        store.edit { putString(key(connectionId), profileId) }
    }

    /**
     * Forgets the choice for one connection.
     *
     * The grant itself is untouched. Clearing the choice means "ask again", which is what
     * `storageIntent=ask` expects; releasing the directory here would break every other connection
     * pointing at it.
     */
    fun forget(connectionId: String) {
        store.edit { remove(key(connectionId)) }
    }

    /**
     * Drops choices that name a profile which no longer exists.
     *
     * Called after a grant is revoked or pruned. A dangling choice is worse than no choice: the
     * coordinator resolves it to null and the session reports "no directory is authorised" while the
     * connection editor still shows a directory as selected.
     *
     * @return the connection ids whose choice was dropped.
     */
    fun pruneMissing(knownProfileIds: Set<String>): List<String> {
        val dropped = store.keys()
            .filter { it.startsWith(PREFIX) }
            .mapNotNull { storedKey ->
                val profileId = store.string(storedKey)
                if (profileId != null && profileId in knownProfileIds) {
                    null
                } else {
                    storedKey.removePrefix(PREFIX)
                }
            }
            .sorted()
        if (dropped.isEmpty()) return emptyList()
        store.edit {
            for (connectionId in dropped) remove(key(connectionId))
        }
        return dropped
    }

    private fun key(connectionId: String) = PREFIX + connectionId

    private companion object {
        const val PREFIX = "connection.share."
    }
}
