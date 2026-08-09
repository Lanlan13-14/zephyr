package one.zephyr.mobile.feature.tools

import one.zephyr.mobile.model.EmptyReason
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.PageState

/** Where a run is in its life cycle. */
enum class BatchRunPhase {
    /** The user is still filling in the form; no run has been dispatched. */
    DRAFT,
    RUNNING,
    /** Every host reached a terminal status. */
    FINISHED,
    /** The run itself never started, so no host was attempted. */
    FAILED,
}

/**
 * The S41 run state.
 *
 * A single immutable value reduced by [BatchRunReducer], because the interesting rules of this screen
 * are transitions rather than rendering: fail-fast must skip the remaining hosts without cancelling
 * the ones already running, and a run that never started must not leave hosts looking like they
 * failed. Both are asserted in unit tests against this type.
 */
data class BatchRunState(
    val runId: String? = null,
    val form: BatchExecForm = BatchExecForm(),
    val phase: BatchRunPhase = BatchRunPhase.DRAFT,
    val results: List<BatchHostResult> = emptyList(),
    val startedAt: Long? = null,
    val finishedAt: Long? = null,
    /** Set only when the run as a whole failed, never for a single host. */
    val runError: MobileError? = null,
    val issues: List<BatchIssue> = emptyList(),
    /** Targets the user may choose from, refreshed from the mirror while the form is open. */
    val available: List<BatchTarget> = emptyList(),
) {

    val plan: BatchPlan get() = BatchExecPolicy.plan(available, form)

    val runnableResults: List<BatchHostResult>
        get() = results.filterNot { it.status == BatchHostStatus.DENIED }

    /** Denied hosts render as their own group (SCREEN_CATALOG.md 16). */
    val deniedResults: List<BatchHostResult>
        get() = results.filter { it.status == BatchHostStatus.DENIED }

    val isRunning: Boolean get() = phase == BatchRunPhase.RUNNING

    val completedCount: Int get() = runnableResults.count { it.status.isTerminal }

    /** Entity counts rather than only a bar, per SCREEN_CATALOG.md 26. */
    val progressLabel: String get() = completedCount.toString() + "/" + runnableResults.size

    val succeededCount: Int get() = results.count { it.status == BatchHostStatus.SUCCEEDED }
    val failedCount: Int get() = results.count { it.status == BatchHostStatus.FAILED }
    val cancelledCount: Int get() = results.count { it.status == BatchHostStatus.CANCELLED }
    val skippedCount: Int get() = results.count { it.status == BatchHostStatus.SKIPPED }
    val notRunCount: Int get() = results.count { it.status == BatchHostStatus.NOT_RUN }

    fun issueFor(field: String): BatchIssue? = issues.firstOrNull { it.field == field }

    fun resultFor(connectionId: String): BatchHostResult? =
        results.firstOrNull { it.target.connectionId == connectionId }

    val canDispatch: Boolean
        get() = phase != BatchRunPhase.RUNNING && BatchExecPolicy.validate(form, plan).isEmpty()
}

/**
 * Pure transitions for one batch run.
 *
 * Separated from the ViewModel so the fail-fast and never-dispatched rules can be tested without a
 * dispatcher, a port or a Looper. Every function returns a new state; nothing here performs I/O.
 */
object BatchRunReducer {

    /**
     * Seeds a run from a validated plan.
     *
     * Denied hosts are seeded as rows so they are visible from the first frame instead of appearing
     * after the run finishes.
     */
    fun start(state: BatchRunState, runId: String, nowMs: Long): BatchRunState {
        val plan = state.plan
        val seeded = plan.runnable.map { BatchHostResult(target = it) } +
            plan.denied.map { target ->
                BatchHostResult(
                    target = target,
                    status = BatchHostStatus.DENIED,
                    reason = BatchExecPolicy.denialReason(target),
                )
            }
        return state.copy(
            runId = runId,
            phase = BatchRunPhase.RUNNING,
            results = seeded,
            startedAt = nowMs,
            finishedAt = null,
            runError = null,
            issues = emptyList(),
        )
    }

    fun reject(state: BatchRunState, issues: List<BatchIssue>): BatchRunState =
        state.copy(issues = issues)

