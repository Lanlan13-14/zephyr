package one.zephyr.mobile.app

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.data.repository.SettingsRepository
import one.zephyr.mobile.data.session.SessionExecution
import one.zephyr.mobile.data.session.SessionRow
import one.zephyr.mobile.data.session.SessionTransport
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.ui.island.IslandDestination
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AiWorkspaceBindingTest {

    @Test
    fun `missing prefs keep honest defaults without inventing a provider`() {
        val chrome = AiWorkspaceBinding.chrome(emptyMap())
        assertTrue(chrome.enabled)
        assertEquals("未选择模型", chrome.model)
        assertEquals("standard", chrome.collaboration)
        assertEquals(0, chrome.memoryCount)
        assertFalse(chrome.hasRuntime)
        assertFalse(chrome.online)
        assertEquals("已启用 · 未选择模型 · standard模式", AiWorkspaceBinding.settingsSummary(emptyMap()))
    }

    @Test
    fun `stored prefs drive chrome and the tools subtitle`() {
        val prefs = mapOf(
            SettingsRepository.PREF_AI_ENABLED to jsonBool(false),
            SettingsRepository.PREF_AI_MODEL to jsonText("Claude Sonnet"),
            SettingsRepository.PREF_AI_COLLAB to jsonText("只读"),
            SettingsRepository.PREF_AI_PERM to jsonText("全部询问"),
            SettingsRepository.PREF_AI_THINK to jsonText("high"),
            SettingsRepository.PREF_AI_SKILLS to jsonBool(false),
        )
        val chrome = AiWorkspaceBinding.chrome(prefs)
        assertFalse(chrome.enabled)
        assertFalse(AiWorkspaceBinding.chrome(emptyMap(), catalogEnabled = false).enabled)
        assertEquals(
            "已停用 · 导航与工作区不再显示 AI",
            AiWorkspaceBinding.settingsSummary(emptyMap(), catalogEnabled = false),
        )
        assertEquals("Claude Sonnet", chrome.model)
        assertEquals("只读", chrome.collaboration)
        assertEquals("全部询问", chrome.permission)
        assertEquals("high", chrome.thinking)
        assertFalse(chrome.skillsEnabled)
        assertEquals("已停用 · 导航与工作区不再显示 AI", AiWorkspaceBinding.settingsSummary(prefs))
    }

    @Test
    fun `context uses a live session and never falls back to the demo host`() {
        val live = row(SessionTransport.CONNECTED, "edge-01", Protocol.SSH)
        val dead = row(SessionTransport.CLOSED, "prod-web-01", Protocol.SSH)
        val connecting = row(SessionTransport.CONNECTING, "jump-02", Protocol.TELNET)

        val fromLive = AiWorkspaceBinding.context(IslandDestination.HOME, live)
        assertEquals("SSH · edge-01", fromLive.label)

        val fromDead = AiWorkspaceBinding.context(IslandDestination.TOOLS, dead)
        assertEquals("工具", fromDead.label)
        assertFalse(fromDead.label.contains("prod-web-01"))

        val fromConnecting = AiWorkspaceBinding.context(IslandDestination.SESSIONS, connecting)
        assertEquals("TELNET · jump-02", fromConnecting.label)

        val fromPage = AiWorkspaceBinding.context(IslandDestination.LIBRARY, null)
        assertEquals("资料", fromPage.label)
    }

    private fun jsonBool(value: Boolean): JsonObject = JsonObject(mapOf("value" to JsonPrimitive(value)))

    private fun jsonText(value: String): JsonObject = JsonObject(mapOf("value" to JsonPrimitive(value)))

    private fun row(transport: SessionTransport, name: String, protocol: Protocol): SessionRow = SessionRow(
        sessionId = "s-" + name,
        connectionId = "c-" + name,
        protocol = protocol,
        name = name,
        host = "127.0.0.1",
        port = protocol.defaultPort,
        transport = transport,
        execution = SessionExecution.LOCAL,
        capabilities = CapabilitySet.owner,
    )
}
