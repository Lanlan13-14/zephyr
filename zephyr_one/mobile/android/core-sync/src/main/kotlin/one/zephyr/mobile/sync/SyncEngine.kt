package one.zephyr.mobile.sync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.contracts.ConflictResolution
import one.zephyr.mobile.contracts.SyncContract
import one.zephyr.mobile.data.repository.ConflictRepository
import one.zephyr.mobile.data.repository.SyncStateRepository
import one.zephyr.mobile.model.ConflictRecord
import one.zephyr.mobile.model.NetworkPolicy
import one.zephyr.mobile.model.SyncStatus
import one.zephyr.mobile.model.SyncTrigger
import one.zephyr.mobile.model.sync.BindingStateMachine
import one.zephyr.mobile.network.NetworkMonitor

/** User-controlled sync settings, owned by the settings screen and observed here. */
data class SyncSettings(
    val automaticEnabled: Boolean,
    val intervalSec: Int,
    val networkPolicy: NetworkPolicy,
) {
    val clampedIntervalSec: Int get() = SyncContract.clampIntervalSec(intervalSec)

    /** True when the background scheduler cannot deliver the requested cadence. */
    val isForegroundOnlyInterval: Boolean get() = SyncScheduler.isForegroundOnly(intervalSec)
}

/**
 * The single entry point the UI and the worker use for sync.
 *
 * Everything that decides *when* to run lives here; everything that decides *what* a round does
 * lives in [SyncActor]. That split is what lets the round be tested without a scheduler and the
 * triggers be reasoned about without replaying a whole round.
 *
 * The trigger set is taken from SYNC_STATE_MACHINE.md 9: app foreground, bind completion, manual
 * tap, interval, network restoration, local write debounce and a server wake.
 */
