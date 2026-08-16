package one.zephyr.mobile.feature.tools

import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Turns [BatchScheduler] decisions into [SshExecPort] calls.
 *
 * Holds no rules: every status transition goes through the scheduler, so this class cannot disagree
 * with the frozen contract. What it does own is the awkward part of concurrency - starting exactly as
 * many jobs as there are free slots, waking when any one finishes, and guaranteeing that a cancelled
 * job still reaches a terminal status instead of leaving the run stuck at "running".
 *
 * One run per instance. A second run is a new [BatchRun], which keeps the finished results of the
 * previous one intact for the user to read.
 */
class BatchRun(
    private val exec: SshExecPort,
    plan: BatchPlan,
    available: List<BatchTarget>,
    private val clock: () -> Long = System::currentTimeMillis,
) {

    private val mutable = MutableStateFlow(BatchScheduler.begin(plan, available, clock()))

    val state: StateFlow<BatchRunState> = mutable.asStateFlow()

    /**
     * Serialises state transitions.
     *
     * Several hosts finish at once by design, and [BatchScheduler.complete] reads the whole state to
     * decide the fail-fast question. Without this lock two completions could interleave and the
     * second could overwrite the first's fail-fast cancellation.
     */
    private val mutex = Mutex()

    private val jobs = ConcurrentHashMap<String, Job>()

    /**
     * Wakes the dispatch loop.
     *
     * UNLIMITED and never suspends on send: a cancelled job must still be able to signal from its
     * finally block, and an external cancel must be able to wake a loop that has no running jobs
     * left to report.
     */
    private val wake = Channel<Unit>(Channel.UNLIMITED)

    /** Suspends until every target is terminal. Returns the final state. */
    suspend fun execute(): BatchRunState = coroutineScope {
        // A run of nothing but denied hosts is already complete; entering the loop would block on a
        // signal that no job will ever send.
        if (mutable.value.isComplete) return@coroutineScope mutable.value

        while (true) {
            for (target in BatchScheduler.nextDispatch(mutable.value)) {
                mutex.withLock {
                    mutable.value = BatchScheduler.markRunning(mutable.value, target.connectionId, clock())
                }
                jobs[target.connectionId] = launch { runOne(target) }
            }

            if (mutable.value.isComplete) break
            wake.receive()

            // Fail-fast marked the pending hosts; the in-flight ones still have to be stopped.
            if (mutable.value.isStopping) jobs.values.forEach(Job::cancel)
        }

        jobs.clear()
        mutable.value
    }

    /**
     * User cancel for the whole run.
     *
     * Pending hosts become terminal at once. Running hosts are cancelled locally and reported as
     * cancelled once their job unwinds; the far side may still finish the command, which is why the
     * UI wording is "已中止" for this device rather than a claim about the remote process.
     */
    suspend fun cancelAll() {
        mutex.withLock { mutable.value = BatchScheduler.cancelAll(mutable.value, clock()) }
        jobs.values.forEach(Job::cancel)
        // Wakes a loop whose last host was pending: cancelling it produces no job and no signal.
        wake.trySend(Unit)
    }

    /** Cancels one host. The rest of the run continues (SCREEN_CATALOG.md 16). */
    suspend fun cancelTarget(connectionId: String) {
        mutex.withLock { mutable.value = BatchScheduler.cancelTarget(mutable.value, connectionId, clock()) }
        jobs[connectionId]?.cancel()
        wake.trySend(Unit)
    }

    private suspend fun runOne(target: BatchTarget) {
        val plan = mutable.value.plan
        try {
            val outcome = attempt(target, plan)
            mutex.withLock {
                mutable.value = BatchScheduler.complete(mutable.value, target.connectionId, outcome, clock())
            }
        } finally {
            // NonCancellable because this runs on the cancellation path too: without it the state
            // update would be skipped and the target would stay RUNNING forever, so the run could
            // never report completion.
            withContext(NonCancellable) {
                mutex.withLock {
                    val current = mutable.value
                    if (current.stateOf(target.connectionId)?.isTerminal != true) {
                        mutable.value = BatchScheduler.cancelTarget(current, target.connectionId, clock())
                    }
                }
            }
            wake.trySend(Unit)
        }
    }

    /**
     * One exec attempt, with a local deadline behind the port's own.
     *
     * The port is contractually responsible for [BatchPlan.timeoutSeconds]; this wrapper exists
     * because a port that hangs would otherwise hold a concurrency slot for the whole run. The grace
     * margin means a working port reports its own [ExecOutcome.TimedOut] first, and this only fires
     * when the port itself failed to honour the deadline.
     */
    private suspend fun attempt(target: BatchTarget, plan: BatchPlan): ExecOutcome {
        val budgetMs = (plan.timeoutSeconds + CONNECT_BUDGET_SECONDS + WATCHDOG_GRACE_SECONDS) * 1_000L
        return withTimeoutOrNull(budgetMs) {
            exec.exec(
                connectionId = target.connectionId,
                command = plan.command,
                timeoutSeconds = plan.timeoutSeconds + CONNECT_BUDGET_SECONDS,
            )
        } ?: ExecOutcome.TimedOut
    }

    private companion object {
        const val WATCHDOG_GRACE_SECONDS = 5
        /** Extra time so a host that is not already connected can be dialled first. */
        const val CONNECT_BUDGET_SECONDS = 20
    }
}