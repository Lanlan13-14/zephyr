package one.zephyr.mobile.feature.tools

import one.zephyr.mobile.model.ActionGate
import one.zephyr.mobile.model.MobileError

/**
 * S41's scheduler, as a pure state machine.
 *
 * Written as transitions over an immutable [BatchRunState] rather than as a coroutine pipeline for one
 * reason: the rules SCREEN_CATALOG.md 16 freezes are all about *what must not happen* — a denied host
 * must never be dispatched, one failure must not cancel the rest, fail-fast must cancel exactly the
 * work that has not started, the concurrency ceiling must hold. Those are properties of a decision
 * table, and asserting them against a table needs no SSH engine and no virtual time.
 *
 * [BatchRunner] is the thin adapter that turns [BatchScheduler.nextDispatch] into calls on
 * [SshExecPort]. It owns no rules of its own.
 */
data class BatchRunState(
    /** Always the clamped plan: [BatchScheduler.begin] is the only constructor. */
    val plan: BatchPlan,
    val targets: List<BatchTargetState>,
    val startedAt: Long? = null,
    val finishedAt: Long? = null,
    /** True once the user pressed 取消; no further dispatch happens. */
    val cancelRequested: Boolean = false,
    /** True once fail-fast tripped, so the UI can say why the remaining hosts never ran. */
    val stoppedByFailFast: Boolean = false,
) {

    fun stateOf(connectionId: String): BatchTargetState? =
        targets.firstOrNull { it.target.connectionId == connectionId }

    val runningCount: Int get() = targets.count { it.status == BatchTargetStatus.RUNNING }

    val pendingCount: Int get() = targets.count { it.status == BatchTargetStatus.PENDING }

    /** Free slots right now. Never negative, even if a caller over-dispatched. */
    val freeSlots: Int get() = (plan.concurrency - runningCount).coerceAtLeast(0)

    /** No dispatch may happen once the user cancelled or fail-fast tripped. */
    val isStopping: Boolean get() = cancelRequested || stoppedByFailFast

    val isComplete: Boolean get() = targets.all { it.isTerminal }

    /**
     * Denied hosts, listed separately.
     *
     * SCREEN_CATALOG.md 16 requires them to be shown apart from the run, because a permissions
     * problem and a failed command need different actions from the user.
     */
    val deniedTargets: List<BatchTargetState>
        get() = targets.filter { it.status == BatchTargetStatus.DENIED }

    /** Targets that were actually dispatched or will be; the run proper. */
    val executableTargets: List<BatchTargetState>
        get() = targets.filter { it.status != BatchTargetStatus.DENIED }

    val summary: BatchSummary
        get() = BatchSummary(
            total = targets.size,
            succeeded = targets.count { it.status == BatchTargetStatus.SUCCEEDED },
            failed = targets.count { it.status == BatchTargetStatus.FAILED },
            timedOut = targets.count { it.status == BatchTargetStatus.TIMED_OUT },
            cancelled = targets.count { it.status == BatchTargetStatus.CANCELLED },
            denied = targets.count { it.status == BatchTargetStatus.DENIED },
            running = runningCount,
            pending = pendingCount,
        )
}

/**
 * Counts for the header.
 *
 * SCREEN_CATALOG.md 26 requires progress to be a readable entity count rather than a bare bar, so the
 * screen renders these numbers and uses [fraction] only to draw the bar beside them.
 */
data class BatchSummary(
    val total: Int,
    val succeeded: Int,
    val failed: Int,
    val timedOut: Int,
    val cancelled: Int,
    val denied: Int,
    val running: Int,
    val pending: Int,
) {
    val finished: Int get() = succeeded + failed + timedOut + cancelled + denied

    val fraction: Float get() = if (total <= 0) 0f else finished.toFloat() / total

    /** Percent as an integer, which is what the accessibility label reads out. */
    val percent: Int get() = (fraction * 100f).toInt()

    val hasFailure: Boolean get() = failed > 0 || timedOut > 0
}

object BatchScheduler {

    /**
     * Builds the initial state.
     *
     * Capability is resolved here, once, and a denied host is put straight into its terminal DENIED
     * state. That ordering is deliberate: a target that never enters PENDING cannot be dispatched by
     * any later bug in [nextDispatch].
     *
     * @param available every host the picker offered. Selection is applied here so a stale id in the
     *   plan (a connection deleted while the sheet was open) simply drops out.
     */
    fun begin(plan: BatchPlan, available: List<BatchTarget>, nowMs: Long): BatchRunState {
        val clamped = plan.clamped()
        val chosen = available.filter { it.connectionId in clamped.selectedIds }
        val states = chosen.map { target ->
            val gate = BatchTargets.gate(target)
            if (gate.isAllowed) {
                BatchTargetState(target = target)
            } else {
                BatchTargetState(
                    target = target,
                    status = BatchTargetStatus.DENIED,
                    error = deniedError(gate),
                    // Denial is instantaneous and never ran, so both stamps are the same instant and
                    // the row reports a 0ms duration rather than a null the UI would have to explain.
                    startedAt = nowMs,
                    finishedAt = nowMs,
                )
            }
        }
        return BatchRunState(plan = clamped, targets = states, startedAt = nowMs)
            .let { if (it.isComplete) it.copy(finishedAt = nowMs) else it }
    }

