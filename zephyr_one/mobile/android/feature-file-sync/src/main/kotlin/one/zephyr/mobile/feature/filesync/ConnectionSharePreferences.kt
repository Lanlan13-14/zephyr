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
    ownerId: String = DEFAULT_OWNER_ID,
) {

    private val prefix = "$SCOPED_PREFIX$ownerId."

    init {
        require(ownerId.matches(OWNER_ID_PATTERN)) { "invalid connection share owner id" }
        discardLegacyChoices()
    }

    /** The profile chosen for [connectionId], or null when the user has not chosen one. */
    fun profileFor(connectionId: String): String? =
        store.string(key(connectionId))?.takeIf { it.isNotEmpty() }

    fun choose(connectionId: String, profileId: String) {
        check(store.edit { putString(key(connectionId), profileId) }) {
            "connection share choice could not be persisted"
        }
    }

    /**
     * Forgets the choice for one connection.
     *
     * The grant itself is untouched. Clearing the choice means "ask again", which is what
     * `storageIntent=ask` expects; releasing the directory here would break every other connection
     * pointing at it.
     */
    fun forget(connectionId: String) {
        check(store.edit { remove(key(connectionId)) }) {
            "connection share choice could not be removed"
        }
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
            .filter { it.startsWith(prefix) }
            .mapNotNull { storedKey ->
                val profileId = store.string(storedKey)
                if (profileId != null && profileId in knownProfileIds) {
                    null
                } else {
                    storedKey.removePrefix(prefix)
                }
            }
            .sorted()
        if (dropped.isEmpty()) return emptyList()
        check(
            store.edit {
                for (connectionId in dropped) remove(key(connectionId))
            },
        ) {
            "stale connection share choices could not be removed"
        }
        return dropped
    }

    /** Clears choices belonging to this exact binding generation. */
    fun clearAll(): Boolean {
        val keys = store.keys().filter { it.startsWith(prefix) }
        if (keys.isEmpty()) return true
        return store.edit {
            for (key in keys) remove(key)
        }
    }

    /**
     * Ownerless choices cannot be attributed to the account that happens to initialize first.
     *
     * One atomic deletion is enough for this metadata: if it fails, the legacy keys remain as a
     * retry marker, while [profileFor] still reads only this owner's namespace and therefore fails
     * closed. A later construction retries the deletion.
     */
    private fun discardLegacyChoices() {
        val legacyKeys = store.keys().filter {
            it.startsWith(LEGACY_PREFIX) && !it.startsWith(SCOPED_PREFIX)
        }
        if (legacyKeys.isEmpty()) return
        store.edit {
            for (legacyKey in legacyKeys) remove(legacyKey)
        }
    }

    private fun key(connectionId: String) = prefix + connectionId

    private companion object {
        const val LEGACY_PREFIX = "connection.share."
        const val SCOPED_PREFIX = "connection.share.owner."
        const val DEFAULT_OWNER_ID = "local-test-owner"
        val OWNER_ID_PATTERN = Regex("[A-Za-z0-9_-]{1,128}")
    }
}
