package one.zephyr.mobile.feature.remote

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.FileSyncDirectoryIntent
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.RdpSettings
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.model.SharedUsePolicy

/**
 * Builders for the S22 and S23 tests.
 *
 * Duplicated from the sessions module rather than shared: a test source set is not visible across
 * modules, and a testFixtures variant would couple two feature modules together for the sake of two
 * factory functions. If the Connection shape changes, both copies fail rather than one.
 */
internal object RemoteFixtures {

    fun connection(
        id: String = "c1",
        protocol: Protocol = Protocol.RDP,
        name: String = "prod-desktop",
        host: String = "10.0.0.5",
        port: Int = 3389,
        username: String = "administrator",
        rdp: RdpSettings = RdpSettings(),
        fileSyncIntent: FileSyncDirectoryIntent = FileSyncDirectoryIntent.OFF,
        residency: Residency = Residency.OWNED,
        capabilities: CapabilitySet = CapabilitySet.owner,
        sharedUsePolicy: SharedUsePolicy = SharedUsePolicy.RELAY_ONLY,
        sharedOwnerLabel: String? = null,
    ): Connection = Connection(
        id = id,
        ownerUserId = "u1",
        protocol = protocol,
        name = name,
        host = host,
        port = port,
        username = username,
        rdp = rdp,
        fileSyncIntent = fileSyncIntent,
        residency = residency,
        capabilities = capabilities,
        sharedUsePolicy = sharedUsePolicy,
        sharedOwnerLabel = sharedOwnerLabel,
    )

    /**
     * A patch whose pixel array is exactly the right length for its region.
     *
     * Sized from the region rather than passed in, so a test that means to exercise the happy path
     * cannot accidentally be testing the malformed-patch counter instead.
     */
    fun patch(
        x: Int = 0,
        y: Int = 0,
        width: Int = 1,
        height: Int = 1,
        fill: Byte = 0,
    ): FramePatch = FramePatch(
        region = FrameRegion(x, y, width, height),
        pixels = ByteArray(maxOf(0, width) * maxOf(0, height) * RemoteFramebuffer.BYTES_PER_PIXEL) { fill },
    )

    /** 1000x1000 desktop in a 500x250 viewport: fit 0.25 and fill-width 0.5 differ, so both are provable. */
    val geometry = RemoteGeometry(
        remoteWidthPx = 1000,
        remoteHeightPx = 1000,
        viewportWidthPx = 500f,
        viewportHeightPx = 250f,
    )

    /** Nothing measured yet. Every mapping must refuse rather than divide by a zero scale. */
    val unmeasured = RemoteGeometry(0, 0, 0f, 0f)

    /** view + use: enough to open the session, not enough to send input. */
    val useOnly = CapabilitySet(setOf(Capability.VIEW, Capability.USE))

    /** view + use + observe: the shared grant that must render 只读观察 rather than a dead surface. */
    val observeOnly = CapabilitySet(setOf(Capability.VIEW, Capability.USE, Capability.OBSERVE))

    val viewOnly = CapabilitySet(setOf(Capability.VIEW))
}