class SyncEngine(
    private val actor: SyncActor,
    private val syncState: SyncStateRepository,
    private val conflicts: ConflictRepository,
    private val scheduler: SyncScheduler,
    private val networkMonitor: NetworkMonitor,
    private val bindingKey: String,
    private val settings: StateFlow<SyncSettings>,
    private val localWriteSignals: SharedFlow<Unit>,
    private val writeDebounceMs: Long = DEFAULT_WRITE_DEBOUNCE_MS,
) {

    private val lastRound = MutableStateFlow<SyncRoundResult?>(null)

    /** Most recent round outcome, for the diagnostics row on the 文件同步 card. */
    val lastRoundResult: StateFlow<SyncRoundResult?> = lastRound.asStateFlow()

    val status: Flow<SyncStatus>
        get() = combine(
            syncState.observeStatus(
                bindingKey = bindingKey,
                automaticEnabled = settings.value.automaticEnabled,
                targetIntervalSec = settings.value.clampedIntervalSec,
                policy = settings.value.networkPolicy,
                progress = actor.progress,
            ),
            settings,
        ) { status, current ->
            status.copy(
                automaticEnabled = current.automaticEnabled,
                targetIntervalSec = current.clampedIntervalSec,
                networkPolicy = current.networkPolicy,
            )
        }

    val conflictRecords: Flow<List<ConflictRecord>> get() = conflicts.observeAll()

    val bindingState: Flow<BindingState> get() = syncState.observeBindingState(bindingKey)

    /**
     * Manual "立即同步".
     *
     * Runs in-process instead of through WorkManager so the button is responsive and so the round is
     * subject to the actor's coalescing. It deliberately ignores the wifiOnly policy: a
     * non-functional manual sync on a metered link is a release blocker (PRODUCT_REQUIREMENTS.md 12).
     */
    suspend fun syncNow(): List<SyncRoundResult> = run(SyncTrigger.MANUAL, respectPolicy = false)

    suspend fun onBindComplete(): List<SyncRoundResult> = run(SyncTrigger.BIND_COMPLETE, respectPolicy = false)

    suspend fun onServerWake(): List<SyncRoundResult> = run(SyncTrigger.SERVER_WAKE, respectPolicy = true)

    /** Entry point for the WorkManager worker. */
    suspend fun runScheduledRound(): List<SyncRoundResult> = run(SyncTrigger.INTERVAL, respectPolicy = true)

    suspend fun resolveConflict(conflictId: String, resolution: ConflictResolution): String? {
        val opId = conflicts.resolve(conflictId, resolution)
        // A resolution is a local write, so it needs a round to reach the server; without this the
        // conflict centre would appear to succeed while nothing was pushed.
        if (conflicts.count() == 0) {
            syncState.updateState(bindingKey, BindingState.IDLE)
        }
        run(SyncTrigger.LOCAL_WRITE_DEBOUNCE, respectPolicy = true)
        return opId
    }

    /**
     * Installs the automatic triggers. Cancelling [scope] removes all of them.
     *
     * The foreground ticker exists only for sub-15-minute intervals; above that the periodic job is
     * authoritative and a second timer would double the round rate.
     */
    fun start(scope: CoroutineScope) {
        scope.launch {
            settings.map { it.automaticEnabled to it.networkPolicy }
                .distinctUntilChanged()
                .collect { (enabled, policy) ->
                    if (enabled) {
                        scheduler.schedulePeriodic(settings.value.clampedIntervalSec, policy)
                    } else {
                        scheduler.cancelAll()
                    }
                }
        }

        scope.launch {
            var previouslyConnected = networkMonitor.current().connected
            networkMonitor.states().collect { state ->
                if (state.connected && !previouslyConnected) {
                    run(SyncTrigger.NETWORK_RESTORED, respectPolicy = true)
                }
                previouslyConnected = state.connected
            }
        }

        scope.launch {
            var debounce: Job? = null
            localWriteSignals.collect {
                // Debounced by hand rather than with Flow.debounce so a burst of edits produces one
                // round without pulling in a preview API.
                debounce?.cancel()
                debounce = launch {
                    delay(writeDebounceMs)
                    run(SyncTrigger.LOCAL_WRITE_DEBOUNCE, respectPolicy = true)
                }
            }
        }

        scope.launch {
            settings.collect { current ->
                if (!current.automaticEnabled || !current.isForegroundOnlyInterval) return@collect
                while (settings.value.automaticEnabled && settings.value.isForegroundOnlyInterval) {
                    delay(settings.value.clampedIntervalSec * 1_000L)
                    run(SyncTrigger.INTERVAL, respectPolicy = true)
                }
            }
        }

        scope.launch { run(SyncTrigger.FOREGROUND_START, respectPolicy = true) }
    }

    /**
     * @param respectPolicy false for user-initiated rounds, which must work on any link.
     */
    private suspend fun run(trigger: SyncTrigger, respectPolicy: Boolean): List<SyncRoundResult> {
        val current = settings.value
        val state = syncState.state(bindingKey)?.bindingState
            ?.let { name -> runCatching { BindingState.valueOf(name) }.getOrNull() }
            ?: BindingState.UNBOUND

        val allowed = if (respectPolicy) {
            BindingStateMachine.canRunAutomaticSync(state, current.automaticEnabled) &&
                networkMonitor.current().allowsAutomatic(current.networkPolicy)
        } else {
            BindingStateMachine.canRunManualSync(state)
        }
        if (!allowed) return emptyList()

        val results = actor.request(trigger)
        results.lastOrNull()?.let { lastRound.value = it }

        // A round that could not finish schedules its own retry, so a killed process still resumes.
        val failure = results.lastOrNull()?.takeIf { !it.succeeded }
        if (failure != null) {
            val error = failure.error
            if (error?.requiresBootstrapSignal() == true && actor.rerunPending()) {
                // cursor_invalid is non-retryable as a push. This is a bootstrap continuation,
                // protected by the durable BOUND_NEEDS_BOOTSTRAP transition in the local store.
                scheduler.requestBootstrapRound(current.networkPolicy)
            } else if (error != null && SyncErrorMapping.isRetryable(error)) {
                val attempt = syncState.state(bindingKey)?.consecutiveFailures ?: 0
                scheduler.scheduleRetry(
                    SyncErrorMapping.retryDelayMs(error, attempt),
                    current.networkPolicy,
                )
            }
        } else if (actor.rerunPending()) {
            // The actor hit its per-invocation round cap with work still queued.
            scheduler.requestBackgroundRound(current.networkPolicy)
        }
        return results
    }

    companion object {
        const val DEFAULT_WRITE_DEBOUNCE_MS = 2_000L
    }
}
