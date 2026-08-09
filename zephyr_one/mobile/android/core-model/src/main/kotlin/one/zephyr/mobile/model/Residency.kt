package one.zephyr.mobile.model

import one.zephyr.mobile.contracts.Capability

/**
 * Residency is the hard product boundary from SHARED_RESOURCE_RESIDENCY.md:
 * owned resources are mirrored locally, shared-to-me resources are online-only and must never
 * touch the local DB, SecretStore, search index, offline cache, backup, logs or notifications.
 */
enum class Residency {
    /** ownerUserId == boundUserId. Full local mirror, offline capable. */
    OWNED,

    /** Shared with the bound account through ACL. Online-only, zero local residency. */
    SHARED_ONLINE_ONLY,
    ;

    val isMirrored: Boolean get() = this == OWNED
    val allowsLocalPersistence: Boolean get() = this == OWNED
    val allowsOfflineCache: Boolean get() = this == OWNED
    val allowsSearchIndex: Boolean get() = this == OWNED
    val allowsBackup: Boolean get() = this == OWNED
}

/**
 * The capability set the server most recently reported. Client-side gating is presentation only;
 * every server call recomputes it (ZEPHYR_PARITY.md 4.2).
 */
@JvmInline
value class CapabilitySet(val capabilities: Set<Capability>) {

    operator fun contains(capability: Capability): Boolean = capability in capabilities

    val canView: Boolean get() = Capability.VIEW in capabilities
    val canUse: Boolean get() = Capability.USE in capabilities
    val canObserve: Boolean get() = Capability.OBSERVE in capabilities
    val canControl: Boolean get() = Capability.CONTROL in capabilities
    val canExecute: Boolean get() = Capability.EXECUTE in capabilities
    val canReadFiles: Boolean get() = Capability.FILE_READ in capabilities
    val canWriteFiles: Boolean get() = Capability.FILE_WRITE in capabilities
    val canEdit: Boolean get() = Capability.EDIT in capabilities
    val canShare: Boolean get() = Capability.SHARE in capabilities
    val canDelete: Boolean get() = Capability.DELETE in capabilities

    /** Never implied by shared use. Owner policy may withhold it permanently. */
    val canRevealSecret: Boolean get() = Capability.REVEAL_SECRET in capabilities

    /** A resource with no EDIT capability must not queue local write operations. */
    val allowsLocalWriteQueue: Boolean get() = canEdit

    fun wireNames(): List<String> = capabilities.map { it.wireName }.sorted()

    companion object {
        val owner = CapabilitySet(Capability.entries.toSet())
        val none = CapabilitySet(emptySet())

        /** Implicit grants from shared_users/shared_admins/shared_all. */
        val implicitShare = CapabilitySet(
            setOf(Capability.DISCOVER, Capability.VIEW, Capability.USE, Capability.OBSERVE),
        )

        fun fromWire(values: Collection<String>?): CapabilitySet =
            CapabilitySet((values ?: emptyList()).mapNotNull(Capability::fromWire).toSet())
    }
}

/** How a shared connection is allowed to be opened. Owner policy decides; One never downgrades. */
enum class SharedUsePolicy {
    /** Credentials stay on the Zephyr main end. Always available as the safe default. */
    RELAY_ONLY,

    /** Owner permits a single short-lived encrypted use envelope for a native direct session. */
    DIRECT_ALLOWED,
    ;

    /**
     * A direct session means connection material was present in One's memory. The UI must say so
     * rather than claiming the secret never reached the device.
     */
    val materialTouchesDevice: Boolean get() = this == DIRECT_ALLOWED
}
