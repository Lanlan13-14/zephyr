package one.zephyr.mobile.feature.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AiWorkspaceCopyTest {

    @Test
    fun `unconfigured workspace has no invented provider or transcript`() {
        val conversation = AiConversationPolicy.local()
        val chrome = AiWorkspaceChrome()
        assertTrue(conversation.isEmpty)
        assertFalse(chrome.hasRuntime)
        assertEquals("未选择 Provider", chrome.provider)
        assertEquals("未选择模型", chrome.model)
        assertEquals("还没有对话", AiWorkspaceCopy.EMPTY_TITLE)
        assertFalse(AiWorkspaceCopy.EMPTY_BODY.contains("prod-web-01"))
        assertFalse(AiWorkspaceCopy.EMPTY_BODY.contains("82%"))
    }

    @Test
    fun `chip cycle matches Docker options and wraps`() {
        val start = AiWorkspaceChrome()
        assertEquals("plan", AiChipCycle.cycle(start, AiChipKind.MODE).collaboration)
        assertEquals("delivery", AiChipCycle.cycle(start, AiChipKind.RUN_PROFILE).runProfile)
        assertEquals("auto", AiChipCycle.cycle(start, AiChipKind.PERM).permission)
        assertEquals("high", AiChipCycle.cycle(start, AiChipKind.THINK).thinking)
        assertTrue(AiChipCycle.cycle(start, AiChipKind.PLAN).planEnabled)
        assertEquals(start, AiChipCycle.cycle(start, AiChipKind.ATTACH))
        assertEquals(start, AiChipCycle.cycle(start, AiChipKind.MODEL))
    }

    @Test
    fun `chip copy includes real run controls`() {
        val chrome = AiWorkspaceChrome(memoryCount = 12, skillsEnabled = true)
        assertEquals("Provider：未选择 Provider", AiWorkspaceCopy.chipToast(AiChipKind.PROVIDER, chrome))
        assertEquals("模型：未选择模型", AiWorkspaceCopy.chipToast(AiChipKind.MODEL, chrome))
        assertEquals("协作模式：standard", AiWorkspaceCopy.chipToast(AiChipKind.MODE, chrome))
        assertEquals("运行档位：balanced", AiWorkspaceCopy.chipToast(AiChipKind.RUN_PROFILE, chrome))
        assertEquals("权限模式：ask", AiWorkspaceCopy.chipToast(AiChipKind.PERM, chrome))
        assertEquals("思考：medium", AiWorkspaceCopy.chipToast(AiChipKind.THINK, chrome))
        assertEquals(AiWorkspaceCopy.ATTACH, AiWorkspaceCopy.chipToast(AiChipKind.ATTACH, chrome))
        assertEquals("计划：关闭", AiWorkspaceCopy.chipToast(AiChipKind.PLAN, chrome))
        assertEquals("Memory 12 条 · Skills 启用 · Env 仅变量名", AiWorkspaceCopy.chipToast(AiChipKind.MEMORY, chrome))
        assertNull(AiWorkspaceCopy.chipToast(AiChipKind.SETTINGS, chrome))
        assertEquals(10, AiChipCycle.chips(chrome).size)
    }

    @Test
    fun `settings subtitle and runtime status stay honest`() {
        assertEquals(
            "已启用 · gpt-5 · standard模式",
            AiWorkspaceCopy.settingsSub(true, "gpt-5", "standard"),
        )
        assertEquals(AiWorkspaceCopy.DISABLED_SUB, AiWorkspaceCopy.settingsSub(false, "gpt-5", "standard"))
        assertEquals("向 Zephyr AI 提问 · gpt-5", AiWorkspaceCopy.askPlaceholder("gpt-5"))
        assertEquals(AiWorkspaceCopy.SEND_OFFLINE, AiWorkspaceCopy.sendNotice(false))
        assertEquals("", AiWorkspaceCopy.sendNotice(true))
    }

    @Test
    fun `context prefers a live session and never fabricates prod host`() {
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
    fun `permission decision changes only the matching trace`() {
        val items = listOf(
            AiTranscriptItem.User("ls"),
            AiTranscriptItem.ToolTrace("待确认 · terminal.execute · 风险：低", "ls"),
        )
        val allowed = AiConversationPolicy.decide(items, 1, allow = true)
        val denied = AiConversationPolicy.decide(items, 1, allow = false)
        assertTrue((allowed[1] as AiTranscriptItem.ToolTrace).approved)
        assertTrue((denied[1] as AiTranscriptItem.ToolTrace).denied)
        assertEquals(items, AiConversationPolicy.decide(items, 9, allow = true))
    }
}
