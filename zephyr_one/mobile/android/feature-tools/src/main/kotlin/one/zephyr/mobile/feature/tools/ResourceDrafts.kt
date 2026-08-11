package one.zephyr.mobile.feature.tools

import one.zephyr.mobile.model.JumpHost
import one.zephyr.mobile.model.Proxy
import one.zephyr.mobile.model.ProxyType
import one.zephyr.mobile.model.SecretPresence
import one.zephyr.mobile.model.SecretState
import one.zephyr.mobile.model.SshKey

/**
 * The three S43 resource kinds.
 *
 * An enum rather than three unrelated screens because SCREEN_CATALOG.md 18 gives them one shared
 * contract: owner/shared/capability, revision conflict, share sheet and reference-checked delete. The
 * entity type is carried here so a caller cannot pass a string the registry does not know.
 */
enum class ResourceKind(val entityType: String) {
    PROXY(Proxy.ENTITY_TYPE),
    SSH_KEY(SshKey.ENTITY_TYPE),
    JUMP_HOST(JumpHost.ENTITY_TYPE),
}

/** One validation failure, tied to the field that caused it so the editor can point at it. */
data class ResourceIssue(val field: String, val message: String)

/**
 * S43 Proxy editor state.
 *
 * Carries [original] beside [current] for the same reason the connection editor does: the fieldMask
 * is a diff, "unsaved changes" is a diff, and a masked secret is exactly the field that must not be
 * diffed. Without the pair, "user cleared the password" and "user never touched it" are the same
 * value.
 *
 * @param original null when creating, which pushes the whole editable field set because the server
 *   has no row to merge against.
 * @param portWasEdited once true, switching proxy type stops moving the port.
 */
data class ProxyDraft(
    val original: Proxy?,
    val current: Proxy,
    val portWasEdited: Boolean = false,
    val password: SecretState = SecretState.Unchanged,
) {
    val isCreate: Boolean get() = original == null

    val isDirty: Boolean
        get() = isCreate || current != original || password.contributesToFieldMask

    /**
     * Type switch.
     *
     * SOCKS5 defaults to 1080 and HTTP CONNECT to 8080, so an untouched port follows the type. A port
     * the user chose survives, because silently moving it would discard what they typed.
     */
    fun withType(next: ProxyType): ProxyDraft {
        if (next == current.type) return this
        val nextPort = if (portWasEdited) current.port else next.defaultPort
        return copy(current = current.copy(type = next, port = nextPort))
    }

    fun withPort(port: Int): ProxyDraft =
        copy(current = current.copy(port = port), portWasEdited = true)

    fun withName(name: String): ProxyDraft = copy(current = current.copy(name = name))

    fun withHost(host: String): ProxyDraft = copy(current = current.copy(host = host))

    fun withUsername(username: String): ProxyDraft = copy(current = current.copy(username = username))

    fun withVisibility(visibility: String): ProxyDraft =
        copy(current = current.copy(visibility = visibility))

    /** A blank replacement folds to Clear: an empty plaintext is not a usable credential. */
    fun withPassword(state: SecretState): ProxyDraft = copy(password = ResourceDrafts.foldSecret(state))

    fun normalized(): Proxy = current.copy(
        name = current.name.trim(),
        host = current.host.trim(),
        username = current.username.trim(),
    )

    fun validate(): List<ResourceIssue> = buildList {
        val candidate = normalized()
        if (candidate.name.isEmpty()) add(ResourceIssue(FIELD_NAME, ResourceDrafts.MSG_NAME_REQUIRED))
        if (candidate.host.isEmpty()) add(ResourceIssue(FIELD_HOST, ResourceDrafts.MSG_HOST_REQUIRED))
        if (candidate.port !in ResourceDrafts.MIN_PORT..ResourceDrafts.MAX_PORT) {
            add(ResourceIssue(FIELD_PORT, ResourceDrafts.MSG_PORT_RANGE))
        }
    }

    fun changedFields(): List<String> {
        val base = original ?: return FIELDS
        val candidate = normalized()
        return FIELDS.filter { field -> READERS.getValue(field)(candidate) != READERS.getValue(field)(base) }
    }

    fun secretStates(): Map<String, SecretState> = mapOf("password" to password)

    val canSave: Boolean get() = validate().isEmpty() && isDirty

    /** Presence to render for a secret the user has not touched this session. */
    fun passwordPresence(): SecretPresence =
        ResourceDrafts.presenceFor(password, original?.password ?: SecretPresence.absent)

    companion object {
        const val FIELD_NAME = "name"
        const val FIELD_HOST = "host"
        const val FIELD_PORT = "port"

        fun create(ownerUserId: String, id: String): ProxyDraft = ProxyDraft(
            original = null,
            current = Proxy(
                id = id,
                ownerUserId = ownerUserId,
                name = "",
                host = "",
                type = ProxyType.default,
                port = ProxyType.default.defaultPort,
            ),
        )

        /**
         * portWasEdited is derived rather than assumed: a port still equal to its type's default was
         * never deliberately chosen, so it should keep following the default on a type switch.
         */
        fun edit(proxy: Proxy): ProxyDraft = ProxyDraft(
            original = proxy,
            current = proxy,
            portWasEdited = proxy.port != proxy.type.defaultPort,
        )

        /** Registry editableFields for proxy, in registry order. */
        private val READERS: Map<String, (Proxy) -> Any?> = linkedMapOf(
            "name" to { p: Proxy -> p.name },
            "host" to { p: Proxy -> p.host },
            "port" to { p: Proxy -> p.port },
            "type" to { p: Proxy -> p.type.wireName },
            "username" to { p: Proxy -> p.username },
            "visibility" to { p: Proxy -> p.visibility },
        )

        val FIELDS: List<String> = READERS.keys.toList()
    }
}

