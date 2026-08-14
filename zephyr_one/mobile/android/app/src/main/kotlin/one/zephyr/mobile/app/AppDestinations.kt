package one.zephyr.mobile.app

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.launch
import one.zephyr.mobile.BuildConfig
import one.zephyr.mobile.app.di.AccountContainer
import one.zephyr.mobile.data.repository.SettingsRepository
import one.zephyr.mobile.feature.notes.DownloadsRoute
import one.zephyr.mobile.feature.notes.NoteEditorRoute
import one.zephyr.mobile.feature.notes.NoteEditorViewModel
import one.zephyr.mobile.feature.notes.NoteListRoute
import one.zephyr.mobile.feature.notes.NoteListViewModel
import one.zephyr.mobile.feature.notes.SftpPlaceholderRoute
import one.zephyr.mobile.feature.notes.SnippetEditorRoute
import one.zephyr.mobile.feature.notes.SnippetEditorViewModel
import one.zephyr.mobile.feature.notes.SnippetListRoute
import one.zephyr.mobile.feature.notes.SnippetListViewModel
import one.zephyr.mobile.feature.tools.AppearanceSettingsScreen
import one.zephyr.mobile.feature.tools.AppLockSettingsScreen
import one.zephyr.mobile.feature.tools.BackupRestoreScreen
import one.zephyr.mobile.feature.tools.DockerMonitorScreen
import one.zephyr.mobile.feature.tools.FileSyncScreen
import one.zephyr.mobile.feature.tools.LanguageSettingsScreen
import one.zephyr.mobile.feature.tools.NetworkSettingsScreen
import one.zephyr.mobile.feature.tools.OpsSection
import one.zephyr.mobile.feature.tools.ResourceEditorRoute
import one.zephyr.mobile.feature.tools.ResourceEditorViewModel
import one.zephyr.mobile.feature.tools.ResourceKind
import one.zephyr.mobile.feature.tools.ResourceListRoute
import one.zephyr.mobile.feature.tools.ResourceListViewModel
import one.zephyr.mobile.feature.tools.RuntimeStatusScreen
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.NetworkPolicy
import one.zephyr.mobile.model.Note
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Snippet
import one.zephyr.mobile.security.BiometricAvailability
import one.zephyr.mobile.security.LockDelay
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrThemeId
import java.util.UUID