    /**
     * The hosts the runner should start now.
     *
     * Pure and idempotent: it reads only PENDING count and free slots, so calling it twice without an
     * intervening [markRunning] returns the same list. The runner marks each target running as it
     * launches, which is what makes the concurrency ceiling hold.
     */
    fun nextDispatch(state: BatchRunState): List<BatchTarget> {
        if (state.isStopping) return emptyList()
        val slots = state.freeSlots
        if (slots <= 0) return emptyList()
        return state.targets
            .filter { it.status == BatchTargetStatus.PENDING }
            .take(slots)
            .map { it.target }
    }

    fun markRunning(state: BatchRunState, connectionId: String, nowMs: Long): BatchRunState =
        state.mapTarget(connectionId) { current ->
            // Only a PENDING target may start. Re-marking a running one would reset its clock and
            // understate its duration.
            if (current.status != BatchTargetStatus.PENDING) {
                current
            } else {
                current.copy(status = BatchTargetStatus.RUNNING, startedAt = nowMs)
            }
        }

    /**
     * Applies one finished attempt.
     *
     * The fail-fast branch is the only place a target's fate depends on another target: without it,
     * a failure changes nothing for its siblings, which is the frozen default in SCREEN_CATALOG.md 16.
     */
    fun complete(
        state: BatchRunState,
        connectionId: String,
        outcome: ExecOutcome,
        nowMs: Long,
    ): BatchRunState {
        val applied = state.mapTarget(connectionId) { current ->
            if (current.isTerminal) {
                // A late result for an already-cancelled host must not resurrect it.
                current
            } else {
                when (outcome) {
                    is ExecOutcome.Completed -> current.copy(
                        status = if (outcome.exitCode == 0) {
                            BatchTargetStatus.SUCCEEDED
                        } else {
                            BatchTargetStatus.FAILED
                        },
                        exitCode = outcome.exitCode,
                        stdout = outcome.stdout,
                        stderr = outcome.stderr,
                        finishedAt = nowMs,
                        startedAt = current.startedAt ?: nowMs,
                    )

                    ExecOutcome.TimedOut -> current.copy(
                        status = BatchTargetStatus.TIMED_OUT,
                        finishedAt = nowMs,
                        startedAt = current.startedAt ?: nowMs,
                        error = timeoutError(state.plan.timeoutSeconds),
                    )

                    is ExecOutcome.Failed -> current.copy(
                        status = BatchTargetStatus.FAILED,
                        finishedAt = nowMs,
                        startedAt = current.startedAt ?: nowMs,
                        error = outcome.error,
                    )
                }
            }
        }

        val justFailed = applied.stateOf(connectionId)?.isFailure == true
        val tripped = justFailed && applied.plan.failFast && !applied.stoppedByFailFast
        val afterFailFast = if (tripped) cancelPending(applied, nowMs).copy(stoppedByFailFast = true) else applied
        return afterFailFast.settled(nowMs)
    }

    /**
     * User cancel.
     *
     * Pending hosts are terminal immediately, because nothing has to happen for them to stop. Running
     * hosts stay RUNNING until the runner reports each one through [cancelTarget]: claiming a host was
     * cancelled while its command is still executing on the far side would be a false statement about
     * a production machine.
     */
    fun cancelAll(state: BatchRunState, nowMs: Long): BatchRunState =
        cancelPending(state, nowMs).copy(cancelRequested = true).settled(nowMs)

    /** One host, cancelled on its own. Does not stop the rest and does not set [cancelRequested]. */
    fun cancelTarget(state: BatchRunState, connectionId: String, nowMs: Long): BatchRunState =
        state.mapTarget(connectionId) { current ->
            if (current.isTerminal) {
                current
            } else {
                current.copy(
                    status = BatchTargetStatus.CANCELLED,
                    finishedAt = nowMs,
                    startedAt = current.startedAt ?: nowMs,
                )
            }
        }.settled(nowMs)

    private fun cancelPending(state: BatchRunState, nowMs: Long): BatchRunState = state.copy(
        targets = state.targets.map { current ->
            if (current.status == BatchTargetStatus.PENDING) {
                current.copy(status = BatchTargetStatus.CANCELLED, startedAt = nowMs, finishedAt = nowMs)
            } else {
                current
            }
        },
    )

    private fun BatchRunState.mapTarget(
        connectionId: String,
        transform: (BatchTargetState) -> BatchTargetState,
    ): BatchRunState = copy(
        targets = targets.map { if (it.target.connectionId == connectionId) transform(it) else it },
    )

    /** Stamps the run's own end exactly once, so a re-entrant call cannot move it. */
    private fun BatchRunState.settled(nowMs: Long): BatchRunState =
        if (isComplete && finishedAt == null) copy(finishedAt = nowMs) else this

    /**
     * The reason a denied host was refused.
     *
     * Carries the gate's own reason text so the row states the actual cause rather than a generic
     * permission message. Only ever called for a non-allowed gate; [ActionGate.Disabled] is the
     * shape [BatchTargets.gate] produces, and the fallback covers the other branches exhaustively
     * without an unreachable-looking `when`.
     */
    private fun deniedError(gate: ActionGate): MobileError = MobileError.local(
        code = CODE_CAPABILITY_DENIED,
        message = (gate as? ActionGate.Disabled)?.reason ?: BatchTargets.REASON_NO_EXECUTE,
        retryable = false,
    )

    private fun timeoutError(timeoutSeconds: Int): MobileError = MobileError.local(
        code = CODE_TIMED_OUT,
        message = "命令在 " + timeoutSeconds + " 秒内未结束，已中止",
        // Retryable: a longer timeout or a quieter host may well succeed.
        retryable = true,
    )

    const val CODE_CAPABILITY_DENIED = "capability_denied"
    const val CODE_TIMED_OUT = "exec_timeout"
}
