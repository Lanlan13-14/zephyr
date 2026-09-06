package one.zephyr.mobile.feature.connections

import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.ConnectionMode
import one.zephyr.mobile.model.FileSyncDirectoryIntent
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.SecretPresence
import one.zephyr.mobile.model.SecretState
import one.zephyr.mobile.model.wipePlaintext
import one.zephyr.mobile.model.TerminalEncoding

/**
 * The eight S11 sections, in the frozen order.
 *
 * SCREEN_CATALOG.md 6 fixes the order, so it lives in an enum rather than in the composable: a
 * screen that renders [EditorSection].entries cannot silently reorder or drop one.
 */
enum class EditorSection {
    BASIC,
    AUTH,
    ROUTE,
    RDP_CHANNELS,
    RDP_DISPLAY,
    FILE_SYNC,
    METADATA,
}

/** One validation failure, tied to the field that caused it so the editor can scroll to it. */
data class DraftIssue(val field: String, val message: String)

/**
 * Which route dependencies the current user may actually select.
 *
 * ZEPHYR_PARITY.md 5.3 requires a dependency to exist *and* carry USE before a connection may
 * reference it. Passing the usable ids in keeps [ConnectionDraft] pure: the repository resolves
 * capability, the draft only decides what that means for this edit.
 */
data class RouteInventory(
    val usableProxyIds: Set<String> = emptySet(),
    val usableSshKeyIds: Set<String> = emptySet(),
    val usableJumpHostIds: Set<String> = emptySet(),
)

/**
 * The S11 editor state.
 *
 * Holds [original] alongside [current] because almost every rule in the section depends on the
 * difference between them: the fieldMask is a diff, "unsaved changes" is a diff, and a masked secret
 * is precisely a field that must *not* be diffed. A draft that only carried the edited values could
 * not tell "user cleared the password" from "user never touched it".
 *
 * @param original null when creating. A create pushes the whole editable field set, because the
 *   server has no row to merge against.
 * @param portWasEdited once true, switching protocol stops moving the port (ZEPHYR_PARITY.md 5.1).
 */