@Composable
internal fun LibraryCreateDialog(
    onDismiss: () -> Unit,
    onNote: () -> Unit,
    onSnippet: () -> Unit,
    onFiles: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("新建到资料库") },
        text = {
            Column {
                Text("新建笔记", modifier = Modifier.fillMaxWidth().clickable(onClick = onNote).padding(vertical = ZephyrSpacing.md))
                Text("新建代码片段", modifier = Modifier.fillMaxWidth().clickable(onClick = onSnippet).padding(vertical = ZephyrSpacing.md))
                Text("打开远程文件", modifier = Modifier.fillMaxWidth().clickable(onClick = onFiles).padding(vertical = ZephyrSpacing.md))
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

@Composable
internal fun NotesDestination(
    account: AccountContainer,
    ownerUserId: String,
    onBack: () -> Unit,
    onOpen: (Note) -> Unit,
    onCreate: () -> Unit,
) {
    val network by account.network.collectAsState(initial = one.zephyr.mobile.network.NetworkState.offline)
    NoteListRoute(
        viewModel = viewModel(
            key = "notes",
            factory = NoteListViewModel.factory(
                notes = account.notes,
                ownerUserId = ownerUserId,
                online = network.connected,
                bound = !account.isLocalMode,
                lastSyncedAt = account.binding.lastSyncAt,
            ),
        ),
        nowMs = System.currentTimeMillis(),
        onBack = onBack,
        onOpen = onOpen,
        onCreate = onCreate,
    )
}

@Composable
internal fun NoteEditorDestination(
    account: AccountContainer,
    ownerUserId: String,
    noteId: String?,
    onBack: () -> Unit,
    onMessage: suspend (String) -> Unit,
) {
    NoteEditorRoute(
        viewModel = viewModel(
            key = "note-editor:" + (noteId ?: "new"),
            factory = NoteEditorViewModel.factory(account.notes, ownerUserId, noteId),
        ),
        onBack = onBack,
        onMessage = onMessage,
    )
}

@Composable
internal fun SnippetsDestination(
    account: AccountContainer,
    ownerUserId: String,
    onBack: () -> Unit,
    onOpen: (Snippet) -> Unit,
    onCreate: () -> Unit,
    onInsert: (Snippet) -> Unit,
    onRun: (Snippet) -> Unit,
) {
    SnippetListRoute(
        viewModel = viewModel(
            key = "snippets",
            factory = SnippetListViewModel.factory(account.notes, ownerUserId),
        ),
        onBack = onBack,
        onOpen = onOpen,
        onCreate = onCreate,
        onInsert = onInsert,
        onRun = onRun,
    )
}

@Composable
internal fun SnippetEditorDestination(
    account: AccountContainer,
    ownerUserId: String,
    snippetId: String?,
    onBack: () -> Unit,
    onMessage: suspend (String) -> Unit,
) {
    SnippetEditorRoute(
        viewModel = viewModel(
            key = "snippet-editor:" + (snippetId ?: "new"),
            factory = SnippetEditorViewModel.factory(account.notes, ownerUserId, snippetId),
        ),
        onBack = onBack,
        onMessage = onMessage,
    )
}

@Composable
internal fun FilesDestination(
    account: AccountContainer,
    ownerUserId: String,
    onBack: () -> Unit,
    onOpenConnection: (Connection) -> Unit,
) {
    val connections by account.connections.observeAll(ownerUserId).collectAsState(initial = emptyList())
    SftpPlaceholderRoute(
        connections = connections,
        onBack = onBack,
        onOpenConnection = onOpenConnection,
    )
}

@Composable
internal fun DownloadsDestination(onBack: () -> Unit) {
    DownloadsRoute(downloads = emptyList(), onBack = onBack)
}

@Composable
internal fun AppearanceDestination(account: AccountContainer, onBack: () -> Unit) {
    val prefs by account.settings.observePreferences().collectAsState(initial = emptyMap())
    val scope = rememberCoroutineScope()
    val themeId = ZephyrThemeId.fromWire(prefs[SettingsRepository.PREF_THEME]?.let { one.zephyr.mobile.data.EntityCodec.string(it, "value") })
    val mode = prefs[SettingsRepository.PREF_AUTO_THEME]?.let { one.zephyr.mobile.data.EntityCodec.string(it, "value") } ?: "auto"
    AppearanceSettingsScreen(
        themeId = themeId,
        mode = mode,
        onTheme = { id ->
            scope.launch {
                val now = System.currentTimeMillis()
                account.settings.putStringPreference(SettingsRepository.PREF_THEME, id.wireName, now)
                runCatching {
                    account.settings.updateSection(
                        entityType = "oneUserSettings",
                        sectionKey = "default",
                        dottedKeys = listOf("appearance.theme"),
                        values = kotlinx.serialization.json.JsonObject(
                            mapOf("appearance.theme" to kotlinx.serialization.json.JsonPrimitive(id.wireName)),
                        ),
                        ownerUserId = account.binding.userId,
                    )
                }
            }
        },
        onMode = { value ->
            scope.launch {
                val now = System.currentTimeMillis()
                account.settings.putStringPreference(SettingsRepository.PREF_AUTO_THEME, value, now)
                runCatching {
                    account.settings.updateSection(
                        entityType = "oneUserSettings",
                        sectionKey = "default",
                        dottedKeys = listOf("appearance.autoThemeEnabled", "appearance.colorScheme"),
                        values = kotlinx.serialization.json.JsonObject(
                            mapOf(
                                "appearance.autoThemeEnabled" to kotlinx.serialization.json.JsonPrimitive(value == "auto"),
                                "appearance.colorScheme" to kotlinx.serialization.json.JsonPrimitive(value),
                            ),
                        ),
                        ownerUserId = account.binding.userId,
                    )
                }
            }
        },
        onBack = onBack,
    )
}

@Composable
internal fun LanguageDestination(account: AccountContainer, onBack: () -> Unit) {
    val prefs by account.settings.observePreferences().collectAsState(initial = emptyMap())
    val scope = rememberCoroutineScope()
    val selected = prefs[SettingsRepository.PREF_LANGUAGE]?.let { one.zephyr.mobile.data.EntityCodec.string(it, "value") } ?: "system"
    LanguageSettingsScreen(
        selected = selected,
        onSelect = { code ->
            scope.launch { account.settings.putStringPreference(SettingsRepository.PREF_LANGUAGE, code, System.currentTimeMillis()) }
        },
        onBack = onBack,
    )
}

@Composable
internal fun AppLockDestination(account: AccountContainer, container: one.zephyr.mobile.app.di.AppContainer, onBack: () -> Unit) {
    val prefs by account.settings.observePreferences().collectAsState(initial = emptyMap())
    val scope = rememberCoroutineScope()
    val enabled = prefs[SettingsRepository.PREF_APP_LOCK_ENABLED]?.let { one.zephyr.mobile.data.EntityCodec.bool(it, "value", false) } ?: false
    val delay = when (prefs[SettingsRepository.PREF_APP_LOCK_TIMEOUT]?.let { one.zephyr.mobile.data.EntityCodec.string(it, "value") }) {
        "1m" -> LockDelay.ONE_MINUTE
        "5m" -> LockDelay.FIVE_MINUTES
        else -> LockDelay.IMMEDIATE
    }
    val screenshot = prefs[SettingsRepository.PREF_SCREENSHOT_GUARD]?.let { one.zephyr.mobile.data.EntityCodec.bool(it, "value", false) } ?: false
    val availability = when (container.appLock.availability()) {
        BiometricAvailability.AVAILABLE -> "此设备可以使用系统生物识别或设备凭据"
        BiometricAvailability.NONE_ENROLLED -> "尚未录入生物识别或设备凭据，无法启用"
        BiometricAvailability.NO_HARDWARE, BiometricAvailability.HARDWARE_UNAVAILABLE, BiometricAvailability.UNSUPPORTED -> "此设备不支持平台认证，本地解锁不可用"
        else -> "平台认证当前不可用"
    }
    AppLockSettingsScreen(
        enabled = enabled,
        delay = delay,
        screenshotGuard = screenshot,
        availability = availability,
        onEnabled = { value ->
            scope.launch {
                account.settings.putBooleanPreference(SettingsRepository.PREF_APP_LOCK_ENABLED, value, System.currentTimeMillis())
            }
        },
        onDelay = { value ->
            val wire = when (value) {
                LockDelay.ONE_MINUTE -> "1m"
                LockDelay.FIVE_MINUTES -> "5m"
                LockDelay.IMMEDIATE -> "immediate"
            }
            scope.launch { account.settings.putStringPreference(SettingsRepository.PREF_APP_LOCK_TIMEOUT, wire, System.currentTimeMillis()) }
        },
        onScreenshot = { value ->
            scope.launch { account.settings.putBooleanPreference(SettingsRepository.PREF_SCREENSHOT_GUARD, value, System.currentTimeMillis()) }
        },
        onBack = onBack,
    )
}

@Composable
internal fun NetworkDestination(account: AccountContainer, onBack: () -> Unit) {
    val settings by account.syncSettingsState.collectAsState()
    val scope = rememberCoroutineScope()
    NetworkSettingsScreen(
        policy = settings.networkPolicy,
        onPolicy = { policy ->
            account.updateSyncSettings { it.copy(networkPolicy = policy) }
            scope.launch {
                account.settings.putStringPreference(
                    SettingsRepository.PREF_CELLULAR_POLICY,
                    policy.wireName,
                    System.currentTimeMillis(),
                )
            }
        },
        onBack = onBack,
    )
}

@Composable
internal fun FileSyncDestination(
    account: AccountContainer,
    onBack: () -> Unit,
    onOpenTokens: () -> Unit,
    onOpenConflicts: () -> Unit,
    onOpenDevices: () -> Unit,
    onOpenShares: () -> Unit,
    onUnbind: (() -> Unit)?,
    onSyncNow: () -> Unit,
) {
    val status by account.syncEngine.status.collectAsState(initial = one.zephyr.mobile.model.SyncStatus.unbound())
    val settings by account.syncSettingsState.collectAsState()
    FileSyncScreen(
        status = status,
        settings = settings,
        localMode = account.isLocalMode,
        onAutomatic = { enabled -> account.updateSyncSettings { it.copy(automaticEnabled = enabled) } },
        onInterval = { seconds -> account.updateSyncSettings { it.copy(intervalSec = seconds) } },
        onPolicy = { policy -> account.updateSyncSettings { it.copy(networkPolicy = policy) } },
        onSyncNow = onSyncNow,
        onOpenTokens = onOpenTokens,
        onOpenConflicts = onOpenConflicts,
        onOpenDevices = onOpenDevices,
        onOpenShares = onOpenShares,
        onUnbind = onUnbind,
        onBack = onBack,
    )
}

@Composable
internal fun ResourceListDestination(
    account: AccountContainer,
    ownerUserId: String,
    kind: ResourceKind,
    onBack: () -> Unit,
    onCreate: () -> Unit,
    onOpen: (String) -> Unit,
) {
    ResourceListRoute(
        viewModel = viewModel(
            key = "resources:" + kind.name,
            factory = ResourceListViewModel.factory(account.resources, account.connections, ownerUserId, kind),
        ),
        onBack = onBack,
        onCreate = onCreate,
        onOpen = onOpen,
    )
}

@Composable
internal fun ResourceEditorDestination(
    account: AccountContainer,
    ownerUserId: String,
    kind: ResourceKind,
    entityId: String?,
    onBack: () -> Unit,
    onMessage: suspend (String) -> Unit,
) {
    val connections by account.connections.observeAll(ownerUserId).collectAsState(initial = emptyList())
    val usable = remember(connections) {
        connections.filter { it.protocol == Protocol.SSH && it.capabilities.canUse }.map { it.id }.toSet()
    }
    ResourceEditorRoute(
        viewModel = viewModel(
            key = "resource-editor:" + kind.name + ":" + (entityId ?: "new"),
            factory = ResourceEditorViewModel.factory(
                resources = account.resources,
                ownerUserId = ownerUserId,
                kind = kind,
                entityId = entityId,
                usableConnectionIds = { usable },
            ),
        ),
        usableConnectionIds = usable,
        connections = connections,
        onBack = onBack,
        onMessage = onMessage,
    )
}

@Composable
internal fun OpsDestination(
    account: AccountContainer,
    ownerUserId: String,
    section: OpsSection,
    onBack: () -> Unit,
) {
    val connections by account.connections.observeAll(ownerUserId).collectAsState(initial = emptyList())
    DockerMonitorScreen(connections = connections, section = section, onBack = onBack)
}

@Composable
internal fun ServerSettingsLiveDestination(
    account: AccountContainer,
    ownerUserId: String,
    onBack: () -> Unit,
    onMessage: (String) -> Unit,
) {
    one.zephyr.mobile.feature.tools.ServerSettingsLiveRoute(
        settings = account.settings,
        ownerUserId = ownerUserId,
        onBack = onBack,
        onMessage = onMessage,
    )
}

@Composable
internal fun BackupDestination(account: AccountContainer, onBack: () -> Unit) {
    BackupRestoreScreen(localMode = account.isLocalMode, onBack = onBack)
}

@Composable
internal fun RuntimeDestination(account: AccountContainer, onBack: () -> Unit) {
    val status by account.syncEngine.status.collectAsState(initial = one.zephyr.mobile.model.SyncStatus.unbound())
    RuntimeStatusScreen(
        appVersion = BuildConfig.VERSION_NAME,
        localMode = account.isLocalMode,
        pending = status.pendingCount,
        conflicts = status.conflictCount,
        onBack = onBack,
    )
}

@Composable
internal fun ClientTokenLiveDestination(
    account: AccountContainer,
    ownerUserId: String,
    onBack: () -> Unit,
    onMessage: suspend (String) -> Unit,
) {
    val broker = remember(account) {
        one.zephyr.mobile.feature.tools.SensitiveGrantBroker(account.api, account.isLocalMode)
    }
    one.zephyr.mobile.feature.tools.ClientTokenLiveRoute(
        viewModel = viewModel(
            key = "tokens",
            factory = one.zephyr.mobile.feature.tools.ClientTokenViewModel.factory(
                tokens = account.tokens,
                ownerUserId = ownerUserId,
                broker = broker,
                localMode = account.isLocalMode,
            ),
        ),
        localMode = account.isLocalMode,
        onBack = onBack,
        onMessage = onMessage,
    )
}

@Composable
internal fun ConflictCenterDestination(
    account: AccountContainer,
    onBack: () -> Unit,
    onMessage: (String) -> Unit,
) {
    one.zephyr.mobile.feature.tools.ConflictCenterRoute(
        conflicts = account.conflicts,
        onBack = onBack,
        onMessage = onMessage,
    )
}

@Composable
internal fun DeviceListDestination(
    account: AccountContainer,
    onBack: () -> Unit,
    onMessage: (String) -> Unit,
) {
    one.zephyr.mobile.feature.tools.DeviceListRoute(
        api = account.api,
        localMode = account.isLocalMode,
        currentDeviceId = account.binding.deviceId,
        broker = one.zephyr.mobile.feature.tools.SensitiveGrantBroker(account.api, account.isLocalMode),
        onBack = onBack,
        onMessage = onMessage,
    )
}

@Composable
internal fun LocalSharesDestination(
    account: AccountContainer,
    onBack: () -> Unit,
    onMessage: (String) -> Unit,
) {
    var grants by remember { mutableStateOf(account.shareGrants.all()) }
    val authorizer = one.zephyr.mobile.feature.filesync.rememberDirectoryAuthorizer(
        grants = account.shareGrants,
        requestWrite = true,
        profileIdFactory = { java.util.UUID.randomUUID().toString() },
        shareNameFactory = { "PHONE" },
        onResult = { result ->
            grants = account.shareGrants.all()
            when (result) {
                is one.zephyr.mobile.feature.filesync.DirectoryAuthorizationResult.Authorized ->
                    onMessage("已授权 ${result.grant.shareName}")
                one.zephyr.mobile.feature.filesync.DirectoryAuthorizationResult.Cancelled -> Unit
                one.zephyr.mobile.feature.filesync.DirectoryAuthorizationResult.Refused ->
                    onMessage("系统未能保留该目录授权")
            }
        },
    )
    one.zephyr.mobile.feature.tools.LocalSharesRoute(
        grants = grants,
        onPick = authorizer,
        onRevoke = { id ->
            account.shareGrants.revoke(id)
            grants = account.shareGrants.all()
            onMessage("已撤销")
        },
        onBack = onBack,
    )
}

@Composable
internal fun DiagnosticsLiveDestination(
    account: AccountContainer,
    onBack: () -> Unit,
    onExport: () -> Unit,
) {
    val status by account.syncEngine.status.collectAsState(initial = one.zephyr.mobile.model.SyncStatus.unbound())
    one.zephyr.mobile.feature.tools.DiagnosticsLiveRoute(
        appVersion = BuildConfig.VERSION_NAME,
        localMode = account.isLocalMode,
        bindingLabel = account.binding.username + " @ " + account.binding.deviceName,
        pending = status.pendingCount,
        conflicts = status.conflictCount,
        lastError = status.lastError?.code,
        onExport = onExport,
        onBack = onBack,
    )
}

@Composable
internal fun AiSettingsLiveDestination(
    account: AccountContainer,
    ownerUserId: String,
    onBack: () -> Unit,
) {
    one.zephyr.mobile.feature.tools.AiSettingsLiveRoute(
        settings = account.settings,
        ownerUserId = ownerUserId,
        onBack = onBack,
    )
}

internal fun diagnosticExport(account: AccountContainer): String =
    "one=${BuildConfig.VERSION_NAME} mode=${if (account.isLocalMode) "local" else "bound"} state=${account.binding.state.name} device=${account.binding.deviceId.take(8)}"
