package one.zephyr.mobile.feature.connections

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.data.LocalWriteRejected
import one.zephyr.mobile.data.repository.ConnectionRepository
import one.zephyr.mobile.data.repository.ResourceRepository
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.JumpHost
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Proxy
import one.zephyr.mobile.model.SshKey
import one.zephyr.mobile.security.LockSensitiveSink

/** Everything the S11 form renders. */
data class ConnectionEditorUiState(
    val draft: ConnectionDraft,
    val inventory: RouteInventory = RouteInventory(),
    val proxies: List<Proxy> = emptyList(),
    val sshKeys: List<SshKey> = emptyList(),
    val jumpHosts: List<JumpHost> = emptyList(),
    /** Populated only after a save attempt, so a pristine form is not covered in red. */
    val issues: List<DraftIssue> = emptyList(),
    val saving: Boolean = false,
    val testing: Boolean = false,
    val testResult: ConnectionTestResult? = null,
) {
    val sections: List<EditorSection> get() = draft.sections()

    /** Route repair is shown while editing, because it reflects revoked access rather than typing. */
    val routeIssues: List<DraftIssue> get() = draft.routeIssues(inventory)

    fun issueFor(field: String): DraftIssue? =
        issues.firstOrNull { it.field == field } ?: routeIssues.firstOrNull { it.field == field }
}

/** What the editor asks the host navigation to do. */
sealed interface ConnectionEditorEvent {
    data object Dismissed : ConnectionEditorEvent

    /**
     * @param persisted false for 不保存直接连接, where the connection exists only for this session and
     *   must never be written to the mirror (ZEPHYR_PARITY.md 5.1 ephemeral).
     */
    data class Connect(val connection: Connection, val persisted: Boolean) : ConnectionEditorEvent
}

/**
 * S11 连接编辑器.
 *
 * All editing rules live in [ConnectionDraft]; this class only owns loading, the route inventory and
 * the save/test side effects. Keeping the rules out of the ViewModel is what makes them testable
 * without a Looper.
 */