/**
 * S43 SSH Key editor state.
 *
 * Two independent secrets, each with its own tri-state: a passphrase change must not force the key
 * material to be re-sent, and vice versa. Folding them into one flag would make every passphrase
 * edit re-upload the private key.
 */
data class SshKeyDraft(
    val original: SshKey?,
    val current: SshKey,
    val privateKey: SecretState = SecretState.Unchanged,
    val passphrase: SecretState = SecretState.Unchanged,
) {
    val isCreate: Boolean get() = original == null

    val isDirty: Boolean
        get() = isCreate ||
            current != original ||
            privateKey.contributesToFieldMask ||
            passphrase.contributesToFieldMask

    fun withName(name: String): SshKeyDraft = copy(current = current.copy(name = name))

    fun withRemark(remark: String): SshKeyDraft = copy(current = current.copy(remark = remark))

    fun withVisibility(visibility: String): SshKeyDraft =
        copy(current = current.copy(visibility = visibility))

    fun withPrivateKey(state: SecretState): SshKeyDraft =
        copy(privateKey = ResourceDrafts.foldSecret(state))

    /**
     * A blank passphrase is folded to Clear like any other secret.
     *
     * That is correct here rather than merely consistent: an unencrypted private key legitimately has
     * no passphrase, so "cleared" is a real state and not an input error.
     */
    fun withPassphrase(state: SecretState): SshKeyDraft =
        copy(passphrase = ResourceDrafts.foldSecret(state))

    fun normalized(): SshKey = current.copy(
        name = current.name.trim(),
        remark = current.remark.trim(),
    )

    /**
     * Validation.
     *
     * A create must carry key material, because a key row with no key cannot authenticate anything.
     * An edit may leave it Unchanged, which is the whole point of the tri-state. No format check is
     * attempted: the main end parses the PEM, and a client-side guess would reject formats Zephyr
     * accepts.
     */
    fun validate(): List<ResourceIssue> = buildList {
        val candidate = normalized()
        if (candidate.name.isEmpty()) add(ResourceIssue(FIELD_NAME, ResourceDrafts.MSG_NAME_REQUIRED))
        val hasStoredKey = original?.privateKey?.hasValue == true
        val willHaveKey = when (privateKey) {
            is SecretState.Replace -> true
            SecretState.Clear -> false
            SecretState.Unchanged -> hasStoredKey
        }
        if (!willHaveKey) add(ResourceIssue(FIELD_PRIVATE_KEY, MSG_KEY_REQUIRED))
    }

    fun changedFields(): List<String> {
        val base = original ?: return FIELDS
        val candidate = normalized()
        return FIELDS.filter { field -> READERS.getValue(field)(candidate) != READERS.getValue(field)(base) }
    }

    fun secretStates(): Map<String, SecretState> =
        mapOf("privateKey" to privateKey, "passphrase" to passphrase)

    val canSave: Boolean get() = validate().isEmpty() && isDirty

    fun privateKeyPresence(): SecretPresence =
        ResourceDrafts.presenceFor(privateKey, original?.privateKey ?: SecretPresence.absent)

    fun passphrasePresence(): SecretPresence =
        ResourceDrafts.presenceFor(passphrase, original?.passphrase ?: SecretPresence.absent)

    companion object {
        const val FIELD_NAME = "name"
        const val FIELD_PRIVATE_KEY = "privateKey"

        const val MSG_KEY_REQUIRED = "请粘贴私钥内容"

        fun create(ownerUserId: String, id: String): SshKeyDraft = SshKeyDraft(
            original = null,
            current = SshKey(id = id, ownerUserId = ownerUserId, name = ""),
        )

        fun edit(key: SshKey): SshKeyDraft = SshKeyDraft(original = key, current = key)

        private val READERS: Map<String, (SshKey) -> Any?> = linkedMapOf(
            "name" to { k: SshKey -> k.name },
            "remark" to { k: SshKey -> k.remark },
            "visibility" to { k: SshKey -> k.visibility },
        )

        val FIELDS: List<String> = READERS.keys.toList()
    }
}