data class ConnectionDraft(
    val original: Connection?,
    val current: Connection,
    val portWasEdited: Boolean = false,
    val password: SecretState = SecretState.Unchanged,
    val privateKey: SecretState = SecretState.Unchanged,
) {

    val isCreate: Boolean get() = original == null

    /**
     * True when leaving the editor would lose work.
     *
     * SCREEN_CATALOG.md 6 requires a confirmation on back with unsaved changes, so this has to
     * include the secret tri-state: replacing a password and changing nothing else is still work.
     */
    val isDirty: Boolean
        get() = isCreate ||
            current != original ||
            outgoingSecret(password).contributesToFieldMask ||
            outgoingSecret(privateKey).contributesToFieldMask

    /**
     * Device-local directory intent, which the frozen entity registry does not publish as a
     * syncable field. Tracked separately from [changedFields] so it can never enter a fieldMask.
     */
    val fileSyncIntentChanged: Boolean
        get() = original == null || original.fileSyncIntent != current.fileSyncIntent

    // ---- editing -------------------------------------------------------------------------------

    /**
     * Protocol switch.
     *
     * Delegates the field clearing to [Connection.withProtocol] so the rule lives in one place, and
     * adds the secret half: dropping to Telnet clears a stored private key rather than leaving an
     * unreachable secret behind, while the in-band password survives (SCREEN_CATALOG.md 6).
     */
    fun withProtocol(next: Protocol): ConnectionDraft {
        if (next == current.protocol) return this
        val moved = current.withProtocol(next, portWasEdited)
        val nextPrivateKey = if (next == Protocol.TELNET && hadStoredPrivateKey()) {
            SecretState.Clear
        } else if (next == Protocol.TELNET) {
            SecretState.Unchanged
        } else {
            privateKey
        }
        if (nextPrivateKey !== privateKey) privateKey.wipePlaintext()
        return copy(current = moved, privateKey = nextPrivateKey)
    }

    private fun hadStoredPrivateKey(): Boolean =
        original?.privateKey?.hasValue == true || privateKey is SecretState.Replace

    fun withConnectionMode(next: ConnectionMode): ConnectionDraft =
        copy(current = current.withConnectionMode(next))

    /** Marks the port as user-owned, which freezes it against later protocol switches. */
    fun withPort(port: Int): ConnectionDraft = copy(current = current.copy(port = port), portWasEdited = true)

    fun withName(name: String): ConnectionDraft = copy(current = current.copy(name = name))

    fun withHost(host: String): ConnectionDraft = copy(current = current.copy(host = host))

    fun withUsername(username: String): ConnectionDraft = copy(current = current.copy(username = username))

    fun withRemark(remark: String): ConnectionDraft = copy(current = current.copy(remark = remark))

    fun withTags(tags: List<String>): ConnectionDraft = copy(current = current.copy(tags = tags))

    fun withEncoding(encoding: TerminalEncoding): ConnectionDraft =
        copy(current = current.copy(encoding = encoding))

    fun withProxy(proxyId: String?): ConnectionDraft = copy(current = current.copy(proxyId = proxyId))

    fun withSshKey(sshKeyId: String?): ConnectionDraft = copy(current = current.copy(sshKeyId = sshKeyId))

    fun withFileSyncIntent(intent: FileSyncDirectoryIntent): ConnectionDraft =
        copy(current = current.copy(fileSyncIntent = intent))

    /**
     * Appends one hop.
     *
     * Duplicates are refused rather than deduplicated silently, because a jump chain is ordered and
     * dropping a repeat would quietly change the route the user described.
     */
    fun withJumpHostAdded(jumpHostId: String): ConnectionDraft {
        if (jumpHostId in current.jumpHostIds) return this
        if (current.jumpHostIds.size >= Connection.MAX_JUMP_DEPTH) return this
        return copy(current = current.copy(jumpHostIds = current.jumpHostIds + jumpHostId))
    }

    fun withJumpHostRemoved(jumpHostId: String): ConnectionDraft =
        copy(current = current.copy(jumpHostIds = current.jumpHostIds.filterNot { it == jumpHostId }))

    /** Reorders one hop. Out-of-range targets are clamped so a drag cannot throw. */
    fun withJumpHostMoved(from: Int, to: Int): ConnectionDraft {
        val chain = current.jumpHostIds
        if (from !in chain.indices) return this
        val target = to.coerceIn(0, chain.size - 1)
        if (from == target) return this
        val reordered = chain.toMutableList()
        reordered.add(target, reordered.removeAt(from))
        return copy(current = current.copy(jumpHostIds = reordered))
    }

    /**
     * Secret tri-state.
     *
     * A blank replacement is folded to [SecretState.Clear]: the user emptied the field, and sending
     * an empty plaintext as a new secret would store a credential that cannot authenticate.
     */
    fun withPassword(state: SecretState): ConnectionDraft {
        val next = if (!hasStoredPassword() && state is SecretState.Replace && state.isBlank) {
            /* A new row has no stored secret. Keep the empty field visible instead of
             * folding to Clear, which would hide the input. */
            state
        } else {
            foldSecret(state)
        }
        if (password !== next) password.wipePlaintext()
        return copy(password = next)
    }

    private fun hasStoredPassword(): Boolean = original?.password?.hasValue == true

    fun withPrivateKey(state: SecretState): ConnectionDraft {
        val next = foldSecret(state)
        if (privateKey !== next) privateKey.wipePlaintext()
        return copy(privateKey = next)
    }

    private fun foldSecret(state: SecretState): SecretState =
        if (state is SecretState.Replace && state.isBlank) {
            state.wipe()
            SecretState.Clear
        } else {
            state
        }

    fun wipeSecretBuffers(): ConnectionDraft {
        password.wipePlaintext()
        privateKey.wipePlaintext()
        return copy(password = SecretState.Unchanged, privateKey = SecretState.Unchanged)
    }

    // ---- normalisation and mask ----------------------------------------------------------------

    /**
     * The row to persist.
     *
     * Trims the host (ZEPHYR_PARITY.md 5.1) and drops blank tags while preserving order and any
     * unknown Unicode. Repeated tags collapse to their first occurrence: a duplicate chip is an
     * input artefact, not user intent, and the server stores a set-like array.
     *
     * An ephemeral connection with no name gets one derived from protocol and host, which is the
     * documented fallback for a deep-link connection that the user never named.
     */
    fun normalized(): Connection {
        val trimmedHost = current.host.trim()
        val tags = current.tags.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        val name = current.name.trim().ifEmpty {
            if (current.ephemeral) current.protocol.wireName + " " + trimmedHost else ""
        }
        return current.copy(
            name = name,
            host = trimmedHost,
            username = current.username.trim(),
            tags = tags,
            proxyId = current.proxyId?.takeIf { it.isNotBlank() },
            sshKeyId = current.sshKeyId?.takeIf { it.isNotBlank() },
            jumpHostIds = current.jumpHostIds.map { it.trim() }.filter { it.isNotEmpty() },
            rdp = current.rdp.copy(domain = current.rdp.domain.trim()),
        )
    }

    /**
     * The fieldMask for this save.
     *
     * A create names every field the protocol actually uses, because the server is building a new
     * row. An edit names only what changed, which is what keeps a concurrent edit of a different
     * field from turning into a conflict (SYNC_STATE_MACHINE.md 4.3).
     *
     * The device-local directory intent is deliberately absent: the frozen registry publishes it in
     * neither editableFields nor deviceLocalFields, so it is stored on the device only.
     */
    fun changedFields(): List<String> {
        val applicable = fieldsFor(current.protocol)
        val base = original ?: return applicable
        val normalizedCurrent = normalized()
        return applicable.filter { field ->
            val read = FIELD_READERS.getValue(field)
            read(normalizedCurrent) != read(base)
        }
    }

    /** Secret states keyed by registry field name, for the repository call. */
    fun secretStates(): Map<String, SecretState> = buildMap {
        put("password", outgoingSecret(password))
        // Telnet has no key auth, so a private-key state would be meaningless there other than a
        // clear, which withProtocol already produced.
        if (current.protocol != Protocol.TELNET || privateKey is SecretState.Clear) {
            put("privateKey", outgoingSecret(privateKey))
        }
    }

    /**
     * An untouched blank Replace is not a secret. Create starts in Replace so the field is visible;
     * saving without typing must not persist an empty password or clear a stored one.
     */
    private fun outgoingSecret(state: SecretState): SecretState =
        if (state is SecretState.Replace && state.isBlank) SecretState.Unchanged else state

    /** Copies only the active replacement for a one-shot connection test. Caller must wipe it. */
    fun testPasswordChars(): CharArray? =
        (password as? SecretState.Replace)?.editingText()?.toCharArray()

    /** Copies only the active inline-key replacement for a one-shot test. Caller must wipe it. */
    fun testPrivateKeyChars(): CharArray? =
        (privateKey as? SecretState.Replace)?.editingText()?.toCharArray()

    // ---- validation ----------------------------------------------------------------------------

    /**
     * Client-side validation.
     *
     * The server is authoritative, so this only enforces the rules that are frozen in
     * ZEPHYR_PARITY.md 5.1 and the ones that would otherwise produce a guaranteed server rejection.
     * No invented length caps: a limit One made up would reject input Zephyr accepts.
     */
    fun validate(inventory: RouteInventory = RouteInventory()): List<DraftIssue> = buildList {
        val candidate = normalized()
        if (candidate.name.isEmpty()) add(DraftIssue("name", MSG_NAME_REQUIRED))
        if (candidate.host.isEmpty()) add(DraftIssue("host", MSG_HOST_REQUIRED))
        if (candidate.port !in MIN_PORT..MAX_PORT) add(DraftIssue("port", MSG_PORT_RANGE))
        // SSH is the only protocol Zephyr requires a username for.
        if (candidate.protocol == Protocol.SSH && candidate.username.isEmpty()) {
            add(DraftIssue("username", MSG_USERNAME_REQUIRED))
        }
        when (candidate.connectionMode) {
            ConnectionMode.DIRECT -> Unit
            ConnectionMode.PROXY ->
                if (candidate.proxyId == null) add(DraftIssue("proxyId", MSG_PROXY_REQUIRED))
            ConnectionMode.JUMP ->
                if (candidate.jumpHostIds.isEmpty()) add(DraftIssue("jumpHostIds", MSG_JUMP_REQUIRED))
        }
        if (candidate.jumpHostIds.size > Connection.MAX_JUMP_DEPTH) {
            add(DraftIssue("jumpHostIds", MSG_JUMP_TOO_DEEP))
        }
        if (candidate.jumpHostIds.distinct().size != candidate.jumpHostIds.size) {
            add(DraftIssue("jumpHostIds", MSG_JUMP_DUPLICATE))
        }
        addAll(routeIssues(inventory))
    }

    /**
     * Dependencies that are gone or no longer usable.
     *
     * SCREEN_CATALOG.md 6 wants this surfaced as "路由需要修复" rather than as a save failure, so it
     * is reported per dependency and the editor can offer to clear each one.
     */
    fun routeIssues(inventory: RouteInventory): List<DraftIssue> = buildList {
        val candidate = current
        candidate.proxyId?.takeIf { it.isNotBlank() }?.let { id ->
            if (id !in inventory.usableProxyIds) add(DraftIssue("proxyId", MSG_ROUTE_REPAIR))
        }
        candidate.sshKeyId?.takeIf { it.isNotBlank() }?.let { id ->
            if (id !in inventory.usableSshKeyIds) add(DraftIssue("sshKeyId", MSG_ROUTE_REPAIR))
        }
        for (id in candidate.jumpHostIds) {
            if (id !in inventory.usableJumpHostIds) {
                add(DraftIssue("jumpHostIds", MSG_ROUTE_REPAIR))
                break
            }
        }
    }

    val canSave: Boolean get() = validate().isEmpty() && (isDirty || isCreate)

    // ---- section and option visibility ---------------------------------------------------------

    /**
     * Sections to render, in frozen order.
     *
     * RDP sections appear only for RDP because their fields have no meaning elsewhere, and the file
     * sync section appears only where a file channel exists: SFTP for SSH, the drive channel for
     * RDP. Telnet and VNC carry no file transport at all, so offering a directory intent there would
     * promise something the protocol cannot do.
     */
    fun sections(): List<EditorSection> = EditorSection.entries.filter { section ->
        when (section) {
            EditorSection.RDP_CHANNELS, EditorSection.RDP_DISPLAY -> current.protocol == Protocol.RDP
            EditorSection.FILE_SYNC ->
                current.protocol.supportsFiles || current.protocol == Protocol.RDP
            else -> true
        }
    }

    /** rdpDomain sits in the basic section per the catalog, but only RDP has a Windows domain. */
    val showsDomainField: Boolean get() = current.protocol == Protocol.RDP

    /** Encoding is a terminal concern; a framebuffer protocol has no character set. */
    val showsEncodingField: Boolean get() = current.protocol.isTerminal

    val showsSshKeyField: Boolean get() = current.protocol == Protocol.SSH

    companion object {
        const val MIN_PORT = 1
        const val MAX_PORT = 65535

        const val MSG_NAME_REQUIRED = "请填写连接名称"
        const val MSG_HOST_REQUIRED = "请填写主机地址"
        const val MSG_PORT_RANGE = "端口需在 1–65535 之间"
        const val MSG_USERNAME_REQUIRED = "SSH 连接需要用户名"
        const val MSG_PROXY_REQUIRED = "代理模式需要选择一个代理"
        const val MSG_JUMP_REQUIRED = "跳板模式需要至少一级跳板"
        const val MSG_JUMP_TOO_DEEP = "跳板链最多 8 级"
        const val MSG_JUMP_DUPLICATE = "跳板链中存在重复项"
        const val MSG_ROUTE_REPAIR = "路由需要修复：依赖已不存在或权限已撤销"

        /** A brand-new draft. Port follows the protocol default until the user edits it. */
        fun create(ownerUserId: String, connectionId: String, protocol: Protocol = Protocol.SSH): ConnectionDraft =
            ConnectionDraft(
                original = null,
                current = Connection(
                    id = connectionId,
                    ownerUserId = ownerUserId,
                    protocol = protocol,
                    name = "",
                    host = "",
                    port = protocol.defaultPort,
                ),
                /* A new row has nothing to keep. Start in Replace so the password field is visible
                 * instead of a masked "保持不变" that cannot be typed into. */
                password = SecretState.Replace(""),
            )

        /**
         * An editor opened on a stored row.
         *
         * portWasEdited is derived rather than assumed: a port that still equals its protocol's
         * default was never deliberately chosen, so it should keep following the default when the
         * protocol changes, while a custom port must survive the switch (ZEPHYR_PARITY.md 5.1).
         */
        fun edit(connection: Connection): ConnectionDraft =
            ConnectionDraft(
                original = connection,
                current = connection.copy(
                    proxyId = connection.proxyId?.takeIf { it.isNotBlank() },
                    sshKeyId = connection.sshKeyId?.takeIf { it.isNotBlank() },
                    jumpHostIds = connection.jumpHostIds.map { it.trim() }.filter { it.isNotEmpty() },
                ),
                portWasEdited = connection.port != connection.protocol.defaultPort,
                password = if (connection.password.hasValue) {
                    SecretState.Unchanged
                } else {
                    SecretState.Replace("")
                },
            )

        /** Prefills a new owned row without copying secret presence or server authority metadata. */
        fun duplicate(source: Connection, ownerUserId: String, connectionId: String): ConnectionDraft {
            val clean = source.copy(
                id = connectionId,
                ownerUserId = ownerUserId,
                name = source.name + " 副本",
                password = SecretPresence.absent,
                privateKey = SecretPresence.absent,
                revision = 0,
                updatedAt = 0,
                lastConnectedAt = null,
                deletedAt = null,
                residency = one.zephyr.mobile.model.Residency.OWNED,
                capabilities = one.zephyr.mobile.model.CapabilitySet.owner,
                sharedOwnerLabel = null,
                grantExpiresAt = null,
                syncState = one.zephyr.mobile.model.SyncState.SYNCED,
                opaque = emptyMap(),
                ephemeral = false,
            )
            return ConnectionDraft(
                original = null,
                current = clean,
                portWasEdited = clean.port != clean.protocol.defaultPort,
                password = SecretState.Replace(""),
            )
        }

        /**
         * Field readers keyed by registry field name.
         *
         * A table rather than a when-chain so [changedFields] and the mapper cannot drift apart: a
         * field with no reader here is simply never masked, which fails closed.
         */
        private val FIELD_READERS: Map<String, (Connection) -> Any?> = linkedMapOf(
            "name" to { c: Connection -> c.name },
            "host" to { c: Connection -> c.host },
            "port" to { c: Connection -> c.port },
            "protocol" to { c: Connection -> c.protocol },
            "username" to { c: Connection -> c.username },
            "remark" to { c: Connection -> c.remark },
            "tags" to { c: Connection -> c.tags },
            "connectionMode" to { c: Connection -> c.connectionMode },
            "proxyId" to { c: Connection -> c.proxyId },
            "sshKeyId" to { c: Connection -> c.sshKeyId },
            "jumpHostIds" to { c: Connection -> c.jumpHostIds },
            // Legacy single-hop mirror of the chain. Kept in the mask so a server that only reads
            // jumpHostId still sees the first hop instead of silently losing the route.
            "jumpHostId" to { c: Connection -> c.jumpHostIds.firstOrNull() },
            "rdpSoundMode" to { c: Connection -> c.rdp.soundMode },
            "rdpClipboard" to { c: Connection -> c.rdp.clipboard },
            "rdpMicrophone" to { c: Connection -> c.rdp.microphone },
            "rdpCamera" to { c: Connection -> c.rdp.camera },
            "rdpStorage" to { c: Connection -> c.rdp.storage },
            "rdpLocation" to { c: Connection -> c.rdp.location },
            "rdpResolution" to { c: Connection -> c.rdp.resolution },
            "rdpQuality" to { c: Connection -> c.rdp.quality },
            "rdpFps" to { c: Connection -> c.rdp.fps },
            "rdpTouchMode" to { c: Connection -> c.rdp.touchMode },
            "rdpTouchSensitivity" to { c: Connection -> c.rdp.touchSensitivity },
            "rdpDomain" to { c: Connection -> c.rdp.domain },
            "encoding" to { c: Connection -> c.encoding },
        )

        private val RDP_ONLY_FIELDS = setOf(
            "rdpSoundMode",
            "rdpClipboard",
            "rdpMicrophone",
            "rdpCamera",
            "rdpStorage",
            "rdpLocation",
            "rdpResolution",
            "rdpQuality",
            "rdpFps",
            "rdpTouchMode",
            "rdpTouchSensitivity",
            "rdpDomain",
        )

        private val TERMINAL_ONLY_FIELDS = setOf("encoding")

        /**
         * Fields a protocol may name.
         *
         * Omitting an inapplicable field from the mask leaves the server value untouched, so a user
         * who switches a connection to SSH and back does not lose their RDP settings.
         */
        fun fieldsFor(protocol: Protocol): List<String> = FIELD_READERS.keys.filter { field ->
            when {
                field in RDP_ONLY_FIELDS -> protocol == Protocol.RDP
                field in TERMINAL_ONLY_FIELDS -> protocol.isTerminal
                field == "sshKeyId" -> protocol == Protocol.SSH
                else -> true
            }
        }

        /** Telnet is the only protocol Zephyr allows the legacy code pages on. */
        fun availableEncodings(protocol: Protocol): List<TerminalEncoding> =
            if (protocol == Protocol.TELNET) {
                TerminalEncoding.entries.toList()
            } else {
                listOf(TerminalEncoding.UTF8)
            }

        /** Presence shown for a secret the user has not touched in this session. */
        fun presenceFor(state: SecretState, stored: SecretPresence): SecretPresence = when (state) {
            SecretState.Unchanged -> stored
            SecretState.Clear -> SecretPresence.absent
            is SecretState.Replace -> SecretPresence(hasValue = true)
        }
    }
}
