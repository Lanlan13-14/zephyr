package one.zephyr.mobile.feature.tools

import one.zephyr.mobile.model.MobileError

/**
 * What a restore did to the data that was already on the server.
 *
 * SCREEN_CATALOG.md 24 requires every failure to state explicitly whether the original data was
 * rolled back or never touched. Modelling it as a type rather than a sentence in a message means a
 * failure cannot be reported without answering the question.
 */
enum class DataDisposition {
    /** The failure happened before the server wrote anything. The original data is intact. */
    UNTOUCHED,

    /** The import had begun and the server reverted it. The original data is intact. */
    ROLLED_BACK,

    /**
     * The import committed but the service did not come back.
     *
     * Neither "rolled back" nor "untouched" is true here, and saying either would be a lie: the new
     * data is in place and the server is down. This is the state that needs an operator, so it is
     * distinguishable rather than folded into ROLLED_BACK.
     */
    IMPORTED_SERVICE_DOWN,

    /** The outcome is genuinely unknown, e.g. the connection dropped mid-import. */
    UNKNOWN,
    ;

    val originalDataIntact: Boolean get() = this == UNTOUCHED || this == ROLLED_BACK
}

/**
 * The six S49 import failures.
 *
 * Enumerated because each one has a different remedy and a different [DataDisposition]; a single
 * "import failed" would leave the user unable to tell "retype the password" from "the server is down
 * with your new data half-loaded".
 */
enum class ImportFailure(val code: String, val disposition: DataDisposition) {
    /** Login password or backup password rejected. Verification only, nothing written. */
    WRONG_PASSWORD("backup_password_invalid", DataDisposition.UNTOUCHED),

    /** Archive truncated, or its checksum does not match. Rejected before import. */
    CORRUPT_PACKAGE("backup_package_corrupt", DataDisposition.UNTOUCHED),

    /** A required database is absent from the package. Rejected before import. */
    MISSING_DATABASE("backup_database_missing", DataDisposition.UNTOUCHED),

    /** The package was sealed with a different key than this server holds. Rejected before import. */
    KEY_MISMATCH("backup_key_mismatch", DataDisposition.UNTOUCHED),

    /** Schema migration failed part-way. The server reverts to the pre-import snapshot. */
    MIGRATION_FAILURE("backup_migration_failed", DataDisposition.ROLLED_BACK),

    /** Data imported, service failed to restart. Needs operator attention on the main end. */
    RESTART_FAILURE("backup_restart_failed", DataDisposition.IMPORTED_SERVICE_DOWN),
    ;

    companion object {
        fun fromCode(code: String?): ImportFailure? = entries.firstOrNull { it.code == code }
    }
}

/**
 * Metadata for one backup package.
 *
 * Mirrors the serverAuthority fields the frozen registry lists on backupMetadata: One reports what
 * the server computed and never derives a hash or a size of its own.
 */
data class BackupPackageMetadata(
    val backupId: String,
    val sha256: String,
    val sizeBytes: Long,
    val createdAt: Long,
    val appVersion: String,
    val encryptionAlgorithm: String,
    /** Entity types the package covers, so the export screen can state its scope up front. */
    val scope: List<String> = emptyList(),
) {
    val hasDigest: Boolean get() = sha256.isNotBlank()
}

/**
 * S49 export, as a state machine.
 *
 * The first state is the explanation rather than a progress bar: SCREEN_CATALOG.md 24 requires scope,
 * algorithm and version to be stated *before* generating, so an export cannot start from a bare
 * button.
 */
sealed interface ExportStage {
    /** Scope / algorithm / version disclosure. The only state a generate action may start from. */
    data class Explain(
        val scope: List<String>,
        val encryptionAlgorithm: String,
        val formatVersion: Int,
    ) : ExportStage

    data object Generating : ExportStage

    /** Server finished. The digest, size and time are shown before any save location is chosen. */
    data class Ready(val metadata: BackupPackageMetadata) : ExportStage

    /** The user picked a system save location and the bytes were written there. */
    data class Saved(val metadata: BackupPackageMetadata, val locationLabel: String) : ExportStage

    data class Failed(val error: MobileError) : ExportStage

    val canGenerate: Boolean get() = this is Explain || this is Failed
}

/**
 * S49 import, as a state machine.
 *
 * Ordered exactly as the frozen flow: file pick, metadata, credentials, impact confirmation, upload,
 * server verification, import, restart, rebind notice. Each stage is a separate state because each one
 * is a place the user may abandon the flow, and because the failure disposition depends on which one
 * failed.
 */
sealed interface ImportStage {
    data object PickFile : ImportStage

    /** Package metadata read back from the server before any credential is collected. */
    data class ReviewMetadata(val metadata: BackupPackageMetadata) : ImportStage

