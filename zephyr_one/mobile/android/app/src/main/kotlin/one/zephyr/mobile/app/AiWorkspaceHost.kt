package one.zephyr.mobile.app

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.app.di.AccountContainer
import one.zephyr.mobile.data.EntityCodec
import one.zephyr.mobile.data.repository.SettingsRepository
import one.zephyr.mobile.data.session.SessionRow
import one.zephyr.mobile.feature.ai.AiContextHeader
import one.zephyr.mobile.feature.ai.AiContextResolver
import one.zephyr.mobile.feature.ai.AiConversationPolicy
import one.zephyr.mobile.feature.ai.AiPageLabels
import one.zephyr.mobile.feature.ai.AiPreferenceMapping
import one.zephyr.mobile.feature.ai.AiWorkspaceChrome
import one.zephyr.mobile.feature.ai.AiWorkspaceCopy
import one.zephyr.mobile.feature.ai.AiWorkspaceOverlay
import one.zephyr.mobile.ui.island.IslandDestination

@Composable
internal fun BoundAiWorkspace(
    account: AccountContainer,
    destination: IslandDestination,
    session: SessionRow?,
    onOpenSettings: () -> Unit,
    onNotice: (String) -> Unit,
) {
    val prefs by account.settings.observePreferences().collectAsState(initial = emptyMap())
    val chrome = AiWorkspaceBinding.chrome(prefs)
    val context = AiWorkspaceBinding.context(destination, session)
    val scope = rememberCoroutineScope()
    AiWorkspaceOverlay(
        enabled = chrome.enabled,
        chrome = chrome,
        context = context,
        conversation = AiConversationPolicy.local(),
        onChromeChange = { next ->
            scope.launch { AiWorkspaceBinding.persist(account.settings, next) }
        },
        onOpenSettings = onOpenSettings,
        onNotice = onNotice,
    )
}

internal object AiWorkspaceBinding {

    fun chrome(prefs: Map<String, JsonObject>): AiWorkspaceChrome = AiPreferenceMapping.chrome(
        enabled = flag(prefs, SettingsRepository.PREF_AI_ENABLED, true),
        provider = text(prefs, SettingsRepository.PREF_AI_PROVIDER),
        model = text(prefs, SettingsRepository.PREF_AI_MODEL),
        collaboration = text(prefs, SettingsRepository.PREF_AI_COLLAB),
        permission = text(prefs, SettingsRepository.PREF_AI_PERM),
        thinking = text(prefs, SettingsRepository.PREF_AI_THINK),
        memoryEnabled = flag(prefs, SettingsRepository.PREF_AI_MEMORY, true),
        memoryCount = 0,
        skillsEnabled = flag(prefs, SettingsRepository.PREF_AI_SKILLS, true),
        online = false,
    )

    fun context(destination: IslandDestination, session: SessionRow?): AiContextHeader {
        val live = session?.takeIf { it.transport.isLive }
        return AiContextResolver.header(
            protocol = live?.protocol?.wireName,
            sessionName = live?.name,
            pageLabel = AiPageLabels.island(destination.route),
        )
    }

    fun settingsSummary(prefs: Map<String, JsonObject>): String {
        val chrome = chrome(prefs)
        return AiWorkspaceCopy.settingsSub(chrome.enabled, chrome.model, chrome.collaboration)
    }

    suspend fun persist(settings: SettingsRepository, chrome: AiWorkspaceChrome) {
        val now = System.currentTimeMillis()
        settings.putStringPreference(SettingsRepository.PREF_AI_MODEL, chrome.model, now)
        settings.putStringPreference(SettingsRepository.PREF_AI_COLLAB, chrome.collaboration, now)
        settings.putStringPreference(SettingsRepository.PREF_AI_PERM, chrome.permission, now)
        settings.putStringPreference(SettingsRepository.PREF_AI_THINK, chrome.thinking, now)
    }

    private fun flag(prefs: Map<String, JsonObject>, key: String, fallback: Boolean): Boolean =
        prefs[key]?.let { EntityCodec.bool(it, "value", fallback) } ?: fallback

    private fun text(prefs: Map<String, JsonObject>, key: String): String? =
        prefs[key]?.let { EntityCodec.string(it, "value") }
}
