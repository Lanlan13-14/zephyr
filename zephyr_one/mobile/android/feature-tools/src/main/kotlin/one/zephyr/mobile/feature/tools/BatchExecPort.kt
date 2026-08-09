package one.zephyr.mobile.feature.tools

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import one.zephyr.mobile.model.MobileError

/** One dispatch of a command across selected hosts. */
data class BatchRunRequest(
    val runId: String,
    val command: String,
    val timeoutSec: Int,
    val concurrency: Int,
    val failFast: Boolean,
    /** Already filtered by [BatchExecPolicy.plan]; the port does not re-decide capability. */
    val targets: List<BatchTarget>,
)

/**
 * Streamed progress for one run.
 *
 * A stream rather than a suspending call that returns a list: SCREEN_CATALOG.md 16 requires per-host
 * status, output and duration while the run is still going, and a batched return value could not
 * report a host that is still running.
 */
sealed interface BatchEvent {
    data class RunStarted(val runId: String, val at: Long) : BatchEvent

    data class HostStarted(val connectionId: String, val at: Long) : BatchEvent

    /** Incremental output. Appended by the reducer so a long command is not withheld until exit. */
    data class HostOutput(
        val connectionId: String,
        val stdoutChunk: String = "",
        val stderrChunk: String = "",
    ) : BatchEvent

    data class HostFinished(val connectionId: String, val exitCode: Int, val at: Long) : BatchEvent

    data class HostFailed(val connectionId: String, val error: MobileError, val at: Long) : BatchEvent

    data class HostCancelled(val connectionId: String, val at: Long) : BatchEvent

    /**
     * The run as a whole could not proceed.
     *
     * Distinct from every host failing: hosts that were never attempted become
     * [BatchHostStatus.NOT_RUN] rather than FAILED, so the UI does not claim a command ran.
     */
    data class RunFailed(val error: MobileError, val at: Long) : BatchEvent

    data class RunFinished(val at: Long) : BatchEvent
}

/**
 * The batch execution boundary.
 *
 * A port, not an implementation. Remote execution needs an SSH channel per host, and ADR-002 in
 * NATIVE_ENGINE_DECISIONS.md has not chosen between libssh2 and SSHJ/SwiftNIO SSH, so no engine is
 * linked in this build. Everything above this interface - selection, capability gating, timeout and
 * concurrency policy, the per-host state machine and the audit projection - is implemented and
 * tested against the port, and the concrete adapter is wired in the app module when the ADR closes.
 */
interface BatchExecPort {

    /** False until ADR-002 lands. Callers must branch on it rather than assuming a transport. */
    val isAvailable: Boolean

    fun run(request: BatchRunRequest): Flow<BatchEvent>

    suspend fun cancel(runId: String)
}

/**
 * Stands in until ADR-002 exits M0.
 *
 * Emits a single [BatchEvent.RunFailed] with a specific code instead of reporting per-host failures.
 * That distinction is the honest one: nothing was dispatched, so claiming 12 hosts failed would tell
 * the user their command reached 12 machines and was rejected.
 */
class UnavailableBatchExecPort : BatchExecPort {

    override val isAvailable: Boolean = false

    override fun run(request: BatchRunRequest): Flow<BatchEvent> = flow {
        emit(BatchEvent.RunFailed(ENGINE_UNAVAILABLE, 0L))
    }

    override suspend fun cancel(runId: String) = Unit

    companion object {
        const val CODE = "ssh_exec_engine_unavailable"

        val ENGINE_UNAVAILABLE: MobileError = MobileError.local(
            code = CODE,
            message = "SSH 执行引擎在此版本中尚未接入（ADR-002 M0 未关闭），命令没有下发到任何主机",
            retryable = false,
        )
    }
}

/**
 * What a run is allowed to leave behind.
 *
 * SCREEN_CATALOG.md 16 is explicit: command audit keeps truncated metadata only, and neither secrets
 * nor whole stdout may enter core sync. So this record has no stdout or stderr field at all - the
 * rule is enforced by the type, not by remembering to strip them at the call site.
 */
data class BatchAudit(
    val runId: String,
    /** Redacted and truncated to [MAX_COMMAND_PREVIEW] characters. */
    val commandPreview: String,
    /** Full length, so a truncated preview is not mistaken for the whole command. */
    val commandLength: Int,
    val targetCount: Int,
    val deniedCount: Int,
    val succeededCount: Int,
    val failedCount: Int,
    val cancelledCount: Int,
    val skippedCount: Int,
    val notRunCount: Int,
    val concurrency: Int,
    val timeoutSec: Int,
    val failFast: Boolean,
    val startedAt: Long,
    val finishedAt: Long?,
) {
    val wasTruncated: Boolean get() = commandLength > commandPreview.length

    companion object {
        const val MAX_COMMAND_PREVIEW = 200

        fun of(state: BatchRunState, nowMs: Long): BatchAudit {
            val counts = state.results.groupingBy { it.status }.eachCount()
            return BatchAudit(
                runId = state.runId ?: "",
                commandPreview = preview(state.form.command),
                commandLength = state.form.command.length,
                targetCount = state.results.size,
                deniedCount = counts[BatchHostStatus.DENIED] ?: 0,
                succeededCount = counts[BatchHostStatus.SUCCEEDED] ?: 0,
                failedCount = counts[BatchHostStatus.FAILED] ?: 0,
                cancelledCount = counts[BatchHostStatus.CANCELLED] ?: 0,
                skippedCount = counts[BatchHostStatus.SKIPPED] ?: 0,
                notRunCount = counts[BatchHostStatus.NOT_RUN] ?: 0,
                concurrency = state.form.concurrency,
                timeoutSec = state.form.timeoutSec,
                failFast = state.form.failFast,
                startedAt = state.startedAt ?: nowMs,
                finishedAt = state.finishedAt,
            )
        }

        /** Redacts first, then truncates: truncating first could cut a secret in half and keep it. */
        fun preview(command: String): String {
            val redacted = redact(command)
            return if (redacted.length <= MAX_COMMAND_PREVIEW) {
                redacted
            } else {
                redacted.take(MAX_COMMAND_PREVIEW)
            }
        }

        /**
         * Best-effort secret removal for the audit preview.
         *
         * Deliberately conservative and pattern-based: a command line is not parseable without a
         * shell grammar, so this cannot be complete. It is a second line of defence behind the rule
         * that the preview is metadata - the primary protection is that stdout never enters the
         * record at all.
         */
        fun redact(command: String): String {
            var result = command
            for (pattern in SECRET_PATTERNS) {
                result = pattern.replace(result) { match ->
                    match.groupValues[1] + REDACTED
                }
            }
            return result
        }

        const val REDACTED = "***"

        private val SECRET_PATTERNS: List<Regex> = listOf(
            // key=value and key: value forms, e.g. PASSWORD=hunter2, api_key: abc
            Regex("""(?i)((?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key)\s*[=:]\s*)\S+"""),
            // long-option forms, e.g. --password hunter2, --token=abc
            Regex("""(?i)(--(?:password|passwd|token|secret|api-key)[=\s]+)\S+"""),
            // short password option, e.g. mysql -phunter2
            Regex("""(\s-p)(?!\s)\S+"""),
        )
    }
}