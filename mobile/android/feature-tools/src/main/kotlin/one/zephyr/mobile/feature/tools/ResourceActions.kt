package one.zephyr.mobile.feature.tools

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.contracts.ConflictResolution
import one.zephyr.mobile.model.ActionGate
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.ConflictRecord
import one.zephyr.mobile.model.JumpHost
import one.zephyr.mobile.model.Proxy
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.model.SecretPresence
import one.zephyr.mobile.model.SshKey
import one.zephyr.mobile.model.SyncState

/** Row actions shared by the three S43 kinds. */
enum class ResourceAction { EDIT, DELETE, SHARE, REVEAL_SECRET }

/**
 * One resource row, kind-agnostic.
 *
 * A single projection so one list screen can render proxies, keys and jump hosts with one card and
 * one gate table. Without it each kind would grow its own copy of the residency and capability rules,
 * which is exactly how the three drift apart.
 *
 * [secretPresence] carries presence only. There is no field on this type that could hold a secret.
 */
data class ResourceRow(
    val kind: ResourceKind,
    val id: String,
    val name: String,
    /** host:port for a proxy, remark for a key, target connection name for a jump host. */
    val subtitle: String,
    val residency: Residency,
    val capabilities: CapabilitySet,
    val syncState: SyncState,
    val revision: Long,
    val updatedAt: Long,
    val secretPresence: Map<String, SecretPresence> = emptyMap(),
    /** Connections that reference this resource. Non-empty blocks delete. */
    val referencedBy: List<String> = emptyList(),
    val ownerLabel: String? = null,
) {
    val isReferenced: Boolean get() = referencedBy.isNotEmpty()

    val hasConflict: Boolean get() = syncState == SyncState.CONFLICTED

    val isPendingSync: Boolean get() = syncState == SyncState.PENDING_LOCAL
}

/** Projections from the mirrored models onto the shared row. */
object ResourceRows {

    fun of(proxy: Proxy, referencedBy: List<String> = emptyList()): ResourceRow = ResourceRow(
        kind = ResourceKind.PROXY,
        id = proxy.id,
        name = proxy.name,
        subtitle = proxy.host + ":" + proxy.port,
        residency = proxy.residency,
        capabilities = proxy.capabilities,
        syncState = proxy.syncState,
        revision = proxy.revision,
        updatedAt = proxy.updatedAt,
        secretPresence = mapOf("password" to proxy.password),
        referencedBy = referencedBy,
    )

    fun of(key: SshKey, referencedBy: List<String> = emptyList()): ResourceRow = ResourceRow(
        kind = ResourceKind.SSH_KEY,
        id = key.id,
        name = key.name,
        subtitle = key.remark,
        residency = key.residency,
        capabilities = key.capabilities,
        syncState = key.syncState,
        revision = key.revision,
        updatedAt = key.updatedAt,
        secretPresence = mapOf("privateKey" to key.privateKey, "passphrase" to key.passphrase),
        referencedBy = referencedBy,
    )

    /**
     * @param connectionName resolved display name of the referenced connection, or empty when the
     *   dependency is gone. An empty subtitle is what the UI turns into "依赖已失效".
     */
    fun of(
        host: JumpHost,
        connectionName: String,
        referencedBy: List<String> = emptyList(),
    ): ResourceRow = ResourceRow(
        kind = ResourceKind.JUMP_HOST,
        id = host.id,
        name = host.name,
        subtitle = connectionName,
        residency = host.residency,
        capabilities = host.capabilities,
        syncState = host.syncState,
        revision = host.revision,
        updatedAt = host.updatedAt,
        referencedBy = referencedBy,
    )

    /** Favourites are not part of S43, so ordering is name-first with a stable id tie-break. */
    fun ordering(): Comparator<ResourceRow> =
        compareBy<ResourceRow>(String.CASE_INSENSITIVE_ORDER) { it.name }.thenBy { it.id }
}

/**
 * Capability and residency gating for S43.
 *
 * Same split as the connection library: an action the user has no business knowing about is hidden,
 * an action that exists but cannot apply to this row is disabled *with its reason*. SCREEN_CATALOG.md
 * 2 forbids the third option of showing an action that fails on tap.
 */
object ResourceActions {