    /**
     * Current login password plus backup password.
     *
     * Two separate secrets: the login password proves who is asking, the backup password unseals the
     * package. Neither is ever stored, which is why they live in transient screen state and never in a
     * draft that could be persisted.
     */
    data class Credentials(
        val metadata: BackupPackageMetadata,
        val loginPasswordEntered: Boolean = false,
        val backupPasswordEntered: Boolean = false,
    ) : ImportStage {
        val canContinue: Boolean get() = loginPasswordEntered && backupPasswordEntered
    }

    /** What the import will overwrite. Explicit, per SCREEN_CATALOG.md 24. */
    data class ConfirmImpact(
        val metadata: BackupPackageMetadata,
        val affectedScopes: List<String>,
        val acknowledged: Boolean = false,
    ) : ImportStage

    data class Uploading(val fraction: Float?) : ImportStage

    data object Verifying : ImportStage

    data object Importing : ImportStage

    data object Restarting : ImportStage

    /**
     * Success.
     *
     * A restore bumps the main end's data epoch, which invalidates every cursor and credential, so
     * every One device must re-bind and bootstrap again. Stating that is part of the success state
     * rather than an afterthought.
     */
    data class RebindRequired(val metadata: BackupPackageMetadata) : ImportStage

    data class Failed(val failure: ImportFailure, val error: MobileError) : ImportStage
}

/**
 * S49 flow arithmetic.
 *
 * Pure so the whole ordering, the failure-to-disposition mapping and the "may I go back" rule are unit
 * testable without a server. The disposition mapping is the part that matters most: it is the sentence
 * the user reads after a failed restore.
 */
object BackupFlow {

    /** Format version One writes into the export disclosure. */
    const val FORMAT_VERSION = 1

    /**
     * Stages a user may still cancel out of without consequence.
     *
     * Once the server has begun importing there is nothing local to cancel, so the UI must stop
     * offering a cancel that would do nothing.
     */
    fun canAbandon(stage: ImportStage): Boolean = when (stage) {
        is ImportStage.PickFile,
        is ImportStage.ReviewMetadata,
        is ImportStage.Credentials,
        is ImportStage.ConfirmImpact,
        is ImportStage.Failed,
        -> true
        is ImportStage.Uploading -> true
        is ImportStage.Verifying,
        is ImportStage.Importing,
        is ImportStage.Restarting,
        is ImportStage.RebindRequired,
        -> false
    }

    /** True once the server may have written data, which is what the disposition text depends on. */
    fun hasServerCommitted(stage: ImportStage): Boolean = when (stage) {
        is ImportStage.Importing, is ImportStage.Restarting, is ImportStage.RebindRequired -> true
        else -> false
    }

    /**
     * Maps a structured error onto the frozen failure set.
     *
     * An unrecognised code becomes a failure whose disposition is UNKNOWN rather than being guessed as
     * UNTOUCHED: claiming the original data is intact when the server did not say so is exactly the
     * reassurance SCREEN_CATALOG.md 24 forbids.
     */
    fun classify(error: MobileError, stage: ImportStage): ImportFailureOutcome {
        val known = ImportFailure.fromCode(error.code)
        if (known != null) return ImportFailureOutcome(known, known.disposition, error)
        val disposition = if (hasServerCommitted(stage)) DataDisposition.UNKNOWN else DataDisposition.UNTOUCHED
        return ImportFailureOutcome(failure = null, disposition = disposition, error = error)
    }

    /** Scopes a restore replaces, for the impact confirmation. */
    fun affectedScopes(metadata: BackupPackageMetadata): List<String> = metadata.scope

    /** Ordered stage index, for a progress readout that is a count rather than a spinner. */
    fun stageIndex(stage: ImportStage): Int = when (stage) {
        is ImportStage.PickFile -> 0
        is ImportStage.ReviewMetadata -> 1
        is ImportStage.Credentials -> 2
        is ImportStage.ConfirmImpact -> 3
        is ImportStage.Uploading -> 4
        is ImportStage.Verifying -> 5
        is ImportStage.Importing -> 6
        is ImportStage.Restarting -> 7
        is ImportStage.RebindRequired -> 8
        is ImportStage.Failed -> -1
    }

    const val TOTAL_STAGES = 9
}

/**
 * A classified import failure.
 *
 * [failure] is null for an unrecognised code, which is why [disposition] is carried separately rather
 * than only being read from the enum: the honest answer for an unknown code depends on how far the
 * flow had progressed.
 */
data class ImportFailureOutcome(
    val failure: ImportFailure?,
    val disposition: DataDisposition,
    val error: MobileError,
) {
    val isKnown: Boolean get() = failure != null
}