package one.zephyr.mobile.feature.filesync

/**
 * One authorised directory, as the platform currently reports it.
 *
 * [grantValid] is re-read rather than remembered. A SAF tree grant survives reboots only while it is
 * persisted, and it disappears when the user clears the app data, revokes it in system settings,
 * uninstalls the providing app, or removes the SD card the tree lived on. A share whose grant is gone
 * must fail at the point the drive is mapped, not on the first READ after Windows Explorer has opened
 * a folder (see RdpDrivePolicy, which refuses to map an invalid grant for exactly this reason).
 */
data class SafShareGrant(
    /** Stable id stored on the device-local override, never synced. */
    val profileId: String,
    /** What the remote Windows session sees: PHONE, DOCUMENTS or a user label. */
    val shareName: String,
    /** Opaque tree URI string. Device-bound; DEVELOPMENT.md 3 forbids syncing it. */
    val treeUri: String,
    val readOnly: Boolean,
    val grantValid: Boolean,
)

/** A persisted URI permission as the system reports it. */
data class UriGrant(val uri: String, val canRead: Boolean, val canWrite: Boolean)

/**
 * The platform seam for SAF's persistable-permission API.
 *
 * Separated from [SafShareGrants] so the grant lifecycle -- which grants are taken, when one is
 * released, how a revoked grant is reported -- is unit-testable without a device. The Android
 * implementation is a thin forward to `ContentResolver`.
 */
interface UriPermissionStore {

    /** Every grant this app currently holds persistably. */
    fun persisted(): List<UriGrant>

    /**
     * Persists read (and optionally write) access to [uri].
     *
     * A narrower later request does not release a mode already persisted for the same URI, matching
     * `ContentResolver.takePersistableUriPermission`. Per-profile narrowing remains the caller's
     * responsibility rather than changing this URI-scoped platform grant.
     *
     * Returns false when the system refused, which happens when the URI did not come from a picker
     * result: the grant to persist has to be one the user just made.
     */
    fun takePersistable(uri: String, allowWrite: Boolean): Boolean

    /** Releases exactly the requested persisted modes and reports whether the platform accepted it. */
    fun releasePersistable(
        uri: String,
        releaseRead: Boolean = true,
        releaseWrite: Boolean = true,
    ): Boolean
}

/**
 * Tracks which directories the user has authorised for file sync.
 *
 * The pair this exists to keep honest is (what the user granted) and (what the share config claims).
 * Those drift constantly on Android: the config is durable app state, the grant is revocable system
 * state, and nothing notifies the app when it goes. So every read re-derives validity from
 * [permissions] instead of trusting the stored row, and a share whose grant is gone is reported
 * invalid rather than quietly served as empty.
 *
 * Writes are also narrowed here rather than only in the UI. A tree can be granted read-only, and
 * offering a writable share over a read-only grant produces the corrupted half-copy that
 * DEVELOPMENT.md 13.4 calls out.
 */