    fun gate(row: ResourceRow, action: ResourceAction): ActionGate = when (action) {
        ResourceAction.EDIT ->
            if (row.capabilities.canEdit) ActionGate.Allowed
            else ActionGate.Hidden(Capability.EDIT)

        ResourceAction.DELETE -> when {
            // Reference protection comes first: a referenced row is a route dependency, and deleting
            // it would break connections the user cannot see from here (SCREEN_CATALOG.md 18).
            row.isReferenced ->
                ActionGate.Disabled(Capability.DELETE, referencedReason(row.referencedBy))
            row.capabilities.canDelete -> ActionGate.Allowed
            else -> ActionGate.Hidden(Capability.DELETE)
        }

        // Re-sharing someone else's resource is the owner's decision, not the grantee's.
        ResourceAction.SHARE -> when {
            row.residency != Residency.OWNED ->
                ActionGate.Disabled(Capability.SHARE, REASON_SHARED_NO_RESHARE)
            row.capabilities.canShare -> ActionGate.Allowed
            else -> ActionGate.Hidden(Capability.SHARE)
        }

        /*
         * Reveal is hidden without the capability rather than disabled.
         *
         * ZEPHYR_PARITY.md 4.2 makes revealSecret a permission the owner may withhold permanently and
         * that shared use never implies, so telling a grantee the action exists would invite them to
         * ask for it. Rows with no secret at all also hide it: there is nothing to reveal.
         */
        ResourceAction.REVEAL_SECRET -> when {
            row.secretPresence.none { it.value.hasValue } -> ActionGate.Hidden(Capability.REVEAL_SECRET)
            row.capabilities.canRevealSecret -> ActionGate.Allowed
            else -> ActionGate.Hidden(Capability.REVEAL_SECRET)
        }
    }

    fun visibleActions(row: ResourceRow): List<ResourceAction> =
        ResourceAction.entries.filter { gate(row, it).isVisible }

    /**
     * Names the connections that block a delete.
     *
     * The server enforces the same rule and answers forbidden_dependency_*, but doing it locally means
     * the user is told *which* connections would break instead of watching a push fail with a code.
     */
    fun referencedReason(referencedBy: List<String>): String {
        val head = referencedBy.take(REFERENCE_PREVIEW).joinToString("、")
        return if (referencedBy.size > REFERENCE_PREVIEW) {
            REASON_REFERENCED_PREFIX + head + REASON_REFERENCED_MORE + referencedBy.size + REASON_REFERENCED_SUFFIX
        } else {
            REASON_REFERENCED_PREFIX + head + REASON_REFERENCED_SUFFIX
        }
    }

    const val REFERENCE_PREVIEW = 3

    const val REASON_REFERENCED_PREFIX = "仍被 "
    const val REASON_REFERENCED_MORE = " 等共 "
    const val REASON_REFERENCED_SUFFIX = " 使用中，先改这些连接的路由再删除"
    const val REASON_SHARED_NO_RESHARE = "只有资源所有者可以再次共享"
}

/**
 * Which conflict resolutions a resource may offer.
 *
 * This mirrors the conditions ConflictRepository.resolve *throws* on, so an option the repository
 * would reject is never presented. Offering keep-local over an ACL revocation and then surfacing an
 * IllegalStateException would be a UI bug that only appears on a resolution the user already chose.
 *
 * @param aclRevoked the grant behind this row was revoked server-side.
 * @param serverDeleted the row was deleted server-side while a local edit was queued.
 *
 * Both are passed in rather than read from [ConflictRecord]: the frozen model publishes neither flag,
 * so the caller supplies what the conflict table told it and the default is the permissive case.
 */
object ResourceConflictPolicy {

    fun options(
        record: ConflictRecord,
        aclRevoked: Boolean = false,
        serverDeleted: Boolean = false,
    ): List<ConflictResolution> = buildList {
        add(ConflictResolution.USE_SERVER)
        // An authoritative revocation or delete cannot be overridden by a local edit; copy-as-new is
        // the only way to keep the user's work.
        if (!aclRevoked && !serverDeleted) add(ConflictResolution.KEEP_LOCAL)
        add(ConflictResolution.COPY_AS_NEW)
        // A secret cannot be text-merged: there is no plaintext on the device to merge against, only
        // presence. Offering a manual merge would present two masks to reconcile.
        if (!record.isSecretConflict) add(ConflictResolution.MANUAL_MERGE)
    }

    fun allows(
        record: ConflictRecord,
        resolution: ConflictResolution,
        aclRevoked: Boolean = false,
        serverDeleted: Boolean = false,
    ): Boolean = resolution in options(record, aclRevoked, serverDeleted)
}