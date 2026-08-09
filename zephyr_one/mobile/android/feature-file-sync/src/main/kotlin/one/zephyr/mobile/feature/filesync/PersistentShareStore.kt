package one.zephyr.mobile.feature.filesync

/**
 * Durable, device-local storage for the authorised-directory rows.
 *
 * [SafShareGrants] was written against a plain `MutableMap`, which made its lifecycle testable but
 * left every grant in memory: the app would forget which directory the user picked on the next
 * launch, and a SAF permission the app still holds but no longer has a row for is ambient access
 * nobody can see or revoke from the UI. This is the write-through map that closes that gap.
 *
 * ## Why a MutableMap rather than a repository
 *
 * [SafShareGrants] already owns the grant rules -- narrowing a downgraded grant, re-deriving validity
 * from the live permission list, releasing a tree only when no other profile uses it. Persistence is
 * not one of those rules, and threading a store interface through them would let a future change
 * persist a row without going through the narrowing. Overriding the mutators instead means every
 * write the grant logic performs is persisted by construction, and the existing JVM tests keep using
 * an ordinary LinkedHashMap.
 *
 * ## Why one key per field
 *
 * A tree URI is an opaque provider string and a share name is user text. Packing them into one value
 * with a separator would make the encoding a parsing problem, and a share named with the separator
 * would either corrupt the row or have to be silently rewritten. Distinct keys have no delimiter to
 * inject.
 *
 * Nothing here is synced. DEVELOPMENT.md 3 forbids sending a SAF tree URI to another device, because
 * a grant resolved on one device names nothing on another.
 */
class PersistentShareStore(
    private val store: KeyValueStore,
    private val backing: MutableMap<String, SafShareGrant> = LinkedHashMap(),
) : MutableMap<String, SafShareGrant> by backing {

    init {
        backing.putAll(load())
    }

    override fun put(key: String, value: SafShareGrant): SafShareGrant? {
        val previous = backing.put(key, value)
        store.edit {
            putString(uriKey(key), value.treeUri)
            putString(nameKey(key), value.shareName)
            putBoolean(readOnlyKey(key), value.readOnly)
            /* The index is rewritten from the map, not appended to. A row removed and re-added in one
             * session would otherwise leave a duplicate id, and load() would read the same row twice. */
            putStringSet(KEY_PROFILE_IDS, backing.keys.toSet())
        }
        return previous
    }

    override fun putAll(from: Map<out String, SafShareGrant>) {
        for ((key, value) in from) put(key, value)
    }

    override fun remove(key: String): SafShareGrant? {
        val previous = backing.remove(key) ?: return null
        store.edit {
            remove(uriKey(key))
            remove(nameKey(key))
            remove(readOnlyKey(key))
            putStringSet(KEY_PROFILE_IDS, backing.keys.toSet())
        }
        return previous
    }

    override fun clear() {
        val keys = backing.keys.toList()
        backing.clear()
        store.edit {
            for (key in keys) {
                remove(uriKey(key))
                remove(nameKey(key))
                remove(readOnlyKey(key))
            }
            remove(KEY_PROFILE_IDS)
        }
    }

    /**
     * Reads the stored rows back.
     *
     * `grantValid` is deliberately restored as true and never persisted as false. Validity is not a
     * durable property: it is re-derived from the live permission list on every read
     * ([SafShareGrants.grant]), and a persisted false would outlive the condition that caused it --
     * so a share would stay broken after the user re-granted the directory.
     *
     * `readOnly` defaults to true when the key is missing. A row that lost its flag must not be
     * assumed writable: the strictest reading is the safe one, and the next resolution re-derives it
     * from the live grant anyway.
     *
     * A row missing its tree URI is dropped rather than repaired. That only happens if the store was
     * truncated, and a row with no URI cannot address anything.
     */
    private fun load(): Map<String, SafShareGrant> {
        val out = LinkedHashMap<String, SafShareGrant>()
        for (profileId in store.stringSet(KEY_PROFILE_IDS).sorted()) {
            val treeUri = store.string(uriKey(profileId)) ?: continue
            out[profileId] = SafShareGrant(
                profileId = profileId,
                shareName = store.string(nameKey(profileId)) ?: SafShareGrants.DEFAULT_SHARE_NAME,
                treeUri = treeUri,
                readOnly = store.boolean(readOnlyKey(profileId), true),
                grantValid = true,
            )
        }
        return out
    }

    private fun uriKey(profileId: String) = PREFIX + profileId + ".treeUri"

    private fun nameKey(profileId: String) = PREFIX + profileId + ".shareName"

    private fun readOnlyKey(profileId: String) = PREFIX + profileId + ".readOnly"

    companion object {
        /** Preference file name. Device-local; excluded from backup by the manifest. */
        const val PREFERENCES = "zephyr-one-file-sync"

        private const val PREFIX = "share."
        private const val KEY_PROFILE_IDS = "share.profileIds"
    }
}
