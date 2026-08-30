package one.zephyr.mobile.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.launch
import one.zephyr.mobile.R
import one.zephyr.mobile.security.AppLockPreferences
import one.zephyr.mobile.security.AuthResult
import one.zephyr.mobile.security.UnlockPresentation
import one.zephyr.mobile.BuildConfig
import one.zephyr.mobile.app.di.AccountContainer
import one.zephyr.mobile.data.repository.SettingsRepository
import one.zephyr.mobile.feature.notes.DownloadsRoute
import one.zephyr.mobile.feature.notes.NoteEditorRoute
import one.zephyr.mobile.feature.notes.NoteEditorViewModel
import one.zephyr.mobile.feature.notes.NoteListRoute
import one.zephyr.mobile.feature.notes.NoteListViewModel
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
import one.zephyr.mobile.ui.theme.ZephyrThemeId
import java.util.UUID

@Composable
internal fun LibraryCreateDialog(
    onDismiss: () -> Unit,
    onNote: () -> Unit,
    onSnippet: () -> Unit,
    onFiles: () -> Unit,
) {
    one.zephyr.mobile.ui.component.ActionSheet(
        visible = true,
        onDismiss = onDismiss,
        groups = listOf(
            one.zephyr.mobile.ui.component.ActionSheetGroup(
                items = listOf(
                    one.zephyr.mobile.ui.component.ActionSheetItem("新建笔记", onClick = onNote),
                    one.zephyr.mobile.ui.component.ActionSheetItem("新建代码片段", onClick = onSnippet),
                    one.zephyr.mobile.ui.component.ActionSheetItem("打开远程文件", onClick = onFiles),
                ),
            ),
            one.zephyr.mobile.ui.component.ActionSheetGroup(
                items = listOf(
                    one.zephyr.mobile.ui.component.ActionSheetItem("取消", cancel = true, onClick = onDismiss),
                ),
            ),
        ),
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
    // Creating a note must always yield a fresh ViewModel. A fixed "new" key
    // reuses the previous create's ViewModel (and its draft), so the second new
    // note opens with the first note's content. Generate a one-shot key per
    // entry into the create flow.
    val createKey = remember(noteId) { if (noteId == null) java.util.UUID.randomUUID().toString() else null }
    NoteEditorRoute(
        viewModel = viewModel(
            key = "note-editor:" + (noteId ?: "new-$createKey"),
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
    port: one.zephyr.mobile.feature.notes.SftpPort,
    onBack: () -> Unit,
    onMessage: (String) -> Unit,
) {
    val connections by account.connections.observeAll(ownerUserId).collectAsState(initial = emptyList())
    one.zephyr.mobile.feature.notes.SftpBrowserRoute(
        connections = connections,
        port = port,
        onBack = onBack,
        onMessage = onMessage,
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
    val context = androidx.compose.ui.platform.LocalContext.current
    val selected = prefs[SettingsRepository.PREF_LANGUAGE]?.let { one.zephyr.mobile.data.EntityCodec.string(it, "value") } ?: "system"
    LanguageSettingsScreen(
        selected = selected,
        onSelect = { code ->
            if (code != selected) {
                scope.launch {
                    account.settings.putStringPreference(SettingsRepository.PREF_LANGUAGE, code, System.currentTimeMillis())
                    LocaleController.applyIfNeeded(context, code)
                }
            }
        },
        onBack = onBack,
    )
}

@Composable
internal fun AppLockDestination(account: AccountContainer, container: one.zephyr.mobile.app.di.AppContainer, onBack: () -> Unit) {
    val prefs by account.settings.observePreferences().collectAsState(initial = emptyMap())
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    val enabled = prefs[SettingsRepository.PREF_APP_LOCK_ENABLED]?.let { one.zephyr.mobile.data.EntityCodec.bool(it, "value", false) } ?: false
    val delay = when (prefs[SettingsRepository.PREF_APP_LOCK_TIMEOUT]?.let { one.zephyr.mobile.data.EntityCodec.string(it, "value") }) {
        "1m" -> LockDelay.ONE_MINUTE
        "5m" -> LockDelay.FIVE_MINUTES
        else -> LockDelay.IMMEDIATE
    }
    val screenshot = prefs[SettingsRepository.PREF_SCREENSHOT_GUARD]?.let { one.zephyr.mobile.data.EntityCodec.bool(it, "value", false) } ?: false
    val canEnable = container.appLock.availability() == BiometricAvailability.AVAILABLE
    val availability = status ?: when (container.appLock.availability()) {
        BiometricAvailability.AVAILABLE -> "此设备可以使用系统生物识别或设备凭据"
        BiometricAvailability.NONE_ENROLLED -> "尚未录入生物识别或设备凭据，无法启用"
        BiometricAvailability.NO_HARDWARE, BiometricAvailability.HARDWARE_UNAVAILABLE, BiometricAvailability.UNSUPPORTED -> "此设备不支持平台认证，本地解锁不可用"
        else -> "平台认证当前不可用"
    }
    fun persistCache(nextEnabled: Boolean, nextDelay: LockDelay) {
        AppLockCache.write(
            context.getSharedPreferences(AppLockCache.PREFS, android.content.Context.MODE_PRIVATE),
            nextEnabled,
            nextDelay,
        )
    }
    AppLockSettingsScreen(
        enabled = enabled,
        delay = delay,
        screenshotGuard = screenshot,
        availability = availability,
        canEnable = canEnable,
        busy = busy,
        onEnabled = onEnabled@{ value ->
            if (busy) return@onEnabled
            scope.launch {
                if (value) {
                    if (!canEnable) return@launch
                    busy = true
                    val result = container.appLock.confirmEnable(
                        title = context.getString(R.string.unlock_enable_title),
                        subtitle = context.getString(R.string.unlock_enable_subtitle),
                    )
                    busy = false
                    when (result) {
                        AuthResult.Success -> {
                            status = null
                            AppLockPreferences.apply(
                                lock = container.appLock,
                                enabled = true,
                                delay = delay,
                                lockOnEnable = false,
                            )
                            persistCache(true, delay)
                            account.settings.putBooleanPreference(
                                SettingsRepository.PREF_APP_LOCK_ENABLED,
                                true,
                                System.currentTimeMillis(),
                            )
                        }
                        AuthResult.Cancelled -> status = null
                        is AuthResult.Failed -> {
                            status = UnlockPresentation.failureMessage(
                                result,
                                "平台认证当前不可用，无法启用本地解锁",
                            )
                        }
                    }
                } else {
                    AppLockPreferences.apply(
                        lock = container.appLock,
                        enabled = false,
                        delay = delay,
                        lockOnEnable = false,
                    )
                    persistCache(false, delay)
                    account.settings.putBooleanPreference(
                        SettingsRepository.PREF_APP_LOCK_ENABLED,
                        false,
                        System.currentTimeMillis(),
                    )
                }
            }
        },
        onDelay = { value ->
            if (container.appLock.isEnabled) container.appLock.setDelay(value)
            persistCache(enabled, value)
            val wire = AppLockCache.timeoutWire(value)
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
    val keepAlive by account.appContainer().keepAlive.collectAsState()
    val scope = rememberCoroutineScope()
    val onKeepAlive = rememberKeepAliveToggle(account)
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
        keepAlive = keepAlive,
        onKeepAlive = onKeepAlive,
        localMode = account.isLocalMode,
    )
}

@Composable
internal fun FileSyncDestination(
    account: AccountContainer,
    onBack: () -> Unit,
    onOpenConflicts: () -> Unit,
    onOpenDevices: () -> Unit,
    onOpenDiagnostics: () -> Unit,
    onUnbind: (() -> Unit)?,
    onBind: (() -> Unit)? = null,
    onSyncNow: () -> Unit,
) {
    val status by account.syncEngine.status.collectAsState(initial = one.zephyr.mobile.model.SyncStatus.unbound())
    val settings by account.syncSettingsState.collectAsState()
    val keepAlive by account.appContainer().keepAlive.collectAsState()
    val onKeepAlive = rememberKeepAliveToggle(account)
    FileSyncScreen(
        status = status,
        settings = settings,
        localMode = account.isLocalMode,
        onAutomatic = { enabled -> account.updateSyncSettings { it.copy(automaticEnabled = enabled) } },
        onInterval = { seconds -> account.updateSyncSettings { it.copy(intervalSec = seconds) } },
        onPolicy = { policy -> account.updateSyncSettings { it.copy(networkPolicy = policy) } },
        keepAlive = keepAlive,
        onKeepAlive = onKeepAlive,
        onSyncNow = onSyncNow,
        onOpenConflicts = onOpenConflicts,
        onOpenDevices = onOpenDevices,
        onOpenDiagnostics = onOpenDiagnostics,
        onUnbind = onUnbind,
        onBind = onBind,
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
    exec: one.zephyr.mobile.feature.tools.SshExecPort,
    onBack: () -> Unit,
    onMessage: (String) -> Unit,
) {
    val connections by account.connections.observeAll(ownerUserId).collectAsState(initial = emptyList())
    DockerMonitorScreen(
        connections = connections,
        section = section,
        onBack = onBack,
        shellFor = { connectionId ->
            object : one.zephyr.mobile.feature.tools.RemoteShell {
                override suspend fun run(command: String): one.zephyr.mobile.feature.tools.RemoteShellResult {
                    return when (val outcome = exec.exec(connectionId, command, timeoutSeconds = 300)) {
                        is one.zephyr.mobile.feature.tools.ExecOutcome.Completed ->
                            one.zephyr.mobile.feature.tools.RemoteShellResult(outcome.exitCode, outcome.stdout, outcome.stderr)
                        one.zephyr.mobile.feature.tools.ExecOutcome.TimedOut ->
                            error("远程命令超时")
                        is one.zephyr.mobile.feature.tools.ExecOutcome.Failed ->
                            error(outcome.error.message)
                    }
                }

                override fun stream(command: String) = exec.execStream(connectionId, command)
            }
        },
        onMessage = onMessage,
    )
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
internal fun BackupDestination(account: AccountContainer, onUnavailable: () -> Unit, onBack: () -> Unit) {
    BackupRestoreScreen(localMode = account.isLocalMode, onUnavailable = onUnavailable, onBack = onBack)
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
    one.zephyr.mobile.feature.tools.ClientTokenLiveRoute(
        viewModel = viewModel(
            key = "tokens",
            factory = one.zephyr.mobile.feature.tools.ClientTokenViewModel.factory(
                tokens = account.tokens,
                ownerUserId = ownerUserId,
                actions = account.clientTokenActions,
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
internal fun DiagnosticsLiveDestination(
    account: AccountContainer,
    onBack: () -> Unit,
    onCheckUpdate: () -> Unit,
    onOpenGitHub: () -> Unit,
    onOpenLicenses: () -> Unit,
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
        onCheckUpdate = onCheckUpdate,
        onOpenGitHub = onOpenGitHub,
        onOpenLicenses = onOpenLicenses,
        onExport = onExport,
        onBack = onBack,
    )
}

@Composable
internal fun AiSettingsLiveDestination(
    account: AccountContainer,
    @Suppress("UNUSED_PARAMETER") ownerUserId: String,
    onBack: () -> Unit,
) {
    val discoverer = remember(account) { AiModelDiscoverer(account) }
    one.zephyr.mobile.feature.tools.AiSettingsLiveRoute(
        localAi = account.localAi,
        bound = !account.isLocalMode,
        onBack = onBack,
        discoverModels = { provider, draftKey ->
            when (val outcome = discoverer.fetch(provider, draftKey)) {
                is AiModelDiscoverer.Result.Ok ->
                    one.zephyr.mobile.feature.tools.ModelDiscoveryResult(outcome.models.map { it.id to it.label }, null)
                is AiModelDiscoverer.Result.Failed ->
                    one.zephyr.mobile.feature.tools.ModelDiscoveryResult(emptyList(), outcome.reason)
            }
        },
    )
}

/**
 * Lists a provider's live models through the embedded runtime.
 *
 * Discovery must work with no main end attached, so the runtime — which already speaks every
 * vendor wire — owns the /models call. A blank in-form key falls back to the provider's stored
 * secret; the key is wiped here and never reaches the UI.
 */
internal class AiModelDiscoverer(account: AccountContainer) {
    sealed interface Result {
        data class Ok(val models: List<one.zephyr.mobile.app.EmbeddedDiscoveredModel>) : Result
        data class Failed(val reason: String) : Result
    }

    // Null platform host: discovery is a provider /models call that touches no tool, so the
    // runtime starts model-only rather than binding an SSH/SFTP host it will never use.
    private val api = EmbeddedAiRuntimeApi(account.appContainer().embeddedAiRuntime, null)
    private val localAi = account.localAi

    suspend fun fetch(provider: one.zephyr.mobile.data.repository.LocalAiProvider, draftKey: String): Result {
        val key = draftKey.ifBlank { null }?.toCharArray() ?: localAi.providerApiKey(provider.id)
        return try {
            val headers = runCatching {
                one.zephyr.mobile.network.MobileJson.instance.decodeFromString<Map<String, String>>(provider.extraHeadersJson)
            }.getOrDefault(emptyMap())
            val wire = EmbeddedProvider(
                id = provider.id, name = provider.name, kind = provider.type, baseUrl = provider.baseUrl,
                apiKey = key?.concatToString().orEmpty(), defaultModel = provider.defaultModel,
                models = provider.models.map { it.id }, apiMode = provider.apiMode,
                organization = provider.organization, extraHeaders = headers,
            )
            when (val result = api.providerModels(wire)) {
                is one.zephyr.mobile.network.ApiResult.Success -> Result.Ok(result.value)
                is one.zephyr.mobile.network.ApiResult.Failure -> Result.Failed(result.error.message)
            }
        } catch (failure: Exception) {
            Result.Failed(failure.message ?: "获取模型失败")
        } finally {
            key?.fill(' ')
        }
    }
}

internal fun diagnosticExport(account: AccountContainer): String =
    "one=${BuildConfig.VERSION_NAME} mode=${if (account.isLocalMode) "local" else "bound"} state=${account.binding.state.name} device=${account.binding.deviceId.take(8)}"

@Composable
private fun rememberKeepAliveToggle(account: AccountContainer): (Boolean) -> Unit {
    val context = LocalContext.current
    var awaitingPermission by remember { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (!awaitingPermission) return@rememberLauncherForActivityResult
        awaitingPermission = false
        if (!granted) return@rememberLauncherForActivityResult
        account.appContainer().setKeepAliveEnabled(true)
    }
    return { enabled ->
        if (enabled && Build.VERSION.SDK_INT >= 33) {
            val granted = ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                awaitingPermission = true
                permission.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                account.appContainer().setKeepAliveEnabled(true)
            }
        } else {
            account.appContainer().setKeepAliveEnabled(enabled)
        }
    }
}
