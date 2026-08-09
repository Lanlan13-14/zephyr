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
     * Returns false when the system refused, which happens when the URI did not come from a picker
     * result: the grant to persist has to be one the user just made.
     */
    fun takePersistable(uri: String, allowWrite: Boolean): Boolean

    fun releasePersistable(uri: String)
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
) {

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
        if (!permissions.takePersistable(treeUri, allowWrite = requestWrite)) return null

        val granted = permissions.persisted().firstOrNull { it.uri == treeUri }
        /* takePersistable can succeed while the grant carries no read access, and a share that cannot
         * be read is not a share. Released again rather than left dangling. */
        if (granted == null || !granted.canRead) {
            permissions.releasePersistable(treeUri)
            return null
        }

        val grant = SafShareGrant(
            profileId = profileId,
            shareName = shareName.ifBlank { DEFAULT_SHARE_NAME },
            treeUri = treeUri,
            readOnly = !requestWrite || !granted.canWrite,
            grantValid = true,
        )
        store[profileId] = grant
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
    fun revoke(profileId: String) {
        val stored = store.remove(profileId) ?: return
        /* Only when no other profile still points at the same tree. Two shares over one directory is
         * legal (DEVELOPMENT.md 13.2 allows multiple profiles), and releasing on the first removal
         * would break the second. */
        if (store.values.none { it.treeUri == stored.treeUri }) {
            permissions.releasePersistable(stored.treeUri)
        }
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
        val live = permissions.persisted().filter { it.canRead }.map { it.uri }.toSet()
        val dropped = store.filterValues { it.treeUri !in live }.keys.toList()
        for (profileId in dropped) store.remove(profileId)
        return dropped
    }

    companion object {
        /** Matches RdpDrivePolicy.DEFAULT_SHARE_NAME so both ends label an unnamed share alike. */
        const val DEFAULT_SHARE_NAME = "PHONE"
    }
}
