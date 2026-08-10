package one.zephyr.mobile.feature.tools

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.model.ActionGate
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Residency

/** One candidate host for a batch run. */
data class BatchTarget(
    val connectionId: String,
    val name: String,
    val host: String,
    val port: Int,
    val protocol: Protocol,
    val capabilities: CapabilitySet,
    val residency: Residency = Residency.OWNED,
) {
    /** SCREEN_CATALOG.md 16: every target needs EXECUTE, and only SSH carries remote execution. */
    val canExecute: Boolean get() = protocol.supportsExec && capabilities.canExecute

    /** host:port, for the text export where a structured endpoint is not available. */
    val displayAddress: String get() = host + ":" + port
}

/**
 * Per-host outcome.
 *
 * Seven states rather than a success flag, because SCREEN_CATALOG.md 16 requires the "did not
 * run" outcomes to be distinguishable from each other and from a failed command: the user was
 * denied, the command timed out, or the user cancelled. Collapsing them would leave the user
 * unable to tell a permission problem from an aborted run.
 */
enum class BatchTargetStatus {
    PENDING,
    RUNNING,
    SUCCEEDED,
    FAILED,
    /** The clamped timeout elapsed before the command exited. */
    TIMED_OUT,
    /** The user cancelled this host, or the whole run. */
    CANCELLED,
    /** No EXECUTE capability. Never dispatched, and rendered in its own group. */
    DENIED,
    ;

    val isTerminal: Boolean
        get() = this != PENDING && this != RUNNING

    /** A timeout fails the run the same way a non-zero exit does: fail-fast trips on either. */
    val isFailure: Boolean get() = this == FAILED || this == TIMED_OUT
}

/**
 * One host's run row.
 *
 * stdout and stderr are held here for display only. [BatchAuditRecord] is what may be persisted,
 * and it deliberately carries neither.
 */
data class BatchTargetState(
    val target: BatchTarget,
    val status: BatchTargetStatus = BatchTargetStatus.PENDING,
    val exitCode: Int? = null,
    val stdout: String = "",
    val stderr: String = "",
    val startedAt: Long? = null,
    val finishedAt: Long? = null,
    val error: MobileError? = null,
) {
    val durationMs: Long?
        get() {
            val start = startedAt ?: return null
            val end = finishedAt ?: return null
            return end - start
        }

    val isTerminal: Boolean get() = status.isTerminal

    val isFailure: Boolean get() = status.isFailure
}

/** One validation failure, tied to the field that caused it. */
data class BatchIssue(val field: String, val message: String)

/**
 * What the user asked to run, as the screen edits it.
 *
 * The plan holds the raw form values; [clamped] is applied on the way into a run, so the scheduler
 * only ever sees values inside the frozen ranges. Denied hosts are never filtered out of
 * [selectedIds] here: SCREEN_CATALOG.md 16 requires them to be shown as their own group, and
 * silently dropping a host the user selected would make the result look complete when it was not.
 */
data class BatchPlan(
    val command: String = "",
    val timeoutSeconds: Int = DEFAULT_TIMEOUT_SECONDS,
    val concurrency: Int = DEFAULT_CONCURRENCY,
    val failFast: Boolean = false,
    val selectedIds: Set<String> = emptySet(),
) {

    /**
     * Clamps rather than rejects.
     *
     * The spec fixes the timeout range and the concurrency default but no concurrency maximum, so
     * refusing a larger number would reject input the main end accepts. The ceiling exists because
     * each worker is a live SSH channel on a phone.
     */
    fun clamped(): BatchPlan = copy(
        timeoutSeconds = timeoutSeconds.coerceIn(MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS),
        concurrency = concurrency.coerceIn(MIN_CONCURRENCY, MAX_CONCURRENCY),
    )

    fun withSelectionToggled(connectionId: String): BatchPlan = copy(
        selectedIds = if (connectionId in selectedIds) {
            selectedIds - connectionId
        } else {
            selectedIds + connectionId
        },
    )

    /**
     * S41 validation. Pure so the whole matrix is unit testable.
     *
     * A selection that is entirely denied is a distinct failure from an empty selection: the remedy
     * is asking the owner for EXECUTE, not picking more hosts.
     */
    fun validate(targets: List<BatchTarget>): List<BatchIssue> = buildList {
        if (command.isBlank()) add(BatchIssue(FIELD_COMMAND, MSG_COMMAND_REQUIRED))
        if (timeoutSeconds !in MIN_TIMEOUT_SECONDS..MAX_TIMEOUT_SECONDS) {
            add(BatchIssue(FIELD_TIMEOUT, MSG_TIMEOUT_RANGE))
        }
        if (selectedIds.isEmpty()) {
            add(BatchIssue(FIELD_TARGETS, MSG_TARGETS_REQUIRED))
        } else {
            val selected = targets.filter { it.connectionId in selectedIds }
            if (selected.none(BatchTargets::isEligible)) add(BatchIssue(FIELD_TARGETS, MSG_ALL_DENIED))
        }
    }

    companion object {
        /** Frozen by SCREEN_CATALOG.md 16. A value outside this range is a validation error. */
        const val MIN_TIMEOUT_SECONDS = 1
        const val MAX_TIMEOUT_SECONDS = 300
        const val DEFAULT_TIMEOUT_SECONDS = 60

        const val DEFAULT_CONCURRENCY = 4
        const val MIN_CONCURRENCY = 1

        /** Device-side worker ceiling, not a Zephyr limit. */
        const val MAX_CONCURRENCY = 16

        const val FIELD_COMMAND = "command"
        const val FIELD_TIMEOUT = "timeoutSeconds"
        const val FIELD_CONCURRENCY = "concurrency"
        const val FIELD_TARGETS = "targets"

        const val MSG_COMMAND_REQUIRED = "请输入要执行的命令"
        const val MSG_TIMEOUT_RANGE = "超时需在 1 到 300 秒之间"
        const val MSG_TARGETS_REQUIRED = "请选择至少一台目标主机"
        const val MSG_ALL_DENIED = "所选主机都没有执行权限"
    }
}

/**
 * Whether one target may run a command at all, and why not.
 *
 * The reason travels with the gate so the picker row states the actual cause rather than a generic
 * permission message, and a denied host's checkbox stays disabled: a denied host cannot enter a
 * selection, so a run's counts can never include a host it never attempted.
 */
object BatchTargets {

    fun gate(target: BatchTarget): ActionGate = when {
        !target.protocol.supportsExec -> ActionGate.Disabled(Capability.EXECUTE, REASON_UNSUPPORTED_PROTOCOL)
        !target.capabilities.canExecute -> ActionGate.Disabled(Capability.EXECUTE, REASON_NO_EXECUTE)
        else -> ActionGate.Allowed
    }

    fun isEligible(target: BatchTarget): Boolean = gate(target).isAllowed

    const val REASON_NO_EXECUTE = "你没有此主机的执行权限"
    const val REASON_UNSUPPORTED_PROTOCOL = "只有 SSH 连接支持远程执行"
}
