package one.zephyr.mobile.feature.ai

data class AiWorkspaceChrome(
    val enabled: Boolean = true,
    val provider: String = "Claude",
    val model: String = "Claude Opus",
    val collaboration: String = "协作",
    val permission: String = "按能力确认",
    val thinking: String = "medium",
    val memoryEnabled: Boolean = true,
    val memoryCount: Int = 0,
    val skillsEnabled: Boolean = true,
    val online: Boolean = false,
) {
    /** A provider name is not a runtime. Conversation stays empty until a real transcript exists. */
    val hasRuntime: Boolean = false
}

data class AiContextHeader(
    val label: String,
    val pageStillVisible: Boolean = true,
) {
    val trailing: String = if (pageStillVisible) "底层页面持续可见" else ""
}

data class AiRunBanner(
    val label: String = "正在执行 · terminal.execute",
)

enum class AiChipKind {
    MODEL,
    MODE,
    PERM,
    THINK,
    ATTACH,
    PLAN,
    MEMORY,
    SETTINGS,
}

data class AiChipSpec(
    val kind: AiChipKind,
    val label: String,
    val value: String? = null,
)

sealed class AiTranscriptItem {
    data class User(val text: String) : AiTranscriptItem()
    data class Assistant(val text: String, val caption: String? = null) : AiTranscriptItem()
    data class ToolTrace(
        val title: String,
        val command: String,
        val risk: String = "低",
        val approved: Boolean = false,
        val denied: Boolean = false,
    ) : AiTranscriptItem()
}

data class AiConversation(
    val items: List<AiTranscriptItem> = emptyList(),
) {
    val isEmpty: Boolean get() = items.isEmpty()
}

object AiChipCycle {
    val MODELS: List<String> = listOf("Claude Opus", "Claude Sonnet", "GPT-5", "Gemini 3 Pro")
    val COLLAB: List<String> = listOf("协作", "自动", "只读")
    val PERM: List<String> = listOf("按能力确认", "自动确认", "全部询问")
    val THINK: List<String> = listOf("关闭", "low", "medium", "high")

    fun next(value: String, options: List<String>): String {
        val index = options.indexOf(value)
        val start = if (index < 0) 0 else index + 1
        return options[start % options.size]
    }

    fun cycle(chrome: AiWorkspaceChrome, kind: AiChipKind): AiWorkspaceChrome = when (kind) {
        AiChipKind.MODEL -> chrome.copy(model = next(chrome.model, MODELS))
        AiChipKind.MODE -> chrome.copy(collaboration = next(chrome.collaboration, COLLAB))
        AiChipKind.PERM -> chrome.copy(permission = next(chrome.permission, PERM))
        AiChipKind.THINK -> chrome.copy(thinking = next(chrome.thinking, THINK))
        AiChipKind.ATTACH, AiChipKind.PLAN, AiChipKind.MEMORY, AiChipKind.SETTINGS -> chrome
    }

    fun chips(chrome: AiWorkspaceChrome): List<AiChipSpec> = listOf(
        AiChipSpec(AiChipKind.MODEL, "模型", chrome.model),
        AiChipSpec(AiChipKind.MODE, "协作", chrome.collaboration),
        AiChipSpec(AiChipKind.PERM, "权限", chrome.permission),
        AiChipSpec(AiChipKind.THINK, "思考", chrome.thinking),
        AiChipSpec(AiChipKind.ATTACH, "附件"),
        AiChipSpec(AiChipKind.PLAN, "计划"),
        AiChipSpec(AiChipKind.MEMORY, "Memory/Skills"),
        AiChipSpec(AiChipKind.SETTINGS, "设置"),
    )
}

object AiWorkspaceCopy {
    const val SEND_OFFLINE: String = "需要联网才能发送"
    const val ATTACH: String = "附件 · 图片/文件，RDP/VNC 走图片输入"
    const val PLAN: String = "计划 · 复杂任务先规划"
    const val STOP: String = "已停止 run · 收起面板不取消，这里显式停止"
    const val TAKEOVER: String = "已接管 · AI 暂停操作，终端交还手动控制"
    const val ENABLED: String = "AI 助理已启用"
    const val DISABLED: String = "AI 助理已停用 · AI 笔记工具一并禁用"
    const val DISABLED_SUB: String = "已停用 · 导航与工作区不再显示 AI"
    const val EMPTY_TITLE: String = "还没有对话"
    const val EMPTY_BODY: String = "配置 Provider 并联网后，这里会显示当前会话的提问、工具确认和执行结果。"
    const val ASK_PREFIX: String = "向 Zephyr AI 提问"
    const val DEFAULT_PAGE: String = "当前页"
    const val TOOL_PENDING: String = "待确认"
    const val TOOL_DENIED: String = "已拒绝 · 未执行"
    const val TOOL_DONE: String = "已执行 · 退出码 0 · 1.2s"

