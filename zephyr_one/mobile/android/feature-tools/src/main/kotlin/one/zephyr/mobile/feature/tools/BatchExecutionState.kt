package one.zephyr.mobile.feature.tools

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.model.ActionGate
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.EmptyReason
import one.zephyr.mobile.model.PageState

/**
 * S41's rendered state, derived purely.
 *
 * The branch order below is the specification: SCREEN_CATALOG.md 2 freezes nine states, and deciding
 * between them inside a composable would make the contract untestable. Everything the screen needs to
 * decide what to draw is a field of [BatchContent], so the composable holds no policy at all.
 */
data class BatchContent(
    val targets: List<BatchTarget>,
    val plan: BatchPlan,
    /** Validation for the current plan. Empty means the run may be attempted. */
    val issues: List<BatchIssue>,
    /** Null until the first run. Kept after completion so results stay readable. */
    val run: BatchRunState?,
    val engineAvailable: Boolean,
    val online: Boolean,
) {

    val isRunning: Boolean get() = run != null && !run.isComplete

    /** Hosts the plan currently names, in picker order. */
    val selected: List<BatchTarget> get() = targets.filter { it.connectionId in plan.selectedIds }

    val selectedEligibleCount: Int get() = selected.count(BatchTargets::isEligible)

    val selectedDeniedCount: Int get() = selected.size - selectedEligibleCount

    /**
     * Whether 执行 may be pressed, and why not.
     *
     * Disabled with a reason rather than hidden: the button is the point of the screen, and hiding it
     * would leave the user with no explanation (SCREEN_CATALOG.md 2). Engine availability is checked
     * before connectivity because a missing engine is not fixed by joining a network.
     */
    val runGate: ActionGate
        get() = when {
            !engineAvailable -> ActionGate.Disabled(Capability.EXECUTE, REASON_ENGINE_UNAVAILABLE)
            !online -> ActionGate.Disabled(Capability.EXECUTE, REASON_OFFLINE)
            isRunning -> ActionGate.Disabled(Capability.EXECUTE, REASON_ALREADY_RUNNING)
            issues.isNotEmpty() -> ActionGate.Disabled(Capability.EXECUTE, issues.first().message)
            else -> ActionGate.Allowed
        }

    val canRun: Boolean get() = runGate.isAllowed

    fun issueFor(field: String): String? = issues.firstOrNull { it.field == field }?.message

    companion object {
        const val REASON_ENGINE_UNAVAILABLE = "SSH 引擎在此版本中尚未接入，无法执行"
        const val REASON_OFFLINE = "离线状态下不能执行远程命令"
        const val REASON_ALREADY_RUNNING = "本次执行尚未结束"
    }
}

/**
 * Every user action on S41, as one closed set.
 *
 * A sealed interface rather than a bag of lambdas so the route's single `when` fails to compile when
 * an action is added but not wired, which is the property [ToolsRoutes] relies on.
 */
sealed interface BatchIntent {
    data class Command(val value: String) : BatchIntent
    data class Timeout(val seconds: Int) : BatchIntent
    data class Concurrency(val value: Int) : BatchIntent
    data class FailFast(val enabled: Boolean) : BatchIntent
    data class ToggleTarget(val connectionId: String) : BatchIntent
    data object SelectAllEligible : BatchIntent
    data object ClearSelection : BatchIntent
    data object Run : BatchIntent
    data object CancelRun : BatchIntent
    data class CancelTarget(val connectionId: String) : BatchIntent
    data object Export : BatchIntent
}

object BatchStates {

    /**
     * Projects the connection library onto the batch picker.
     *
     * Only SSH survives, because exec exists nowhere else (`Protocol.supportsExec`). Deleted rows are
     * dropped; a row without `execute` is kept and shown denied, since hiding it would leave the user
     * wondering why a host they own is missing.
     */
    fun targetsFrom(connections: List<Connection>): List<BatchTarget> = connections
        .asSequence()
        .filter { !it.isDeleted }
        .filter { it.protocol.supportsExec }
        .map { connection ->
            BatchTarget(
                connectionId = connection.id,
                name = connection.name,
                host = connection.host,
                port = connection.port,
                protocol = connection.protocol,
                capabilities = connection.capabilities,
                residency = connection.residency,
            )
        }
        .sortedBy { it.name.lowercase() }
        .toList()

    /**
     * @param loaded false only before the first mirror emission, which is the difference between
     *   InitialLoading and an empty library.
     * @param online drives the offline branch. The target list is a local mirror so it still renders,
     *   but [BatchContent.runGate] refuses the run: SCREEN_CATALOG.md 17's rule against presenting
     *   stale data as live applies just as much to pretending an offline run could start.
     */
    fun derive(
        targets: List<BatchTarget>,
        plan: BatchPlan,
        run: BatchRunState?,
        engineAvailable: Boolean,
        loaded: Boolean = true,
        online: Boolean = true,
        lastSyncedAt: Long? = null,
    ): PageState<BatchContent> {
        if (!loaded) return PageState.InitialLoading

        val content = BatchContent(
            targets = targets,
            plan = plan,
            issues = plan.validate(targets),
            run = run,
            engineAvailable = engineAvailable,
            online = online,
        )

        // An empty picker is reported even while a finished run is on screen only when there is
        // nothing to read: discarding results the user is still looking at would be worse.
        if (targets.isEmpty() && run == null) return PageState.Empty(EmptyReason.NO_DATA)

        if (!online) return PageState.OfflineWithCache(content, lastSyncedAt)

        return PageState.Content(content)
    }
}