class ConnectionEditorViewModel(
    private val connections: ConnectionRepository,
    resources: ResourceRepository,
    private val ownerUserId: String,
    private val connectionId: String?,
    private val duplicateSourceId: String?,
    private val initialProtocol: Protocol = Protocol.SSH,
    private val newIdFactory: () -> String,
    private val tester: ConnectionTester = UnavailableConnectionTester,
    private val testCredentials: suspend (Connection, ConnectionDraft) -> ConnectionTestCredentials = { _, _ -> ConnectionTestCredentials() },
    private val clock: () -> Long = System::currentTimeMillis,
    private val registerSensitiveSink: (LockSensitiveSink) -> Unit = {},
    private val unregisterSensitiveSink: (LockSensitiveSink) -> Unit = {},
) : ViewModel(), LockSensitiveSink {

    private val page = MutableStateFlow<PageState<ConnectionEditorUiState>>(PageState.InitialLoading)
    val state: StateFlow<PageState<ConnectionEditorUiState>> = page.asStateFlow()

    private val events = MutableSharedFlow<ConnectionEditorEvent>(extraBufferCapacity = 4)
    val event: SharedFlow<ConnectionEditorEvent> = events

    private val messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val message: SharedFlow<String> = messages

    init {
        registerSensitiveSink(this)
        viewModelScope.launch { load() }
        // The inventory is observed rather than read once: an ACL revocation while the editor is
        // open must turn into "路由需要修复" instead of a save-time surprise.
        combine(
            resources.observeProxies(ownerUserId),
            resources.observeSshKeys(ownerUserId),
            resources.observeJumpHosts(ownerUserId),
        ) { proxies, keys, jumps -> Triple(proxies, keys, jumps) }
            .onEach { (proxies, keys, jumps) -> applyInventory(proxies, keys, jumps) }
            .launchIn(viewModelScope)
    }

    private suspend fun load() {
        if (duplicateSourceId != null) {
            val source = connections.find(duplicateSourceId)
            page.value = if (
                source == null || source.isDeleted ||
                source.residency != one.zephyr.mobile.model.Residency.OWNED
            ) {
                PageState.NotFoundOrRevoked
            } else {
                PageState.Content(
                    ConnectionEditorUiState(
                        ConnectionDraft.duplicate(source, ownerUserId, newIdFactory()),
                    ),
                )
            }
            return
        }
        if (connectionId == null) {
            page.value = PageState.Content(
                ConnectionEditorUiState(
                    ConnectionDraft.create(ownerUserId, newIdFactory(), protocol = initialProtocol),
                ),
            )
            return
        }
        val existing = connections.find(connectionId)
        page.value = when {
            existing == null || existing.isDeleted -> PageState.NotFoundOrRevoked
            // A row the user may see but not edit opens read-only rather than pretending to save.
            !existing.capabilities.canEdit ->
                PageState.PermissionDenied(Capability.EDIT, REASON_NO_EDIT)
            else -> PageState.Content(ConnectionEditorUiState(ConnectionDraft.edit(existing)))
        }
    }

    /** Only rows carrying USE may be referenced by a route (ZEPHYR_PARITY.md 5.3). */
    private fun applyInventory(proxies: List<Proxy>, keys: List<SshKey>, jumps: List<JumpHost>) {
        val usable = RouteInventory(
            usableProxyIds = proxies.filter { it.capabilities.canUse && it.deletedAt == null }.map { it.id }.toSet(),
            usableSshKeyIds = keys.filter { it.capabilities.canUse && it.deletedAt == null }.map { it.id }.toSet(),
            usableJumpHostIds = jumps.filter { it.capabilities.canUse && it.deletedAt == null }.map { it.id }.toSet(),
        )
        mutate { it.copy(inventory = usable, proxies = proxies, sshKeys = keys, jumpHosts = jumps) }
    }

    private inline fun mutate(block: (ConnectionEditorUiState) -> ConnectionEditorUiState) {
        val current = page.value
        if (current is PageState.Content) page.value = PageState.Content(block(current.value))
    }

    private inline fun edit(block: (ConnectionDraft) -> ConnectionDraft) {
        // Clearing stale issues on every keystroke keeps a fixed field from staying red until the
        // next save attempt.
        mutate { it.copy(draft = block(it.draft), issues = emptyList(), testResult = null) }
    }

    val draft: ConnectionDraft?
        get() = (page.value as? PageState.Content)?.value?.draft

    // ---- field intents -----------------------------------------------------------------------

    fun setName(value: String) = edit { it.withName(value) }
    fun setHost(value: String) = edit { it.withHost(value) }
    fun setUsername(value: String) = edit { it.withUsername(value) }
    fun setRemark(value: String) = edit { it.withRemark(value) }
    fun setTags(value: List<String>) = edit { it.withTags(value) }
    fun setProtocol(value: Protocol) = edit { it.withProtocol(value) }
    fun setConnectionMode(value: one.zephyr.mobile.model.ConnectionMode) = edit { it.withConnectionMode(value) }
    fun setEncoding(value: one.zephyr.mobile.model.TerminalEncoding) = edit { it.withEncoding(value) }
    fun setProxy(value: String?) = edit { it.withProxy(value) }
    fun setSshKey(value: String?) = edit { it.withSshKey(value) }
    fun setFileSyncIntent(value: one.zephyr.mobile.model.FileSyncDirectoryIntent) =
        edit { it.withFileSyncIntent(value) }
    fun setPassword(value: one.zephyr.mobile.model.SecretState) = edit { it.withPassword(value) }
    fun setPrivateKey(value: one.zephyr.mobile.model.SecretState) = edit { it.withPrivateKey(value) }
    fun setRdp(settings: one.zephyr.mobile.model.RdpSettings) =
        edit { it.copy(current = it.current.copy(rdp = settings)) }
    fun setVisibility(value: String) = edit { it.copy(current = it.current.copy(visibility = value)) }
    fun addJumpHost(id: String) = edit { it.withJumpHostAdded(id) }
    fun removeJumpHost(id: String) = edit { it.withJumpHostRemoved(id) }
    fun moveJumpHost(from: Int, to: Int) = edit { it.withJumpHostMoved(from, to) }

    /** Non-numeric input leaves the port untouched rather than resetting it to zero. */
    fun setPort(raw: String) {
        val parsed = raw.trim().toIntOrNull() ?: return
        edit { it.withPort(parsed) }
    }

    /** Clears a dependency the user no longer has access to. */
    fun repairRoute(field: String) = edit { current ->
        when (field) {
            "proxyId" -> current.withProxy(null)
            "sshKeyId" -> current.withSshKey(null)
            "jumpHostIds" -> current.copy(current = current.current.copy(jumpHostIds = emptyList()))
            else -> current
        }
    }

    // ---- fixed actions -----------------------------------------------------------------------

    /**
     * 保存 / 保存并连接.
     *
     * The completion wording is local-first ("已保存，待同步"): the row is committed to this device and
     * an operation is queued, which is exactly what happened regardless of connectivity
     * (SCREEN_CATALOG.md 2).
     */
    fun save(thenConnect: Boolean = false) {
        val content = page.value as? PageState.Content ?: return
        val ui = content.value
        val issues = ui.draft.validate(ui.inventory)
        if (issues.isNotEmpty()) {
            mutate { it.copy(issues = issues) }
            return
        }
        mutate { it.copy(saving = true, issues = emptyList()) }
        viewModelScope.launch {
            val draft = ui.draft
            val row = draft.normalized()
            val mask = draft.changedFields()
            val secrets = draft.secretStates()
            val hasSecretChange = secrets.values.any { it.contributesToFieldMask }
            val outcome = runCatching {
                // An empty mask with no secret change would be rejected as empty_field_mask, so the
                // overlay-only case (the user changed nothing but the device-local directory intent)
                // deliberately skips the gateway instead of failing.
                if (mask.isNotEmpty() || hasSecretChange) {
                    connections.save(
                        connection = row,
                        mask = mask,
                        secrets = secrets,
                        ownerUserId = ownerUserId,
                        createdLocally = draft.isCreate,
                    )
                }
                if (draft.fileSyncIntentChanged) {
                    connections.setFileSyncIntent(row.id, row.fileSyncIntent, clock())
                }
            }
            mutate { it.copy(saving = false) }
            outcome
                .onSuccess {
                    draft.wipeSecretBuffers()
                    // The saved row becomes the new baseline so the form is no longer dirty.
                    mutate { it.copy(draft = ConnectionDraft.edit(row)) }
                    messages.tryEmit(MSG_SAVED)
                    if (thenConnect) {
                        events.tryEmit(ConnectionEditorEvent.Connect(row, persisted = true))
                    } else {
                        events.tryEmit(ConnectionEditorEvent.Dismissed)
                    }
                }
                .onFailure { failure ->
                    messages.tryEmit(
                        if (failure is LocalWriteRejected) rejectionMessage(failure) else MSG_SAVE_FAILED,
                    )
                }
        }
    }

    private fun rejectionMessage(rejected: LocalWriteRejected): String = when (rejected.reason) {
        "capability_denied" -> REASON_NO_EDIT
        "empty_field_mask" -> MSG_NOTHING_CHANGED
        else -> MSG_SAVE_FAILED
    }

    /**
     * 不保存直接连接.
     *
     * Marked ephemeral so nothing reaches the mirror: the connection lives for this session and is
     * cleaned up after the frozen TTL.
     */
    fun connectWithoutSaving() {
        val content = page.value as? PageState.Content ?: return
        val issues = content.value.draft.validate(content.value.inventory)
        if (issues.isNotEmpty()) {
            mutate { it.copy(issues = issues) }
            return
        }
        val row = content.value.draft.normalized().copy(ephemeral = true)
        events.tryEmit(ConnectionEditorEvent.Connect(row, persisted = false))
        clearSecretBuffers()
    }

    fun test() {
        val content = page.value as? PageState.Content ?: return
        val issues = content.value.draft.validate(content.value.inventory)
        if (issues.isNotEmpty()) {
            mutate { it.copy(issues = issues) }
            return
        }
        mutate { it.copy(testing = true, testResult = null) }
        viewModelScope.launch {
            val row = content.value.draft.normalized()
            val credentials = runCatching { testCredentials(row, content.value.draft) }
                .getOrDefault(ConnectionTestCredentials())
            val result = try {
                runCatching { tester.test(row, credentials) }
                    .getOrElse { failure ->
                        ConnectionTestResult.Failed(
                            one.zephyr.mobile.model.MobileError.local(
                                code = "test_failed",
                                message = failure.message ?: MSG_TEST_FAILED,
                                retryable = true,
                            ),
                        )
                    }
            } finally {
                credentials.wipe()
            }
            mutate { it.copy(testing = false, testResult = result) }
        }
    }

    fun dismiss() {
        clearSecretBuffers()
        events.tryEmit(ConnectionEditorEvent.Dismissed)
    }

    /** Lock/background/navigation disposal all call this same non-persisting cleanup path. */
    fun clearSecretBuffers() {
        mutate { it.copy(draft = it.draft.wipeSecretBuffers()) }
    }

    override fun onLocked() {
        clearSecretBuffers()
    }

    override fun onCleared() {
        unregisterSensitiveSink(this)
        clearSecretBuffers()
        super.onCleared()
    }

    companion object {
        const val REASON_NO_EDIT = "你没有编辑此连接的权限"
        const val MSG_SAVED = "已保存，待同步"
        const val MSG_SAVE_FAILED = "保存未完成，请重试"
        const val MSG_NOTHING_CHANGED = "没有需要保存的修改"
        const val MSG_TEST_FAILED = "测试未完成"

        fun factory(
            connections: ConnectionRepository,
            resources: ResourceRepository,
            ownerUserId: String,
            connectionId: String?,
            duplicateSourceId: String? = null,
            initialProtocol: Protocol = Protocol.SSH,
            newIdFactory: () -> String,
            tester: ConnectionTester = UnavailableConnectionTester,
            testCredentials: suspend (Connection, ConnectionDraft) -> ConnectionTestCredentials = { _, _ -> ConnectionTestCredentials() },
            registerSensitiveSink: (LockSensitiveSink) -> Unit = {},
            unregisterSensitiveSink: (LockSensitiveSink) -> Unit = {},
        ): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = ConnectionEditorViewModel(
                connections = connections,
                resources = resources,
                ownerUserId = ownerUserId,
                connectionId = connectionId,
                duplicateSourceId = duplicateSourceId,
                initialProtocol = initialProtocol,
                newIdFactory = newIdFactory,
                tester = tester,
                testCredentials = testCredentials,
                registerSensitiveSink = registerSensitiveSink,
                unregisterSensitiveSink = unregisterSensitiveSink,
            ) as T
        }
    }
}
