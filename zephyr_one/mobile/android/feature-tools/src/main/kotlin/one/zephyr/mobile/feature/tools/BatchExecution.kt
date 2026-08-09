package one.zephyr.mobile.feature.tools

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Residency

/** One candidate host for a batch run. */
data class BatchTarget(
    val connectionId: String,
    val name: String,
    val host: String,
    val protocol: Protocol,
    val capabilities: CapabilitySet,
    val residency: Residency = Residency.OWNED,
) {
    /** SCREEN_CATALOG.md 16: every target needs EXECUTE, and only SSH carries remote execution. */
    val canExecute: Boolean get() = protocol.supportsExec && capabilities.canExecute
}

/**
 * Per-host outcome.
 *
 * Eight states rather than a success flag, because SCREEN_CATALOG.md 16 requires four distinct
 * "did not run" outcomes to be distinguishable: the user was denied, fail-fast stopped it, the user
 * cancelled it, or the engine never started. Collapsing them would leave the user unable to tell a
 * permission problem from an aborted run.
 */
enum class BatchHostStatus {
    PENDING,
    RUNNING,
    SUCCEEDED,
    FAILED,
    /** The user cancelled this host, or the whole run. */
    CANCELLED,
    /** No EXECUTE capability. Never dispatched, and rendered in its own group. */
    DENIED,
    /** fail-fast stopped the run before this host started. */
    SKIPPED,
    /** The run itself could not start, so this host was never attempted. */
    NOT_RUN,
    ;

    val isTerminal: Boolean
        get() = this != PENDING && this != RUNNING

    /** A non-zero exit is a failure of the command, which fail-fast treats the same as an error. */
    val isFailure: Boolean get() = this == FAILED
}

/**
 * One host's result.
 *
 * stdout and stderr are held here for display only. [BatchAudit] is what may be persisted, and it
 * deliberately carries neither.
 */
data class BatchHostResult(
    val target: BatchTarget,
    val status: BatchHostStatus = BatchHostStatus.PENDING,
    val exitCode: Int? = null,
    val stdout: String = "",
    val stderr: String = "",
    val startedAt: Long? = null,
    val finishedAt: Long? = null,
    val error: MobileError? = null,
    /** Reason a host was denied or skipped, so the row can explain itself. */
    val reason: String? = null,
) {
    val durationMs: Long?
        get() {
            val start = startedAt ?: return null
            val end = finishedAt ?: return null
            return end - start
        }

    val isRunnable: Boolean get() = status == BatchHostStatus.PENDING || status == BatchHostStatus.RUNNING
}

/** The form the user fills in. */
data class BatchExecForm(
    val command: String = "",
    val timeoutSec: Int = BatchExecPolicy.DEFAULT_TIMEOUT_SEC,
    val concurrency: Int = BatchExecPolicy.DEFAULT_CONCURRENCY,
    val failFast: Boolean = false,
    val selectedIds: Set<String> = emptySet(),
) {
    fun withTargetToggled(connectionId: String): BatchExecForm =
        copy(
            selectedIds = if (connectionId in selectedIds) {
                selectedIds - connectionId
            } else {
                selectedIds + connectionId
            },
        )
}

/** One validation failure, tied to the field that caused it. */
data class BatchIssue(val field: String, val message: String)

/**
 * Which selected targets will actually be dispatched.
 *
 * Denied targets are separated here rather than filtered away, because SCREEN_CATALOG.md 16 requires
 * them to be shown as their own group: silently dropping a host the user selected would make the
 * result look complete when it was not.
 */
data class BatchPlan(
    val runnable: List<BatchTarget>,
    val denied: List<BatchTarget>,
) {
    val hasRunnable: Boolean get() = runnable.isNotEmpty()
}

/**
 * S41 validation and planning.
 *
 * Pure so the whole matrix is unit testable: this is where the frozen numbers live, and a wrong
 * clamp here would either reject a command Zephyr accepts or dispatch one it refuses.
 */
object BatchExecPolicy {

    /** Frozen by SCREEN_CATALOG.md 16. A value outside this range is a validation error. */
    const val MIN_TIMEOUT_SEC = 1
    const val MAX_TIMEOUT_SEC = 300
    const val DEFAULT_TIMEOUT_SEC = 60

    const val DEFAULT_CONCURRENCY = 4
    const val MIN_CONCURRENCY = 1

    /**
     * Device-side worker ceiling, not a Zephyr limit.
     *
     * Applied as a clamp rather than a rejection: the spec fixes the default at 4 and says nothing
     * about a maximum, so refusing a larger number would reject input the main end accepts. The
     * clamp exists because each worker is a live SSH channel on a phone.
     */
    const val MAX_CONCURRENCY = 16

    fun clampConcurrency(value: Int, targetCount: Int): Int {
        val ceiling = if (targetCount > 0) minOf(MAX_CONCURRENCY, targetCount) else MAX_CONCURRENCY
        return value.coerceIn(MIN_CONCURRENCY, maxOf(MIN_CONCURRENCY, ceiling))
    }

    fun validate(form: BatchExecForm, plan: BatchPlan): List<BatchIssue> = buildList {
        if (form.command.isBlank()) add(BatchIssue(FIELD_COMMAND, MSG_COMMAND_REQUIRED))
        if (form.timeoutSec !in MIN_TIMEOUT_SEC..MAX_TIMEOUT_SEC) {
            add(BatchIssue(FIELD_TIMEOUT, MSG_TIMEOUT_RANGE))
        }
        if (form.selectedIds.isEmpty()) add(BatchIssue(FIELD_TARGETS, MSG_TARGETS_REQUIRED))
        // A selection that is entirely denied is a distinct failure from an empty selection: the
        // remedy is asking the owner for EXECUTE, not picking more hosts.
        else if (!plan.hasRunnable) add(BatchIssue(FIELD_TARGETS, MSG_ALL_DENIED))
    }

    fun plan(available: List<BatchTarget>, form: BatchExecForm): BatchPlan {
        val selected = available.filter { it.connectionId in form.selectedIds }
        return BatchPlan(
            runnable = selected.filter { it.canExecute },
            denied = selected.filterNot { it.canExecute },
        )
    }

    /** Why one host was refused, so the denied group is not a silent list of names. */
    fun denialReason(target: BatchTarget): String = when {
        !target.protocol.supportsExec -> MSG_DENIED_PROTOCOL
        !target.capabilities.canExecute -> MSG_DENIED_CAPABILITY
        else -> MSG_DENIED_CAPABILITY
    }

    const val FIELD_COMMAND = "command"
    const val FIELD_TIMEOUT = "timeoutSec"
    const val FIELD_TARGETS = "targets"

    const val MSG_COMMAND_REQUIRED = "请输入要执行的命令"
    const val MSG_TIMEOUT_RANGE = "超时需在 1 到 300 秒之间"
    const val MSG_TARGETS_REQUIRED = "请选择至少一台目标主机"
    const val MSG_ALL_DENIED = "所选主机都没有执行权限"
    const val MSG_DENIED_CAPABILITY = "你没有此主机的执行权限"
    const val MSG_DENIED_PROTOCOL = "只有 SSH 连接支持远程执行"

    val MISSING_CAPABILITY: Capability = Capability.EXECUTE
}