    fun askPlaceholder(model: String): String = "$ASK_PREFIX · $model"

    fun settingsSub(enabled: Boolean, model: String, collaboration: String): String {
        if (!enabled) return DISABLED_SUB
        val mode = if (collaboration.endsWith("模式")) collaboration else collaboration + "模式"
        return "已启用 · $model · $mode"
    }

    fun memoryChip(chrome: AiWorkspaceChrome): String {
        val skills = if (chrome.skillsEnabled) "启用" else "未启用"
        return "Memory ${chrome.memoryCount} 条 · Skills $skills · Env 仅变量名"
    }

    fun chipToast(kind: AiChipKind, chrome: AiWorkspaceChrome): String? = when (kind) {
        AiChipKind.MODEL -> "模型：" + chrome.model
        AiChipKind.MODE -> "协作模式：" + chrome.collaboration
        AiChipKind.PERM -> "权限模式：" + chrome.permission
        AiChipKind.THINK -> "思考：" + chrome.thinking
        AiChipKind.ATTACH -> ATTACH
        AiChipKind.PLAN -> PLAN
        AiChipKind.MEMORY -> memoryChip(chrome)
        AiChipKind.SETTINGS -> null
    }

    fun sendNotice(online: Boolean): String {
        /* Demo send is a dead field: it always toasts this, even when a model name is shown. */
        return if (online) SEND_OFFLINE else SEND_OFFLINE
    }

    fun contextLine(header: AiContextHeader): String {
        val tail = header.trailing
        return if (tail.isEmpty()) "上下文 ${header.label}" else "上下文 ${header.label} · $tail"
    }
}

object AiContextResolver {
    fun header(protocol: String?, sessionName: String?, pageLabel: String): AiContextHeader {
        val live = !protocol.isNullOrBlank() && !sessionName.isNullOrBlank()
        val label = if (live) "$protocol · $sessionName" else pageLabel.ifBlank { AiWorkspaceCopy.DEFAULT_PAGE }
        return AiContextHeader(label = label)
    }
}

object AiConversationPolicy {
    /** Never invent the demo disk-usage thread. An unconfigured device is an empty transcript. */
    fun local(existing: List<AiTranscriptItem> = emptyList()): AiConversation =
        AiConversation(items = existing)

    fun decide(items: List<AiTranscriptItem>, index: Int, allow: Boolean): List<AiTranscriptItem> {
        if (index !in items.indices) return items
        val current = items[index] as? AiTranscriptItem.ToolTrace ?: return items
        val next = current.copy(approved = allow, denied = !allow)
        return items.toMutableList().also { it[index] = next }
    }
}

object AiPageLabels {
    fun island(route: String?): String = when (route) {
        "home" -> "首页"
        "sessions" -> "会话"
        "library" -> "资料"
        "tools" -> "工具"
        else -> AiWorkspaceCopy.DEFAULT_PAGE
    }
}

object AiPreferenceMapping {
    fun chrome(
        enabled: Boolean = true,
        provider: String? = null,
        model: String? = null,
        collaboration: String? = null,
        permission: String? = null,
        thinking: String? = null,
        memoryEnabled: Boolean = true,
        memoryCount: Int = 0,
        skillsEnabled: Boolean = true,
        online: Boolean = false,
    ): AiWorkspaceChrome = AiWorkspaceChrome(
        enabled = enabled,
        provider = provider?.takeIf { it.isNotBlank() } ?: "Claude",
        model = model?.takeIf { it.isNotBlank() } ?: "Claude Opus",
        collaboration = collaboration?.takeIf { it.isNotBlank() } ?: "协作",
        permission = permission?.takeIf { it.isNotBlank() } ?: "按能力确认",
        thinking = thinking?.takeIf { it.isNotBlank() } ?: "medium",
        memoryEnabled = memoryEnabled,
        memoryCount = memoryCount.coerceAtLeast(0),
        skillsEnabled = skillsEnabled,
        online = online,
    )
}
