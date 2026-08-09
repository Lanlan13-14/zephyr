package one.zephyr.mobile.feature.tools

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.model.ActionGate
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.Protocol

/** The three S42 surfaces. One connection picker, three views over it. */
enum class OpsSection { DOCKER, METRICS, LOGS }

/**
 * How old the displayed data is.
 *
 * Modelled as a type rather than a boolean because SCREEN_CATALOG.md 17 forbids presenting a stale
 * value as live. A screen holding [SnapshotFreshness] cannot render a number without also having
 * decided what to say about its age.
 */
sealed interface SnapshotFreshness {
    /** Captured within [OpsFreshness.LIVE_WINDOW_MS] and the device is online. */
    data object Live : SnapshotFreshness

    /** Online, but the last capture is older than the live window. */
    data class Stale(val ageMs: Long) : SnapshotFreshness

    /** Offline: the snapshot is whatever was last captured, and it cannot refresh. */
    data class Offline(val capturedAt: Long?, val ageMs: Long?) : SnapshotFreshness

    /** Nothing has ever been captured for this connection. */
    data object Never : SnapshotFreshness

    val isLive: Boolean get() = this is Live

    /** True whenever a value must be labelled with its capture time instead of shown bare. */
    val requiresAgeDisclosure: Boolean get() = this !is Live
}

/**
 * Freshness arithmetic.
 *
 * The window is a product decision rather than a spec constant: SCREEN_CATALOG.md 17 fixes the
 * behaviour ("show the last snapshot time, never claim it is live") but not a number, so the value
 * lives here with its reasoning instead of being scattered across three views.
 */
object OpsFreshness {

    /**
     * Beyond this, a container list or a CPU figure is described by its age.
     *
     * Five seconds is one poll interval plus slack: long enough that a normal refresh does not flap
     * the label, short enough that a paused poller is visible before the user acts on the number.
     */
    const val LIVE_WINDOW_MS = 5_000L

    fun of(capturedAt: Long?, nowMs: Long, online: Boolean): SnapshotFreshness {
        if (capturedAt == null) {
            return if (online) SnapshotFreshness.Never else SnapshotFreshness.Offline(null, null)
        }
        // Clock skew between device and server can produce a capture in the future; treating it as
        // age zero is honest enough and avoids rendering a negative age.
        val age = (nowMs - capturedAt).coerceAtLeast(0L)
        return when {
            !online -> SnapshotFreshness.Offline(capturedAt, age)
            age <= LIVE_WINDOW_MS -> SnapshotFreshness.Live
            else -> SnapshotFreshness.Stale(age)
        }
    }
}

/** One captured value plus when it was captured. There is no way to hold one without the other. */
data class OpsSnapshot<T>(val value: T, val capturedAt: Long) {
    fun freshness(nowMs: Long, online: Boolean): SnapshotFreshness =
        OpsFreshness.of(capturedAt, nowMs, online)
}

data class DockerContainer(
    val id: String,
    val name: String,
    val image: String,
    val state: String,
    val status: String,
    val ports: List<String> = emptyList(),
)

data class DockerImage(
    val id: String,
    val repository: String,
    val tag: String,
    val sizeBytes: Long,
)

/**
 * Host resource figures.
 *
 * Percentages are Float because that is what the source reports; the UI renders a readable
 * percentage rather than only a bar (SCREEN_CATALOG.md 26).
 */
data class HostMetrics(
    val cpuPercent: Float,
    val memoryUsedBytes: Long,
    val memoryTotalBytes: Long,
    val diskUsedBytes: Long,
    val diskTotalBytes: Long,
    val networkRxBytesPerSec: Long,
    val networkTxBytesPerSec: Long,
) {
    val memoryPercent: Float
        get() = if (memoryTotalBytes <= 0L) 0f else memoryUsedBytes * 100f / memoryTotalBytes

    val diskPercent: Float
        get() = if (diskTotalBytes <= 0L) 0f else diskUsedBytes * 100f / diskTotalBytes
}

data class LogLine(val at: Long, val text: String)

/** Mutations S42 offers. Arbitrary commands are deliberately a separate, higher gate. */
enum class OpsAction { START, STOP, RESTART, PULL, EXEC }

/**
 * Capability mapping for S42.
 *
 * SCREEN_CATALOG.md 17 fixes the mapping exactly: observe is read-only, control may
 * start/stop/restart, and only execute allows an arbitrary command. This table is the whole rule, so
 * it is a pure function with a test rather than a set of conditions inside three composables.
 */
object OpsActions {

    /** The picker only offers SSH connections carrying USE (SCREEN_CATALOG.md 17). */
    fun canOpen(protocol: Protocol, capabilities: CapabilitySet): Boolean =
        protocol.supportsExec && capabilities.canUse

    fun canObserve(capabilities: CapabilitySet): Boolean = capabilities.canObserve

    fun gate(capabilities: CapabilitySet, action: OpsAction): ActionGate = when (action) {
        OpsAction.START, OpsAction.STOP, OpsAction.RESTART ->
            if (capabilities.canControl) ActionGate.Allowed
            else ActionGate.Disabled(Capability.CONTROL, REASON_NEEDS_CONTROL)

        // Pulling an image writes to the host's image store, so it is a control action rather than a
        // read: an observer must not be able to fill a server's disk.
        OpsAction.PULL ->
            if (capabilities.canControl) ActionGate.Allowed
            else ActionGate.Disabled(Capability.CONTROL, REASON_NEEDS_CONTROL)

        // Hidden rather than disabled: an arbitrary shell on someone else's host is not an action the
        // user should be told exists, and control does not imply it.
        OpsAction.EXEC ->
            if (capabilities.canExecute) ActionGate.Allowed
            else ActionGate.Hidden(Capability.EXECUTE)
    }

    fun visibleActions(capabilities: CapabilitySet): List<OpsAction> =
        OpsAction.entries.filter { gate(capabilities, it).isVisible }

    /**
     * Whether a mutation may be dispatched at all right now.
     *
     * Offline is refused before the capability is even consulted: a start/stop that cannot reach the
     * host would otherwise queue behind an optimistic UI and look like it worked.
     */
    fun canDispatch(capabilities: CapabilitySet, action: OpsAction, online: Boolean): Boolean =
        online && gate(capabilities, action).isAllowed

    const val REASON_NEEDS_CONTROL = "需要 control 权限才能启停容器"
    const val REASON_OFFLINE = "离线状态下不能执行操作"
}