/**
 * S43 JumpHost editor state.
 *
 * A jump host is a named pointer at an SSH connection, so the dependency is validated against what
 * the user may actually use: ZEPHYR_PARITY.md 5.3 requires the referenced connection to exist and
 * carry USE before it may be referenced.
 */
data class JumpHostDraft(
    val original: JumpHost?,
    val current: JumpHost,
) {
    val isCreate: Boolean get() = original == null

    val isDirty: Boolean get() = isCreate || current != original

    fun withName(name: String): JumpHostDraft = copy(current = current.copy(name = name))

    fun withConnection(connectionId: String): JumpHostDraft =
        copy(current = current.copy(connectionId = connectionId))

    fun withVisibility(visibility: String): JumpHostDraft =
        copy(current = current.copy(visibility = visibility))

    fun normalized(): JumpHost = current.copy(name = current.name.trim())

    /**
     * @param usableConnectionIds SSH connections carrying USE. Passed in so this stays pure: the
     *   repository resolves capability, the draft only decides what that means for this edit.
     */
    fun validate(usableConnectionIds: Set<String>): List<ResourceIssue> = buildList {
        val candidate = normalized()
        if (candidate.name.isEmpty()) add(ResourceIssue(FIELD_NAME, ResourceDrafts.MSG_NAME_REQUIRED))
        when {
            candidate.connectionId.isEmpty() ->
                add(ResourceIssue(FIELD_CONNECTION, MSG_CONNECTION_REQUIRED))
            // Reported as a repair rather than a generic invalid value: the connection may have been
            // deleted or un-shared since this jump host was created, and the remedy is re-picking.
            candidate.connectionId !in usableConnectionIds ->
                add(ResourceIssue(FIELD_CONNECTION, MSG_CONNECTION_UNUSABLE))
        }
    }

    fun changedFields(): List<String> {
        val base = original ?: return FIELDS
        val candidate = normalized()
        return FIELDS.filter { field -> READERS.getValue(field)(candidate) != READERS.getValue(field)(base) }
    }

    fun canSave(usableConnectionIds: Set<String>): Boolean =
        validate(usableConnectionIds).isEmpty() && isDirty

    companion object {
        const val FIELD_NAME = "name"
        const val FIELD_CONNECTION = "connectionId"

        const val MSG_CONNECTION_REQUIRED = "请选择一个 SSH 连接"
        const val MSG_CONNECTION_UNUSABLE = "所选连接已不可用，请重新选择"

        fun create(ownerUserId: String, id: String): JumpHostDraft = JumpHostDraft(
            original = null,
            current = JumpHost(id = id, ownerUserId = ownerUserId, name = "", connectionId = ""),
        )

        fun edit(host: JumpHost): JumpHostDraft = JumpHostDraft(original = host, current = host)

        private val READERS: Map<String, (JumpHost) -> Any?> = linkedMapOf(
            "name" to { h: JumpHost -> h.name },
            "connectionId" to { h: JumpHost -> h.connectionId },
            "visibility" to { h: JumpHost -> h.visibility },
        )

        val FIELDS: List<String> = READERS.keys.toList()
    }
}

/** Rules the three drafts share, kept in one place so they cannot drift apart. */
object ResourceDrafts {

    const val MIN_PORT = 1
    const val MAX_PORT = 65535

    const val MSG_NAME_REQUIRED = "请输入名称"
    const val MSG_HOST_REQUIRED = "请输入主机地址"
    const val MSG_PORT_RANGE = "端口需在 1 到 65535 之间"

    const val VISIBILITY_PRIVATE = "private"

    /**
     * A blank replacement is a clear, not a new secret.
     *
     * Storing an empty plaintext would write a credential that cannot authenticate, and the user
     * emptying a field means they want it gone.
     */
    fun foldSecret(state: SecretState): SecretState =
        if (state is SecretState.Replace && state.isBlank) {
            state.wipe()
            SecretState.Clear
        } else {
            state
        }

    fun presenceFor(state: SecretState, stored: SecretPresence): SecretPresence = when (state) {
        SecretState.Unchanged -> stored
        SecretState.Clear -> SecretPresence.absent
        is SecretState.Replace -> SecretPresence(hasValue = true)
    }
}
