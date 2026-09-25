package one.zephyr.mobile.app

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.app.di.AccountContainer
import one.zephyr.mobile.data.EntityCodec
import one.zephyr.mobile.data.repository.SettingsRepository
import one.zephyr.mobile.data.session.SessionRow
import one.zephyr.mobile.feature.ai.AiContextHeader
import one.zephyr.mobile.feature.ai.AiContextResolver
import one.zephyr.mobile.feature.ai.AiPageLabels
import one.zephyr.mobile.feature.ai.AiPreferenceMapping
import one.zephyr.mobile.feature.ai.AiWorkspaceChrome
import one.zephyr.mobile.feature.ai.AiWorkspaceCopy
import one.zephyr.mobile.feature.ai.AiWorkspaceOverlay
import one.zephyr.mobile.ui.island.IslandDestination

/**
 * The server stores the switch as a nested `ai.enabled`. Older rows and the
 * settings screen also write the flat key, so both shapes count. A payload with
 * neither is treated as off: the main end's own launcher stays hidden until AI
 * is explicitly enabled.
 */
internal fun serverAiEnabled(payload: JsonObject): Boolean {
    val nested = (payload["ai"] as? JsonObject)?.get("enabled")
    if (nested is JsonPrimitive) return nested.content.equals("true", ignoreCase = true)
    return if (payload.containsKey("ai.enabled") || payload.containsKey("ai")) {
        dottedBoolCompat(payload, "ai.enabled", fallback = false)
    } else {
        false
    }
}

internal fun dottedBoolCompat(payload: JsonObject, path: String, fallback: Boolean): Boolean {
    val direct = payload[path]
    if (direct is JsonPrimitive) return direct.content.equals("true", ignoreCase = true)
    var current: kotlinx.serialization.json.JsonElement = payload
    for (part in path.split('.')) {
        current = (current as? JsonObject)?.get(part) ?: return fallback
    }
    return (current as? JsonPrimitive)?.content?.equals("true", ignoreCase = true) ?: fallback
}

@Composable
internal fun BoundAiWorkspace(
    account: AccountContainer,
    destination: IslandDestination,
    session: SessionRow?,
    onOpenSettings: () -> Unit,
    onNotice: (String) -> Unit,
) {
    val prefs by account.settings.observePreferences().collectAsState(initial = emptyMap())
    val catalog by account.localAi.observe().collectAsState(
        initial = one.zephyr.mobile.data.repository.LocalAiCatalog(enabled = false),
    )
    val serverSettings by account.settings.observeSection("serverSettings", "default")
        .collectAsState(initial = JsonObject(emptyMap()))
    val serverAiEnabled = account.isLocalMode || serverAiEnabled(serverSettings)
    if (!account.isLocalMode && !serverAiEnabled) return
    val chrome = AiWorkspaceBinding.chrome(
        prefs = prefs,
        catalogEnabled = catalog.enabled,
        localMode = account.isLocalMode,
    )
    // Disabled means absent, not merely a closed sheet. Returning before controller construction
    // removes the FAB immediately and disposes any live local runtime/loopback host when toggled.
    if (!chrome.enabled) return
    val context = AiWorkspaceBinding.context(destination, session)
    val scope = rememberCoroutineScope()
    val currentRuntimeContext by rememberUpdatedState(
        AiWorkspaceBinding.runtimeContext(destination, session),
    )
    val currentChrome by rememberUpdatedState(chrome)
    val runtime = remember(account) {
        AiRuntimeControllerFactory.create(
            account = account,
            scope = scope,
            chrome = { currentChrome },
            context = { currentRuntimeContext },
            persistChrome = { AiWorkspaceBinding.persist(account.settings, it) },
            localPlatformHost = {
                val managed = ManagedSshSessionPool(
                    engine = account.appContainer().sshEngine,
                    connectionProvider = account.connections::find,
                    credentialsProvider = account::terminalCredentials,
                    routePlanner = accountRoutePlanner(account),
                )
                val exec = LiveSshExecPort(account.appContainer().sshEngine, account.sessions, managed)
                val sftp = SshjSftpPort(managed, account.appContainer().sshEngine, account.sessions)
                AndroidAiPlatformHost(account, exec, account.localAiWorkspace, sftp)
            },
        )
    }
    DisposableEffect(runtime) {
        onDispose { (runtime as? LocalAndroidAiRuntimeController)?.close() }
    }
    AiWorkspaceOverlay(
        enabled = chrome.enabled,
        chrome = chrome,
        context = context,
        controller = runtime,
        onOpenSettings = onOpenSettings,
        onNotice = onNotice,
    )
}

internal object AiWorkspaceBinding {

