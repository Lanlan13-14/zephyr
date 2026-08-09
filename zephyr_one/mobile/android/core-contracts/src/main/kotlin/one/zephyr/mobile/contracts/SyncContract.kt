// GENERATED FILE - DO NOT EDIT.
// Source: mobile/contracts. Regenerate with `node mobile/tools/generate.mjs`.

package one.zephyr.mobile.contracts

/** Persisted binding state from SYNC_STATE_MACHINE.md section 1. */
enum class BindingState {
    UNBOUND,
    BOUND_NEEDS_BOOTSTRAP,
    BOOTSTRAPPING,
    CATCHING_UP,
    IDLE,
    RUNNING,
    CONFLICTED,
    REAUTH_REQUIRED,
    REVOKED,
    FATAL_INCOMPATIBLE,
    ;
    val isBound: Boolean get() = this != UNBOUND
    val canRunSync: Boolean get() = when (this) {
        UNBOUND, REVOKED, FATAL_INCOMPATIBLE, REAUTH_REQUIRED -> false
        else -> true
    }
}

/** Runtime phase from SYNC_STATE_MACHINE.md section 2. */
enum class SyncPhase {
    VALIDATE_BINDING,
    RECOVER_BOOTSTRAP,
    BOOTSTRAP_PAGE,
    CATCH_UP_PULL,
    PUSH_PENDING,
    PULL_CHANGES,
    APPLY_BLOBS,
    ACK_CURSOR,
    COMMIT_SUCCESS,
}

enum class SyncAction { UPSERT, DELETE, RESTORE }

enum class PushStatus { ACCEPTED, DUPLICATE, CONFLICT, REJECTED, DEPENDENCY_MISSING }

enum class ConflictResolution {
    USE_SERVER,
    KEEP_LOCAL,
    COPY_AS_NEW,
    MANUAL_MERGE,
}

/** Fixed ACL capability set shared with Zephyr authz.js. */
enum class Capability(val wireName: String) {
    DISCOVER("discover"),
    VIEW("view"),
    USE("use"),
    OBSERVE("observe"),
    CONTROL("control"),
    EXECUTE("execute"),
    FILE_READ("fileRead"),
    FILE_WRITE("fileWrite"),
    EDIT("edit"),
    SHARE("share"),
    DELETE("delete"),
    REVEAL_SECRET("revealSecret"),
    ADMINISTER("administer"),
    ;
    companion object {
        fun fromWire(value: String): Capability? = entries.firstOrNull { it.wireName == value }
    }
}

object SyncContract {
    const val PROTOCOL_VERSION: Int = 1
    const val MAX_OPS_PER_BATCH: Int = 200
    const val MIN_INTERVAL_SEC: Int = 30
    const val MAX_INTERVAL_SEC: Int = 86400
    const val DEFAULT_INTERVAL_SEC: Int = 300
    const val APPLIED_OP_RETENTION_DAYS: Int = 180
    const val TOMBSTONE_RETENTION_DAYS: Int = 180
    const val BOOTSTRAP_PAGE_TOKEN_TTL_MINUTES: Int = 30
    const val BLOB_CHUNK_BYTES: Int = 4 * 1024 * 1024

    /** Android periodic WorkManager cannot run faster than this. */
    const val PERIODIC_WORK_MIN_INTERVAL_SEC: Int = 15 * 60

    val firstBindPhases: List<SyncPhase> = listOf(SyncPhase.VALIDATE_BINDING, SyncPhase.BOOTSTRAP_PAGE, SyncPhase.CATCH_UP_PULL, SyncPhase.PUSH_PENDING, SyncPhase.PULL_CHANGES, SyncPhase.APPLY_BLOBS, SyncPhase.ACK_CURSOR, SyncPhase.COMMIT_SUCCESS)
    val normalPhases: List<SyncPhase> = listOf(SyncPhase.VALIDATE_BINDING, SyncPhase.PUSH_PENDING, SyncPhase.PULL_CHANGES, SyncPhase.APPLY_BLOBS, SyncPhase.ACK_CURSOR, SyncPhase.COMMIT_SUCCESS)

    /** Retry backoff in milliseconds, jittered 0.5x-1.5x by the caller. */
    val retryBackoffMs: List<Long> = listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 60_000L, 900_000L)

    fun clampIntervalSec(value: Int): Int = value.coerceIn(MIN_INTERVAL_SEC, MAX_INTERVAL_SEC)
}