    fun reduce(state: BatchRunState, event: BatchEvent): BatchRunState = when (event) {
        is BatchEvent.RunStarted -> state.copy(
            runId = event.runId,
            phase = BatchRunPhase.RUNNING,
            startedAt = state.startedAt ?: event.at,
        )

        is BatchEvent.HostStarted -> state.mapHost(event.connectionId) { row ->
            row.copy(status = BatchHostStatus.RUNNING, startedAt = event.at)
        }

        is BatchEvent.HostOutput -> state.mapHost(event.connectionId) { row ->
            row.copy(
                stdout = row.stdout + event.stdoutChunk,
                stderr = row.stderr + event.stderrChunk,
            )
        }

        is BatchEvent.HostFinished -> {
            // A non-zero exit is a command failure, which fail-fast treats exactly like an error:
            // the point of fail-fast is to stop on the first bad host, not on the first transport
            // error.
            val failed = event.exitCode != 0
            val updated = state.mapHost(event.connectionId) { row ->
                row.copy(
                    status = if (failed) BatchHostStatus.FAILED else BatchHostStatus.SUCCEEDED,
                    exitCode = event.exitCode,
                    finishedAt = event.at,
                )
            }
            settle(if (failed) updated.applyFailFast() else updated)
        }

        is BatchEvent.HostFailed -> settle(
            state.mapHost(event.connectionId) { row ->
                row.copy(
                    status = BatchHostStatus.FAILED,
                    finishedAt = event.at,
                    error = event.error,
                )
            }.applyFailFast(),
        )

        is BatchEvent.HostCancelled -> settle(
            state.mapHost(event.connectionId) { row ->
                row.copy(status = BatchHostStatus.CANCELLED, finishedAt = event.at)
            },
        )

        // Nothing was dispatched, so hosts become NOT_RUN rather than FAILED: telling the user their
        // command failed on twelve machines would claim it reached them.
        is BatchEvent.RunFailed -> state.copy(
            phase = BatchRunPhase.FAILED,
            runError = event.error,
            finishedAt = event.at,
            results = state.results.map { row ->
                if (row.status.isTerminal) row else row.copy(status = BatchHostStatus.NOT_RUN)
            },
        )

        is BatchEvent.RunFinished -> state.copy(
            phase = BatchRunPhase.FINISHED,
            finishedAt = event.at,
            // Defensive: a port that closes the stream with hosts still pending must not leave them
            // spinning forever.
            results = state.results.map { row ->
                if (row.status.isTerminal) row else row.copy(status = BatchHostStatus.NOT_RUN)
            },
        )
    }

    /**
     * User cancellation.
     *
     * Cancels only what has not finished. A host that already succeeded keeps its result: the user
     * stopped the run, they did not undo the work that completed.
     */
    fun cancelAll(state: BatchRunState, nowMs: Long): BatchRunState = settle(
        state.copy(
            results = state.results.map { row ->
                if (row.status.isTerminal) row else row.copy(status = BatchHostStatus.CANCELLED, finishedAt = nowMs)
            },
        ),
    )

    fun cancelHost(state: BatchRunState, connectionId: String, nowMs: Long): BatchRunState = settle(
        state.mapHost(connectionId) { row ->
            if (row.status.isTerminal) row else row.copy(status = BatchHostStatus.CANCELLED, finishedAt = nowMs)
        },
    )

    /**
     * fail-fast stops what has not started; it never cancels a host that is already running.
     *
     * SCREEN_CATALOG.md 16 requires one failure not to cancel the rest unless fail-fast is on, and
     * even then killing an in-flight command mid-write would be a different, more destructive
     * behaviour than declining to start new ones.
     */
    private fun BatchRunState.applyFailFast(): BatchRunState {
        if (!form.failFast) return this
        return copy(
            results = results.map { row ->
                if (row.status == BatchHostStatus.PENDING) {
                    row.copy(status = BatchHostStatus.SKIPPED, reason = MSG_SKIPPED_FAIL_FAST)
                } else {
                    row
                }
            },
        )
    }

    private fun BatchRunState.mapHost(
        connectionId: String,
        transform: (BatchHostResult) -> BatchHostResult,
    ): BatchRunState = copy(
        results = results.map { row ->
            if (row.target.connectionId == connectionId) transform(row) else row
        },
    )

    /** Moves to FINISHED once no runnable host is left in flight. */
    private fun settle(state: BatchRunState): BatchRunState {
        if (state.phase != BatchRunPhase.RUNNING) return state
        val outstanding = state.results.any { !it.status.isTerminal }
        return if (outstanding) state else state.copy(phase = BatchRunPhase.FINISHED)
    }

    const val MSG_SKIPPED_FAIL_FAST = "fail-fast 已生效，未下发"
}

/**
 * The S41 page state.
 *
 * Renders through the same nine-state contract as every other screen. The target picker being empty
 * is a genuine Empty, not an error: a user with no SSH connection has nothing to batch over yet.
 */
object BatchExecStates {

    fun derive(
        state: BatchRunState,
        loaded: Boolean,
        online: Boolean,
        engineAvailable: Boolean,
        lastSyncedAt: Long? = null,
    ): PageState<BatchRunState> {
        if (!loaded) return PageState.InitialLoading

        // The engine gate is reported as a retryable-shaped error only when it can change; ADR-002 is
        // a build-time gate, so it is fatal for this screen rather than something to retry.
        if (!engineAvailable && state.phase == BatchRunPhase.DRAFT && state.available.isEmpty()) {
            return PageState.FatalIncompatible(UnavailableBatchExecPort.ENGINE_UNAVAILABLE)
        }
        if (state.available.isEmpty()) return PageState.Empty(EmptyReason.NO_DATA)
        if (!online && state.phase == BatchRunPhase.DRAFT) {
            return PageState.OfflineWithCache(state, lastSyncedAt)
        }
        return PageState.Content(value = state)
    }
}