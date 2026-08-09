package one.zephyr.mobile.feature.connections

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.model.ActionGate
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.Residency

/**
 * The row actions from SCREEN_CATALOG.md 5.
 *
 * Modelled as an enum so a screen cannot invent an action that has no gate; [ConnectionActions]
 * then owns the single decision table.
 */
enum class ConnectionAction { USE, EDIT, DUPLICATE, DELETE, TEST, SHARE }

/**
 * Capability gating for connection actions.
 *
 * SCREEN_CATALOG.md 2 requires a short capability to either hide the action or disable it *with a
 * reason*, never to show an action that fails on tap. The split here follows one rule: an action the
 * user has no business knowing about is hidden, an action that exists but is unavailable for this
 * row is disabled with the reason shown.
 */
object ConnectionActions {

    fun gate(connection: Connection, action: ConnectionAction): ActionGate = when (action) {
        ConnectionAction.USE ->
            if (connection.capabilities.canUse) ActionGate.Allowed
            else ActionGate.Hidden(Capability.USE)

        ConnectionAction.EDIT ->
            if (connection.capabilities.canEdit) ActionGate.Allowed
            else ActionGate.Hidden(Capability.EDIT)

        // Duplicating a shared row would create an owned copy of someone else's material on this
        // device, which SHARED_RESOURCE_RESIDENCY.md forbids. Disabled rather than hidden so the
        // user learns why instead of wondering where the action went.
        ConnectionAction.DUPLICATE -> when {
            connection.residency != Residency.OWNED ->
                ActionGate.Disabled(Capability.EDIT, REASON_SHARED_NO_COPY)
            connection.capabilities.canEdit -> ActionGate.Allowed
            else -> ActionGate.Hidden(Capability.EDIT)
        }

        ConnectionAction.DELETE ->
            if (connection.capabilities.canDelete) ActionGate.Allowed
            else ActionGate.Hidden(Capability.DELETE)

        // Test only needs USE: it opens a transport and closes it, and never writes.
        ConnectionAction.TEST ->
            if (connection.capabilities.canUse) ActionGate.Allowed
            else ActionGate.Hidden(Capability.USE)

        // Re-sharing a resource you do not own is the owner's decision, not the grantee's.
        ConnectionAction.SHARE -> when {
            connection.residency != Residency.OWNED ->
                ActionGate.Disabled(Capability.SHARE, REASON_SHARED_NO_RESHARE)
            connection.capabilities.canShare -> ActionGate.Allowed
            else -> ActionGate.Hidden(Capability.SHARE)
        }
    }

    fun visibleActions(connection: Connection): List<ConnectionAction> =
        ConnectionAction.entries.filter { gate(connection, it).isVisible }

    /**
     * Shared-connection disclosure.
     *
     * SCREEN_CATALOG.md 2.1 bans a vague "安全连接": the user must be told, before connecting,
     * whether the credential stays on the main end or the material lands in session memory.
     */
    fun sharedUseDisclosure(connection: Connection): String? {
        if (connection.residency != Residency.SHARED_ONLINE_ONLY) return null
        return if (connection.sharedUsePolicy.materialTouchesDevice) {
            DISCLOSURE_DIRECT
        } else {
            DISCLOSURE_RELAY
        }
    }

    const val REASON_SHARED_NO_COPY = "共享给你的连接不能复制到本机"
    const val REASON_SHARED_NO_RESHARE = "只有资源所有者可以再次共享"
    const val DISCLOSURE_RELAY = "主端 relay：凭据保留在主端"
    const val DISCLOSURE_DIRECT = "本次原生直连：加密连接材料仅驻留会话内存"
}
