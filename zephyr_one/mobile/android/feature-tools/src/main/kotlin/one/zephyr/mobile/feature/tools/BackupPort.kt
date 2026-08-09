package one.zephyr.mobile.feature.tools

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import one.zephyr.mobile.model.MobileError

/** Progress for one export or import job. */
sealed interface BackupEvent {
    data class Progress(val fraction: Float?) : BackupEvent

    data class Verified(val metadata: BackupPackageMetadata) : BackupEvent

    data object Importing : BackupEvent

    data object Restarting : BackupEvent

    data class Completed(val metadata: BackupPackageMetadata) : BackupEvent

    /**
     * Terminal failure.
     *
     * Carries the structured error rather than a message, because [BackupFlow.classify] maps the code
     * onto the frozen failure set and its data disposition. A pre-formatted string could not be
     * classified.
     */
    data class Failed(val error: MobileError) : BackupEvent
}

/** Credentials for one restore. Held for the duration of the call and never stored. */
class BackupCredentials(
    val loginPassword: CharArray,
    val backupPassword: CharArray,
) {
    /**
     * Identity equality and an opaque toString, written by hand rather than using a data class.
     *
     * A data class would put both passwords into any log line that printed the object, which is the
     * same reason RdpConnectRequest in protocol-rdp does this.
     */
    override fun equals(other: Any?): Boolean = this === other

    override fun hashCode(): Int = System.identityHashCode(this)

    override fun toString(): String = "BackupCredentials(redacted)"

    /** Overwrites both buffers. Callers invoke this in a finally block once the call returns. */
    fun clear() {
        loginPassword.fill('\u0000')
        backupPassword.fill('\u0000')
    }
}

/**
 * The S49 boundary.
 *
 * A port because backup and restore are main-end operations and the frozen mobile v1 surface
 * (contracts/openapi-mobile-v1.json, mirrored in [one.zephyr.mobile.contracts.MobileApiPaths]) publishes
 * no backup endpoint: there is no /api/mobile/v1/backup of any shape. The frozen entity registry does
 * describe backupMetadata, and records its status as "requires-job-and-metadata-layer", so the server
 * job API is still to be defined.
 *
 * Everything above this interface - the disclosure-first export flow, the nine-stage import flow, the
 * six failure codes and their rollback dispositions - is implemented and tested against the port. When
 * the endpoint is published, an adapter implements this and no state machine changes.
 */
interface BackupPort {

    /** False until the main end publishes the backup job API. */
    val isAvailable: Boolean

    /** Scope, algorithm and version for the pre-export disclosure. */
    suspend fun describeExport(): Result<ExportStage.Explain>

    fun export(): Flow<BackupEvent>

    /**
     * Reads package metadata without importing.
     *
     * Separate from [import] because SCREEN_CATALOG.md 24 shows metadata *before* asking for either
     * password: a user must be able to check they picked the right file without typing a credential.
     */
    suspend fun inspect(packageUri: String): Result<BackupPackageMetadata>

    fun import(packageUri: String, credentials: BackupCredentials): Flow<BackupEvent>
}

/**
 * Stands in until the backup job API exists.
 *
 * Fails with a specific code rather than reporting an empty package or a fake digest. A fabricated
 * SHA-256 would be the worst possible outcome here: the user would believe they hold a verified backup.
 */
class UnavailableBackupPort : BackupPort {

    override val isAvailable: Boolean = false

    override suspend fun describeExport(): Result<ExportStage.Explain> = Result.failure(exception())

    override fun export(): Flow<BackupEvent> = flow { emit(BackupEvent.Failed(ENDPOINT_UNAVAILABLE)) }

    override suspend fun inspect(packageUri: String): Result<BackupPackageMetadata> =
        Result.failure(exception())

    override fun import(packageUri: String, credentials: BackupCredentials): Flow<BackupEvent> = flow {
        emit(BackupEvent.Failed(ENDPOINT_UNAVAILABLE))
    }

    private fun exception() = one.zephyr.mobile.model.MobileApiException(ENDPOINT_UNAVAILABLE)

    companion object {
        const val CODE = "backup_endpoint_unavailable"

        val ENDPOINT_UNAVAILABLE: MobileError = MobileError.local(
            code = CODE,
            message = "主端尚未提供备份任务接口，此版本无法导出或导入备份",
            retryable = false,
        )
    }
}