class SafShareGrants(
    private val permissions: UriPermissionStore,
    /** Durable share rows. Device-local; nothing here is synced. */
    private val store: MutableMap<String, SafShareGrant> = LinkedHashMap(),
    /** False only for an old-generation teardown, which must not sweep a replacement account. */
    reconcileOnInit: Boolean = true,
) {

    init {
        /* ContentResolver owns the capability and preferences own its account provenance. Reconcile
         * them while constructing a verified account graph, before any drive can be advertised. */
        if (reconcileOnInit) reconcilePersistedPermissions()
    }

    /**
     * Records a directory the user just picked.
     *
     * @param requestWrite what the share config asks for. The result is narrowed to what the system
     *   actually granted: a read-only grant yields a read-only share, never a writable one.
     * @return the stored grant, or null when the system refused to persist the permission -- in which
     *   case nothing is stored, because a share that cannot survive a restart is worse than absent.
     */
    fun authorize(
        profileId: String,
        shareName: String,
        treeUri: String,
        requestWrite: Boolean,
    ): SafShareGrant? {
        reconcilePersistedPermissions()
        val durable = store as? PersistentShareStore
        /* A failed rollback intentionally leaves intent durable. Reusing the same profile id would
         * overwrite the only provenance for that still-held URI and turn it into an orphan. */
        if (durable?.pendingAuthorizations()?.any { it.profileId == profileId } == true) return null
        val previousPermission = permissions.persisted().firstOrNull { it.uri == treeUri }
        if (durable?.prepareAuthorization(profileId, treeUri, previousPermission) == false) return null
        if (!permissions.takePersistable(treeUri, allowWrite = requestWrite)) {
            durable?.clearPending(setOf(profileId))
            return null
        }

        val granted = runCatching {
            permissions.persisted().firstOrNull { it.uri == treeUri }
        }.getOrNull()
        /* takePersistable can succeed while the grant carries no read access, and a share that cannot
         * be read is not a share. Released again rather than left dangling. */
        if (granted == null || !granted.canRead) {
            rollbackAuthorization(profileId)
            return null
        }

        val grant = SafShareGrant(
            profileId = profileId,
            shareName = shareName.ifBlank { DEFAULT_SHARE_NAME },
            treeUri = treeUri,
            readOnly = !requestWrite || !granted.canWrite,
            grantValid = true,
        )
        try {
            store[profileId] = grant
        } catch (_: RuntimeException) {
            /* A false SharedPreferences.commit reaches here through PersistentShareStore. The row is
             * still absent, so reconciliation rolls back only modes no committed row needs. */
            rollbackAuthorization(profileId)
            return null
        }
        /* Replacing a profile can make its previous URI unowned. Enumerating after the committed row
         * ensures a failed release remains observable and is retried on resume. */
        reconcilePersistedPermissions()
        return grant
    }

    /**
     * The stored share with its validity re-derived from the live permission list.
     *
     * Null means no such profile. A profile whose grant is gone still returns a grant, with
     * [SafShareGrant.grantValid] false: the caller needs to tell the user which directory to
     * re-authorise, and it cannot do that from a null.
     */
    fun grant(profileId: String): SafShareGrant? {
        val stored = store[profileId] ?: return null
        val live = permissions.persisted().firstOrNull { it.uri == stored.treeUri }
        return stored.copy(
            grantValid = live != null && live.canRead,
            /* A grant downgraded to read-only after the fact narrows the share. The reverse never
             * widens it: the config's own readOnly stays authoritative when it is stricter. */
            readOnly = stored.readOnly || live == null || !live.canWrite,
        )
    }

    fun all(): List<SafShareGrant> = store.keys.mapNotNull { grant(it) }

    /** Shares that can actually serve right now. */
    fun usable(): List<SafShareGrant> = all().filter { it.grantValid }

    /**
     * Forgets a share and drops its system grant.
     *
     * Releasing matters: a grant left behind keeps the app able to read a directory the user has
     * removed from the app's own list, which is precisely the ambient access SAF exists to avoid.
     */
    fun revoke(profileId: String): Boolean {
        val stored = store.remove(profileId) ?: return true
        /* Only when no other profile still points at the same tree. Two shares over one directory is
         * legal (DEVELOPMENT.md 13.2 allows multiple profiles), and releasing on the first removal
         * would break the second. */
        reconcilePersistedPermissions()
        return permissionConforms(
            permissions.persisted().firstOrNull { it.uri == stored.treeUri },
            currentRequirements()[stored.treeUri],
        )
    }

    /**
     * Drops grants the system no longer reports.
     *
     * Called on foreground resume. DEVELOPMENT.md 13.5 requires the binding and the file-bridge lease
     * to be re-verified before reconnecting; a stale row that survives that check would advertise a
     * share the provider cannot open.
     *
     * @return the profile ids that were dropped, so the UI can name what needs re-authorising.
     */
    fun pruneRevoked(): List<String> {
        reconcilePersistedPermissions()
        val live = permissions.persisted().filter { it.canRead }.map { it.uri }.toSet()
        val dropped = store.filterValues { it.treeUri !in live }.keys.toList()
        for (profileId in dropped) store.remove(profileId)
        return dropped
    }

    /**
     * Reconciles app-wide SAF capabilities to rows owned by this verified binding generation.
     *
     * Every persisted permission belongs to this Android package. When an account graph is active,
     * a permission absent from its rows is therefore an orphan (or stale generation state) and is
     * released. A read-only current row also sheds an unexplained write mode. Failed releases remain
     * visible in ContentResolver and any pending/stale journal remains durable for the next retry.
     */
    fun reconcilePersistedPermissions(): List<String> {
        val durable = store as? PersistentShareStore
        val required = currentRequirements()
        val before = permissions.persisted()

        for (live in before) releaseExcessModes(live, required[live.uri])

        val after = permissions.persisted().associateBy { it.uri }
        durable?.let { persistent ->
            val completedPending = persistent.pendingAuthorizations()
                .filter { pending -> permissionConforms(after[pending.treeUri], required[pending.treeUri]) }
                .map { it.profileId }
                .toSet()
            persistent.clearPending(completedPending)

            val staleOwners = persistent.ownerIds() - persistent.ownerId
            val reconciledOwners = staleOwners.filter { staleOwner ->
                persistent.recordedUrisFor(staleOwner).all { uri ->
                    permissionConforms(after[uri], required[uri])
                }
            }.toSet()
            persistent.clearOwners(reconciledOwners)
        }

        return before.mapNotNull { old ->
            val current = after[old.uri]
            old.uri.takeIf { current != old }
        }.distinct()
    }

    /**
     * Releases this exact owner generation during unbind while preserving modes another recorded
     * generation still needs. Keeping the rows until release succeeds makes teardown replayable.
     */
    fun revokeAllOwned(): Boolean {
        val durable = store as? PersistentShareStore
        val targetUris = durable?.recordedUrisForCurrentOwner().orEmpty().toMutableSet()
        val otherRequirements = durable?.requirementsForOtherOwners().orEmpty()
        if (durable == null || durable.ownerIds().none { it != durable.ownerId }) {
            /* With no competing owner namespace, an unindexed legacy/crash orphan can only belong to
             * this package's sole active account and must be removed too. */
            targetUris += permissions.persisted().map { it.uri }
        }

        for (live in permissions.persisted().filter { it.uri in targetUris }) {
            releaseExcessModes(live, otherRequirements[live.uri])
        }
        val after = permissions.persisted().associateBy { it.uri }
        val released = targetUris.all { uri ->
            permissionConforms(after[uri], otherRequirements[uri])
        }
        if (!released) return false
        return durable?.clearOwner() ?: run {
            store.clear()
            true
        }
    }

    /**
     * Releases every persisted SAF mode during teardown with no active account graph.
     *
     * Unlike [revokeAllOwned], this package-global operation deliberately preserves no owner
     * requirement. In particular, the reserved ownerless quarantine is a cleanup journal, never an
     * account whose URI can remain authorised. Callers must use this only for a true global wipe;
     * generation teardown must continue to use [revokeAllOwned] so another active owner's modes are
     * retained.
     *
     * ContentResolver is re-enumerated before metadata is cleared. A failed or partial platform
     * release returns false and leaves owner/quarantine rows durable for the next startup or global
     * sweep. A failed metadata commit likewise returns false and is safe to retry after the platform
     * capability is already gone.
     */
    fun revokeAllPersistedForGlobalTeardown(): Boolean {
        for (live in permissions.persisted()) releaseExcessModes(live, required = null)

        val capabilityRemains = permissions.persisted().any { it.canRead || it.canWrite }
        if (capabilityRemains) return false

        val durable = store as? PersistentShareStore
        return durable?.clearAllOwnerState() ?: run {
            store.clear()
            true
        }
    }

    private fun rollbackAuthorization(profileId: String) {
        /* The durable pending record remains until ContentResolver actually reflects the rollback.
         * This also preserves a pre-existing mode still required by another committed profile. */
        reconcilePersistedPermissions()
        val durable = store as? PersistentShareStore ?: return
        val pending = durable.pendingAuthorizations().firstOrNull { it.profileId == profileId } ?: return
        val required = currentRequirements()[pending.treeUri]
        if (permissionConforms(permissions.persisted().firstOrNull { it.uri == pending.treeUri }, required)) {
            durable.clearPending(setOf(profileId))
        }
    }

    private fun currentRequirements(): Map<String, SafPermissionRequirement> {
        val durable = store as? PersistentShareStore
        if (durable != null) return durable.requirementsForCurrentOwner()
        val out = LinkedHashMap<String, SafPermissionRequirement>()
        for (grant in store.values) {
            val next = SafPermissionRequirement(canRead = true, canWrite = !grant.readOnly)
            out[grant.treeUri] = out[grant.treeUri]?.merge(next) ?: next
        }
        return out
    }

    private fun releaseExcessModes(live: UriGrant, required: SafPermissionRequirement?) {
        val releaseRead = live.canRead && required?.canRead != true
        val releaseWrite = live.canWrite && required?.canWrite != true
        if (releaseRead || releaseWrite) {
            permissions.releasePersistable(
                uri = live.uri,
                releaseRead = releaseRead,
                releaseWrite = releaseWrite,
            )
        }
    }

    private fun permissionConforms(
        live: UriGrant?,
        required: SafPermissionRequirement?,
    ): Boolean {
        if (required == null) return live == null || (!live.canRead && !live.canWrite)
        if (live == null) return true // Revocation is fail-closed; the row will be pruned separately.
        if (!required.canWrite && live.canWrite) return false
        return true
    }

    companion object {
        /** Matches RdpDrivePolicy.DEFAULT_SHARE_NAME so both ends label an unnamed share alike. */
        const val DEFAULT_SHARE_NAME = "PHONE"
    }
}