    fun chrome(
        prefs: Map<String, JsonObject>,
        catalogEnabled: Boolean = true,
        localMode: Boolean = true,
    ): AiWorkspaceChrome = AiPreferenceMapping.chrome(
        // Local mode obeys the device catalog switch. A bound account uses the server runtime and
        // must not disappear merely because the unrelated local catalog is disabled.
        enabled = (!localMode || catalogEnabled) && flag(prefs, SettingsRepository.PREF_AI_ENABLED, true),
        provider = text(prefs, SettingsRepository.PREF_AI_PROVIDER),
        model = text(prefs, SettingsRepository.PREF_AI_MODEL),
        collaboration = text(prefs, SettingsRepository.PREF_AI_COLLAB),
        runProfile = text(prefs, SettingsRepository.PREF_AI_RUN_PROFILE),
        permission = text(prefs, SettingsRepository.PREF_AI_PERM),
        thinking = text(prefs, SettingsRepository.PREF_AI_THINK),
        planEnabled = flag(prefs, SettingsRepository.PREF_AI_PLANNER, false),
        memoryEnabled = flag(prefs, SettingsRepository.PREF_AI_MEMORY, true),
        memoryCount = 0,
        skillsEnabled = flag(prefs, SettingsRepository.PREF_AI_SKILLS, true),
        online = false,
    ).copy(providerId = text(prefs, SettingsRepository.PREF_AI_PROVIDER_ID).orEmpty())

    fun context(destination: IslandDestination, session: SessionRow?): AiContextHeader {
        val live = session?.takeIf { it.transport.isLive }
        return AiContextResolver.header(
            protocol = live?.protocol?.wireName,
            sessionName = live?.name,
            pageLabel = AiPageLabels.island(destination.route),
        )
    }

    /** Context is metadata only. Secret material and terminal/remote pixels are never guessed. */
    fun runtimeContext(destination: IslandDestination, session: SessionRow?): JsonObject {
        val live = session?.takeIf { it.transport.isLive }
        val values = linkedMapOf<String, kotlinx.serialization.json.JsonElement>(
            "source" to JsonPrimitive("zephyr-one-android"),
            "page" to JsonPrimitive(AiPageLabels.island(destination.route)),
            "locale" to JsonPrimitive("zh-CN"),
        )
        if (live != null) {
            values["activeSessionId"] = JsonPrimitive(live.sessionId)
            values["activeConnectionId"] = JsonPrimitive(live.connectionId)
            values["activeProtocol"] = JsonPrimitive(live.protocol.wireName)
            values["activeSessionName"] = JsonPrimitive(live.name)
            values["activeSurface"] = JsonObject(
                mapOf(
                    "kind" to JsonPrimitive(if (live.protocol.isRemoteDesktop) "remote-desktop" else "terminal"),
                    "protocol" to JsonPrimitive(live.protocol.wireName),
                    "tabId" to JsonPrimitive(live.sessionId),
                    "sessionId" to JsonPrimitive(live.sessionId),
                    "connectionId" to JsonPrimitive(live.connectionId),
                ),
            )
        }
        return JsonObject(values)
    }

    fun settingsSummary(
        prefs: Map<String, JsonObject>,
        catalogEnabled: Boolean = true,
    ): String {
        val chrome = chrome(prefs, catalogEnabled)
        return AiWorkspaceCopy.settingsSub(chrome.enabled, chrome.model, chrome.collaboration)
    }

    suspend fun persist(settings: SettingsRepository, chrome: AiWorkspaceChrome) {
        val now = System.currentTimeMillis()
        settings.putStringPreference(SettingsRepository.PREF_AI_PROVIDER_ID, chrome.providerId, now)
        settings.putStringPreference(SettingsRepository.PREF_AI_PROVIDER, chrome.provider, now)
        settings.putStringPreference(SettingsRepository.PREF_AI_MODEL, chrome.model, now)
        settings.putStringPreference(SettingsRepository.PREF_AI_COLLAB, chrome.collaboration, now)
        settings.putStringPreference(SettingsRepository.PREF_AI_RUN_PROFILE, chrome.runProfile, now)
        settings.putStringPreference(SettingsRepository.PREF_AI_PERM, chrome.permission, now)
        settings.putStringPreference(SettingsRepository.PREF_AI_THINK, chrome.thinking, now)
        settings.putBooleanPreference(SettingsRepository.PREF_AI_PLANNER, chrome.planEnabled, now)
    }

    private fun flag(prefs: Map<String, JsonObject>, key: String, fallback: Boolean): Boolean =
        prefs[key]?.let { EntityCodec.bool(it, "value", fallback) } ?: fallback

    private fun text(prefs: Map<String, JsonObject>, key: String): String? =
        prefs[key]?.let { EntityCodec.string(it, "value") }
}
