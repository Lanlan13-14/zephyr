package one.zephyr.mobile.feature.filesync

import java.security.MessageDigest

/** Modes a durable share row still requires from one URI-scoped platform permission. */
internal data class SafPermissionRequirement(
    val canRead: Boolean,
    val canWrite: Boolean,
) {
    fun merge(other: SafPermissionRequirement): SafPermissionRequirement = SafPermissionRequirement(
        canRead = canRead || other.canRead,
        canWrite = canWrite || other.canWrite,
    )
}

/** Durable intent written before `takePersistableUriPermission`. */
internal data class PendingSafAuthorization(
    val profileId: String,
    val treeUri: String,
    val previousCanRead: Boolean,
    val previousCanWrite: Boolean,
)

/**
 * Durable, device-local storage for authorised-directory rows and their take journal.
 *
 * SAF permissions live at application scope, while a Zephyr binding is generation scoped. Every
 * row and pending take is therefore namespaced by [ownerId]. An old teardown can inspect only its
 * own namespace, and a replacement generation cannot inherit the old account's device-bound URI.
 *
 * The pending record is committed before the platform grant is taken. Completing an authorization
 * writes the full row and removes that pending record in one preferences commit. After process death
 * the system can consequently be in only one of two explainable states: a committed row owns the
 * grant, or a durable pending record tells startup which modes must be rolled back.
 */
