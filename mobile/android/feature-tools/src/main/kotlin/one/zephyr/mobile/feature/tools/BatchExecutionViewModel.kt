package one.zephyr.mobile.feature.tools

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import one.zephyr.mobile.data.repository.ConnectionRepository
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.network.NetworkState

/** One-shot outcome the host has to act on rather than render. */
sealed interface BatchEvent {
    /**
     * The user asked to export results.
     *
     * The text is handed out rather than written here: DEVELOPMENT.md 14.5 requires the destination to
     * be the user's own choice, which means the system save picker, which only the host has.
     */
    data class Export(val text: String, val suggestedFileName: String) : BatchEvent
}

/**
 * S41 批量执行.
 *
 * Owns no scheduling rules. The plan is edited here, [BatchScheduler] decides every status transition,
 * [BatchRun] performs the I/O, and this class only connects them to the mirror and the screen. That
 * split is what lets the frozen contract be tested without an SSH engine (SCREEN_CATALOG.md 27.2).
 */
class BatchExecutionViewModel(
    private val connections: ConnectionRepository,
    private val exec: SshExecPort,
    private val audit: BatchAuditSink,
    private val ownerUserId: String,
    network: Flow<NetworkState>,
    private val clock: () -> Long = System::currentTimeMillis,
) : ViewModel() {

    private val planState = MutableStateFlow(BatchPlan())

    private val runState = MutableStateFlow<BatchRunState?>(null)

    private val messages = MutableSharedFlow<String>(extraBufferCapacity = 4)

    private val events = MutableSharedFlow<BatchEvent>(extraBufferCapacity = 2)

    val message: SharedFlow<String> = messages

    val event: SharedFlow<BatchEvent> = events

    /** The live run, or null between runs. Held so cancel can reach it. */
    private var activeRun: BatchRun? = null

    /**
     * Null is the "mirror has not answered yet" sentinel, which is what separates InitialLoading from
     * an empty connection library.
     */
    private val targetsState: StateFlow<List<BatchTarget>?> = connections.observeAll(ownerUserId)
        .map { rows -> BatchStates.targetsFrom(rows) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), null)

    val plan: StateFlow<BatchPlan> = planState.asStateFlow()

    val state: StateFlow<PageState<BatchContent>> = combine(
        targetsState,
        planState,
        runState,
        network,
    ) { targets, currentPlan, run, networkState ->
        BatchStates.derive(
            targets = targets ?: emptyList(),
            plan = currentPlan,
            run = run,
            engineAvailable = exec.isAvailable,
            loaded = targets != null,
            online = networkState.connected,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), PageState.InitialLoading)

    // ---- plan intents --------------------------------------------------------------------------

    fun setCommand(command: String) {
        planState.value = planState.value.copy(command = command)
    }

    /** Clamped on the way in, so the field can never hold a value the run would silently change. */
    fun setTimeout(seconds: Int) {
        planState.value = planState.value.copy(timeoutSeconds = seconds).clamped()
    }

    fun setConcurrency(value: Int) {
        planState.value = planState.value.copy(concurrency = value).clamped()
    }

    fun setFailFast(enabled: Boolean) {
        planState.value = planState.value.copy(failFast = enabled)
    }

    fun toggleTarget(connectionId: String) {
        planState.value = planState.value.withSelectionToggled(connectionId)
    }

    /**
     * Selects everything that can actually run.
     *
     * Denied hosts are deliberately excluded: selecting them would produce a run whose header counts
     * hosts it never attempted, which is the confusion SCREEN_CATALOG.md 16's separate denied list
     * exists to avoid.
     */
    fun selectAllEligible() {
        val eligible = (targetsState.value ?: emptyList()).filter(BatchTargets::isEligible)
        planState.value = planState.value.copy(selectedIds = eligible.map { it.connectionId }.toSet())
    }

    fun clearSelection() {
        planState.value = planState.value.copy(selectedIds = emptySet())
    }

    // ---- run -----------------------------------------------------------------------------------

    /**
     * Starts a run.
     *
     * Refuses rather than queues when a run is already live: two concurrent runs would share the same
     * results surface and the user could not tell which host belonged to which command.
     */
    fun run() {
        if (activeRun != null) {
            messages.tryEmit(MSG_ALREADY_RUNNING)
            return
        }
        val available = targetsState.value ?: emptyList()
        val current = planState.value
        // Checked before validation because a missing engine is the more fundamental refusal, and
        // reporting "请填写命令" to someone whose build has no SSH engine would waste their time.
        if (!exec.isAvailable) {
            messages.tryEmit(MSG_ENGINE_UNAVAILABLE)
            return
        }
        val issues = current.validate(available)
        if (issues.isNotEmpty()) {
            messages.tryEmit(issues.first().message)
            return
        }

        val run = BatchRun(exec = exec, plan = current, available = available, clock = clock)
        activeRun = run
        runState.value = run.state.value

        viewModelScope.launch {
            // Mirrors per-host progress while the run is live. Cancelled afterwards because a
            // StateFlow never completes, so collecting it would outlive the run it belongs to.
            val mirror = launch { run.state.collect { runState.value = it } }
            val finished = run.execute()
            mirror.cancel()
            runState.value = finished
            activeRun = null

            // Metadata only, and never through the sync queue (SCREEN_CATALOG.md 16). A failing sink
            // must not turn a successful run into an error the user cannot act on.
            runCatching { audit.record(BatchAudit.recordOf(finished)) }
            messages.tryEmit(completionMessage(finished))
        }
    }

    fun cancelRun() {
        val run = activeRun ?: return
        viewModelScope.launch { run.cancelAll() }
    }

    fun cancelTarget(connectionId: String) {
        val run = activeRun ?: return
        viewModelScope.launch { run.cancelTarget(connectionId) }
    }

    /** Hands the export text to the host, which owns the system save picker. */
    fun export() {
        val finished = runState.value ?: return
        events.tryEmit(
            BatchEvent.Export(
                text = BatchAudit.exportText(finished),
                suggestedFileName = EXPORT_PREFIX + clock() + EXPORT_SUFFIX,
            ),
        )
    }

    /**
     * Completion wording built from real counts.
     *
     * SCREEN_CATALOG.md 26 requires progress and outcome to be readable entity counts, so this states
     * how many hosts did what instead of a bare "完成". Denied hosts are named separately because they
     * were never attempted.
     */
    private fun completionMessage(state: BatchRunState): String {
        val counts = state.summary
        val base = if (state.stoppedByFailFast) MSG_PREFIX_FAIL_FAST else MSG_PREFIX_DONE
        return buildString {
            append(base)
            append("成功 ").append(counts.succeeded)
            append("，失败 ").append(counts.failed + counts.timedOut)
            if (counts.cancelled > 0) append("，已取消 ").append(counts.cancelled)
            if (counts.denied > 0) append("，无权限 ").append(counts.denied)
        }
    }

    companion object {
        private const val STOP_TIMEOUT_MS = 5_000L

        private const val EXPORT_PREFIX = "zephyr-batch-"
        private const val EXPORT_SUFFIX = ".txt"

        const val MSG_ALREADY_RUNNING = "本次执行尚未结束"
        const val MSG_ENGINE_UNAVAILABLE = "SSH 引擎在此版本中尚未接入，无法执行"
        const val MSG_PREFIX_DONE = "执行结束："
        const val MSG_PREFIX_FAIL_FAST = "已按 fail-fast 中止："

        fun factory(
            connections: ConnectionRepository,
            exec: SshExecPort,
            audit: BatchAuditSink,
            ownerUserId: String,
            network: Flow<NetworkState>,
        ): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = BatchExecutionViewModel(
                connections = connections,
                exec = exec,
                audit = audit,
                ownerUserId = ownerUserId,
                network = network,
            ) as T
        }
    }
}