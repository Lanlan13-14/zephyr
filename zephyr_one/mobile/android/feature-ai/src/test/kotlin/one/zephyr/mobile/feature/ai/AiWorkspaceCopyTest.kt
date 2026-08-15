package one.zephyr.mobile.feature.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AiWorkspaceCopyTest {

    @Test
    fun `unconfigured workspace has no invented transcript`() {
        val conversation = AiConversationPolicy.local()
        assertTrue(conversation.isEmpty)
        assertFalse(AiWorkspaceChrome().hasRuntime)
        assertEquals("还没有对话", AiWorkspaceCopy.EMPTY_TITLE)
        assertTrue(AiWorkspaceCopy.EMPTY_BODY.contains("配置 Provider"))
        assertFalse(AiWorkspaceCopy.EMPTY_BODY.contains("prod-web-01"))
        assertFalse(AiWorkspaceCopy.EMPTY_BODY.contains("82%"))
    }

    @Test
    fun `chip cycle matches demo option lists and wraps`() {
        val start = AiWorkspaceChrome()
        val model = AiChipCycle.cycle(start, AiChipKind.MODEL)
        assertEquals("Claude Sonnet", model.model)
        var walking = start
        repeat(AiChipCycle.MODELS.size) { walking = AiChipCycle.cycle(walking, AiChipKind.MODEL) }
        assertEquals("Claude Opus", walking.model)
        assertEquals("自动", AiChipCycle.cycle(start, AiChipKind.MODE).collaboration)
        assertEquals("自动确认", AiChipCycle.cycle(start, AiChipKind.PERM).permission)
        assertEquals("high", AiChipCycle.cycle(start, AiChipKind.THINK).thinking)
        assertEquals(start, AiChipCycle.cycle(start, AiChipKind.ATTACH))
    }

    @Test
    fun `chip toasts match demo strings`() {
        val chrome = AiWorkspaceChrome(memoryCount = 12, skillsEnabled = true)
        assertEquals("模型：Claude Opus", AiWorkspaceCopy.chipToast(AiChipKind.MODEL, chrome))
        assertEquals("协作模式：协作", AiWorkspaceCopy.chipToast(AiChipKind.MODE, chrome))
        assertEquals("权限模式：按能力确认", AiWorkspaceCopy.chipToast(AiChipKind.PERM, chrome))
        assertEquals("思考：medium", AiWorkspaceCopy.chipToast(AiChipKind.THINK, chrome))
        assertEquals(AiWorkspaceCopy.ATTACH, AiWorkspaceCopy.chipToast(AiChipKind.ATTACH, chrome))
        assertEquals(AiWorkspaceCopy.PLAN, AiWorkspaceCopy.chipToast(AiChipKind.PLAN, chrome))
        assertEquals("Memory 12 条 · Skills 启用 · Env 仅变量名", AiWorkspaceCopy.chipToast(AiChipKind.MEMORY, chrome))
        assertNull(AiWorkspaceCopy.chipToast(AiChipKind.SETTINGS, chrome))
        assertEquals(8, AiChipCycle.chips(chrome).size)
    }

    @Test
    fun `settings subtitle and send stay honest`() {
        assertEquals(
            "已启用 · Claude Opus · 协作模式",
            AiWorkspaceCopy.settingsSub(true, "Claude Opus", "协作"),
        )
        assertEquals(AiWorkspaceCopy.DISABLED_SUB, AiWorkspaceCopy.settingsSub(false, "Claude Opus", "协作"))
        assertEquals("向 Zephyr AI 提问 · Claude Opus", AiWorkspaceCopy.askPlaceholder("Claude Opus"))
        assertEquals(AiWorkspaceCopy.SEND_OFFLINE, AiWorkspaceCopy.sendNotice(false))
        assertEquals(AiWorkspaceCopy.SEND_OFFLINE, AiWorkspaceCopy.sendNotice(true))
    }

    @Test
    fun `context prefers a live session and never fabricates prod-web-01`() {
        val live = AiContextResolver.header("SSH", "edge-01", "首页")
        assertEquals("SSH · edge-01", live.label)
        assertEquals("上下文 SSH · edge-01 · 底层页面持续可见", AiWorkspaceCopy.contextLine(live))

        val page = AiContextResolver.header(null, null, "工具")
        assertEquals("工具", page.label)
        assertFalse(page.label.contains("prod-web-01"))
        assertEquals("首页", AiPageLabels.island("home"))
        assertEquals("会话", AiPageLabels.island("sessions"))
        assertEquals("资料", AiPageLabels.island("library"))
        assertEquals("工具", AiPageLabels.island("tools"))
        assertEquals("当前页", AiPageLabels.island("unknown"))
    }

    @Test
    fun `allowing a tool does not invent an assistant result`() {
        val items = listOf(
            AiTranscriptItem.User("ls"),
            AiTranscriptItem.ToolTrace("待确认 · terminal.execute · 风险：低", "ls"),
        )
        val allowed = AiConversationPolicy.decide(items, 1, allow = true)
        val denied = AiConversationPolicy.decide(items, 1, allow = false)
        val trace = allowed[1] as AiTranscriptItem.ToolTrace
        assertTrue(trace.approved)
        assertFalse(trace.denied)
        assertEquals(2, allowed.size)
        assertTrue((denied[1] as AiTranscriptItem.ToolTrace).denied)
        assertEquals(items, AiConversationPolicy.decide(items, 9, allow = true))
    }
}