class PersistentShareStore(
    private val store: KeyValueStore,
    internal val ownerId: String = DEFAULT_OWNER_ID,
    private val backing: MutableMap<String, SafShareGrant> = LinkedHashMap(),
) : MutableMap<String, SafShareGrant> by backing {

    init {
        require(ownerId.matches(OWNER_ID_PATTERN)) { "invalid SAF grant owner id" }
        require(ownerId != LEGACY_QUARANTINE_OWNER_ID) { "reserved SAF grant owner id" }
        quarantineLegacyRowsIfNeeded()
        backing.putAll(load(ownerId))
    }

    /** Commits intent before any system capability is acquired. */
    internal fun prepareAuthorization(
        profileId: String,
        treeUri: String,
        previous: UriGrant?,
    ): Boolean {
        val pendingIds = pendingProfileIds(ownerId) + profileId
        return store.edit {
            putString(pendingUriKey(ownerId, profileId), treeUri)
            putBoolean(pendingReadKey(ownerId, profileId), previous?.canRead == true)
            putBoolean(pendingWriteKey(ownerId, profileId), previous?.canWrite == true)
            putStringSet(pendingIdsKey(ownerId), pendingIds)
            putStringSet(KEY_OWNER_IDS, ownerIds() + ownerId)
        }
    }

    internal fun pendingAuthorizations(): List<PendingSafAuthorization> =
        pendingProfileIds(ownerId).sorted().mapNotNull { profileId ->
            val uri = store.string(pendingUriKey(ownerId, profileId)) ?: return@mapNotNull null
            PendingSafAuthorization(
                profileId = profileId,
                treeUri = uri,
                previousCanRead = store.boolean(pendingReadKey(ownerId, profileId), false),
                previousCanWrite = store.boolean(pendingWriteKey(ownerId, profileId), false),
            )
        }

    internal fun clearPending(profileIds: Set<String>): Boolean {
        if (profileIds.isEmpty()) return true
        val remaining = pendingProfileIds(ownerId) - profileIds
        return store.edit {
            for (profileId in profileIds) removePending(ownerId, profileId)
            if (remaining.isEmpty()) remove(pendingIdsKey(ownerId))
            else putStringSet(pendingIdsKey(ownerId), remaining)
            updateOwnerIndex(ownerId, hasState = backing.isNotEmpty() || remaining.isNotEmpty())
        }
    }

    override fun put(key: String, value: SafShareGrant): SafShareGrant? {
        require(key == value.profileId) { "SAF share key does not match profile id" }
        val previous = backing[key]
        val profileIds = backing.keys + key
        val pendingIds = pendingProfileIds(ownerId) - key
        check(
            store.edit {
                putString(uriKey(ownerId, key), value.treeUri)
                putString(nameKey(ownerId, key), value.shareName)
                putBoolean(readOnlyKey(ownerId, key), value.readOnly)
                putStringSet(profileIdsKey(ownerId), profileIds)
                removePending(ownerId, key)
                if (pendingIds.isEmpty()) remove(pendingIdsKey(ownerId))
                else putStringSet(pendingIdsKey(ownerId), pendingIds)
                putStringSet(KEY_OWNER_IDS, ownerIds() + ownerId)
            },
        ) { "SAF share row could not be persisted" }
        backing[key] = value
        return previous
    }

    override fun putAll(from: Map<out String, SafShareGrant>) {
        for ((key, value) in from) put(key, value)
    }

    override fun remove(key: String): SafShareGrant? {
        val previous = backing[key] ?: return null
        val profileIds = backing.keys - key
        val hasPending = pendingProfileIds(ownerId).isNotEmpty()
        check(
            store.edit {
                remove(uriKey(ownerId, key))
                remove(nameKey(ownerId, key))
                remove(readOnlyKey(ownerId, key))
                if (profileIds.isEmpty()) remove(profileIdsKey(ownerId))
                else putStringSet(profileIdsKey(ownerId), profileIds)
                updateOwnerIndex(ownerId, hasState = profileIds.isNotEmpty() || hasPending)
            },
        ) { "SAF share row could not be removed" }
        backing.remove(key)
        return previous
    }

    override fun clear() {
        check(clearOwner()) { "SAF owner state could not be cleared" }
    }

    /** Clears only this exact binding generation. */
    internal fun clearOwner(): Boolean {
        val ownerPrefix = ownerPrefix(ownerId)
        val success = store.edit {
            for (key in store.keys().filter { it.startsWith(ownerPrefix) }) remove(key)
            putStringSet(KEY_OWNER_IDS, ownerIds() - ownerId)
        }
        if (success) backing.clear()
        return success
    }

    internal fun ownerIds(): Set<String> = store.stringSet(KEY_OWNER_IDS)

    internal fun requirementsForCurrentOwner(): Map<String, SafPermissionRequirement> =
        requirementsFor(ownerId)

    internal fun requirementsForOtherOwners(): Map<String, SafPermissionRequirement> =
        LinkedHashMap<String, SafPermissionRequirement>().also { out ->
            for (otherOwner in ownerIds() - ownerId) {
                for ((uri, requirement) in requirementsFor(otherOwner)) {
                    out[uri] = out[uri]?.merge(requirement) ?: requirement
                }
            }
        }

    internal fun recordedUrisForCurrentOwner(): Set<String> =
        requirementsForCurrentOwner().keys + pendingAuthorizations().map { it.treeUri }

    /**
     * Removes stale namespaces only after their platform modes were reconciled successfully.
     */
    internal fun clearOwners(ownerIdsToClear: Set<String>): Boolean {
        if (ownerIdsToClear.isEmpty()) return true
        require(ownerId !in ownerIdsToClear) { "cannot clear the active SAF owner as stale" }
        val prefixes = ownerIdsToClear.map(::ownerPrefix)
        return store.edit {
            for (key in store.keys().filter { key -> prefixes.any(key::startsWith) }) remove(key)
            putStringSet(KEY_OWNER_IDS, ownerIds() - ownerIdsToClear)
        }
    }

    /**
     * Clears every SAF owner and ownerless migration journal after a package-global capability sweep.
     *
     * This is intentionally separate from [clearOwner], whose generation-scoped semantics must not
     * erase another live account. The caller invokes this only after ContentResolver confirms that no
     * persisted read or write mode remains. One preferences transaction keeps a failed metadata
     * clear replayable without exposing any quarantined row through this owner's [backing].
     */
    internal fun clearAllOwnerState(): Boolean {
        val success = store.edit {
            for (key in store.keys()) {
                if (key.startsWith(PREFIX) || key.startsWith(LEGACY_PREFIX)) remove(key)
            }
            remove(KEY_OWNER_IDS)
        }
        if (success) backing.clear()
        return success
    }

    internal fun recordedUrisFor(owner: String): Set<String> =
        requirementsFor(owner).keys + pendingProfileIds(owner).mapNotNull {
            store.string(pendingUriKey(owner, it))
        }

    private fun requirementsFor(owner: String): Map<String, SafPermissionRequirement> {
        val requirements = LinkedHashMap<String, SafPermissionRequirement>()
        for (grant in load(owner).values) {
            val next = SafPermissionRequirement(canRead = true, canWrite = !grant.readOnly)
            requirements[grant.treeUri] = requirements[grant.treeUri]?.merge(next) ?: next
        }
        return requirements
    }

    private fun load(owner: String): Map<String, SafShareGrant> {
        val out = LinkedHashMap<String, SafShareGrant>()
        for (profileId in profileIds(owner).sorted()) {
            val treeUri = store.string(uriKey(owner, profileId)) ?: continue
            out[profileId] = SafShareGrant(
                profileId = profileId,
                shareName = store.string(nameKey(owner, profileId)) ?: SafShareGrants.DEFAULT_SHARE_NAME,
                treeUri = treeUri,
                readOnly = store.boolean(readOnlyKey(owner, profileId), true),
                grantValid = true,
            )
        }
        return out
    }

    /**
     * Moves ownerless rows to a non-account journal before they can be reconciled.
     *
     * The old format has no account or binding-generation provenance. Assigning it to whichever
     * account happens to start first would let that account inherit another user's directory. The
     * quarantine namespace is deliberately included in the stale-owner index: [SafShareGrants]
     * releases the live read/write modes, then removes this journal only after ContentResolver no
     * longer reports them. A failed preferences commit leaves the original legacy keys as the next
     * startup's journal; neither form is loaded into [backing].
     */
    private fun quarantineLegacyRowsIfNeeded() {
        val legacyKeys = store.keys().filter { it.startsWith(LEGACY_PREFIX) }
        if (legacyKeys.isEmpty()) return
        val legacyIds = LinkedHashSet(store.stringSet(LEGACY_PROFILE_IDS))
        legacyKeys.mapNotNullTo(legacyIds, ::legacyProfileIdFromUriKey)
        val existingQuarantineIds = profileIds(LEGACY_QUARANTINE_OWNER_ID)

        store.edit {
            val quarantinedIds = LinkedHashSet(existingQuarantineIds)
            for (legacyId in legacyIds) {
                val uri = store.string(legacyUriKey(legacyId)) ?: continue
                val journalId = ownerId("legacy-saf", legacyId, uri)
                putString(uriKey(LEGACY_QUARANTINE_OWNER_ID, journalId), uri)
                putString(
                    nameKey(LEGACY_QUARANTINE_OWNER_ID, journalId),
                    store.string(legacyNameKey(legacyId)) ?: SafShareGrants.DEFAULT_SHARE_NAME,
                )
                putBoolean(
                    readOnlyKey(LEGACY_QUARANTINE_OWNER_ID, journalId),
                    store.boolean(legacyReadOnlyKey(legacyId), true),
                )
                quarantinedIds += journalId
            }
            for (legacyKey in legacyKeys) remove(legacyKey)
            if (quarantinedIds.isNotEmpty()) {
                putStringSet(profileIdsKey(LEGACY_QUARANTINE_OWNER_ID), quarantinedIds)
                putStringSet(KEY_OWNER_IDS, ownerIds() + LEGACY_QUARANTINE_OWNER_ID)
            }
        }
    }

    private fun legacyProfileIdFromUriKey(key: String): String? {
        if (!key.startsWith(LEGACY_PREFIX) || !key.endsWith(LEGACY_URI_SUFFIX)) return null
        return key.removePrefix(LEGACY_PREFIX).removeSuffix(LEGACY_URI_SUFFIX).takeIf { it.isNotBlank() }
    }

    private fun KeyValueEditor.removePending(owner: String, profileId: String) {
        remove(pendingUriKey(owner, profileId))
        remove(pendingReadKey(owner, profileId))
        remove(pendingWriteKey(owner, profileId))
    }

    private fun KeyValueEditor.updateOwnerIndex(owner: String, hasState: Boolean) {
        putStringSet(KEY_OWNER_IDS, if (hasState) ownerIds() + owner else ownerIds() - owner)
    }

    private fun profileIds(owner: String): Set<String> = store.stringSet(profileIdsKey(owner))

    private fun pendingProfileIds(owner: String): Set<String> = store.stringSet(pendingIdsKey(owner))

    private fun ownerPrefix(owner: String) = "$PREFIX$owner."
    private fun profilePrefix(owner: String, profileId: String) = ownerPrefix(owner) + "share.$profileId."
    private fun profileIdsKey(owner: String) = ownerPrefix(owner) + "profileIds"
    private fun uriKey(owner: String, profileId: String) = profilePrefix(owner, profileId) + "treeUri"
    private fun nameKey(owner: String, profileId: String) = profilePrefix(owner, profileId) + "shareName"
    private fun readOnlyKey(owner: String, profileId: String) = profilePrefix(owner, profileId) + "readOnly"
    private fun pendingPrefix(owner: String, profileId: String) = ownerPrefix(owner) + "pending.$profileId."
    private fun pendingIdsKey(owner: String) = ownerPrefix(owner) + "pendingIds"
    private fun pendingUriKey(owner: String, profileId: String) = pendingPrefix(owner, profileId) + "treeUri"
    private fun pendingReadKey(owner: String, profileId: String) = pendingPrefix(owner, profileId) + "previousRead"
    private fun pendingWriteKey(owner: String, profileId: String) = pendingPrefix(owner, profileId) + "previousWrite"

    private fun legacyUriKey(profileId: String) = "$LEGACY_PREFIX$profileId.treeUri"
    private fun legacyNameKey(profileId: String) = "$LEGACY_PREFIX$profileId.shareName"
    private fun legacyReadOnlyKey(profileId: String) = "$LEGACY_PREFIX$profileId.readOnly"

    companion object {
        /** Preference file name. Device-local and excluded from backup by the manifest. */
        const val PREFERENCES = "zephyr-one-file-sync"

        private const val PREFIX = "saf.v2.owner."
        private const val KEY_OWNER_IDS = "saf.v2.ownerIds"
        private const val LEGACY_PREFIX = "share."
        private const val LEGACY_PROFILE_IDS = "share.profileIds"
        private const val LEGACY_URI_SUFFIX = ".treeUri"
        private const val LEGACY_QUARANTINE_OWNER_ID = "legacy_unowned_quarantine"
        private const val DEFAULT_OWNER_ID = "local-test-owner"
        private val OWNER_ID_PATTERN = Regex("[A-Za-z0-9_-]{1,128}")

        /** Collision-resistant, delimiter-safe identity for one verified binding generation. */
        fun ownerId(vararg scopeSegments: String): String {
            require(scopeSegments.isNotEmpty() && scopeSegments.all { it.isNotBlank() })
            val digest = MessageDigest.getInstance("SHA-256")
            for (segment in scopeSegments) {
                val bytes = segment.toByteArray(Charsets.UTF_8)
                digest.update(
                    byteArrayOf(
                        (bytes.size ushr 24).toByte(),
                        (bytes.size ushr 16).toByte(),
                        (bytes.size ushr 8).toByte(),
                        bytes.size.toByte(),
                    ),
                )
                digest.update(bytes)
            }
            return digest.digest().joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
        }
    }
}
