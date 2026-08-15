package one.zephyr.mobile.feature.ai

data class AiWorkspaceChrome(
    val enabled: Boolean = true,
    val providerId: String = "",
    val provider: String = "未选择 Provider",
    val model: String = "未选择模型",
    val collaboration: String = "standard",
    val runProfile: String = "balanced",
    val permission: String = "ask",
    val thinking: String = "medium",
    val planEnabled: Boolean = false,
    val memoryEnabled: Boolean = true,
    val memoryCount: Int = 0,
    val skillsEnabled: Boolean = true,
    val online: Boolean = false,
    val runtimeAvailable: Boolean = false,
) {
    val hasRuntime: Boolean get() = runtimeAvailable
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
    PROVIDER,
    MODEL,
    MODE,
    RUN_PROFILE,
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
        val status: String = "pending",
        val durationMs: Long? = null,
        val result: String? = null,
    ) : AiTranscriptItem()
}

data class AiConversation(
    val items: List<AiTranscriptItem> = emptyList(),
) {
    val isEmpty: Boolean get() = items.isEmpty()
}

object AiChipCycle {
    val MODELS: List<String> = emptyList()
    val COLLAB: List<String> = listOf("standard", "plan", "goal")
    val RUN_PROFILES: List<String> = listOf("economy", "balanced", "delivery")
    val PERM: List<String> = listOf("ask", "auto", "yolo")
    val THINK: List<String> = listOf("none", "minimal", "low", "medium", "high", "xhigh")

    fun next(value: String, options: List<String>): String {
        val index = options.indexOf(value)
        val start = if (index < 0) 0 else index + 1
        return options[start % options.size]
    }

    fun cycle(chrome: AiWorkspaceChrome, kind: AiChipKind): AiWorkspaceChrome = when (kind) {
        AiChipKind.MODE -> chrome.copy(collaboration = next(chrome.collaboration, COLLAB))
        AiChipKind.RUN_PROFILE -> chrome.copy(runProfile = next(chrome.runProfile, RUN_PROFILES))
        AiChipKind.PERM -> chrome.copy(permission = next(chrome.permission, PERM))
        AiChipKind.THINK -> chrome.copy(thinking = next(chrome.thinking, THINK))
        AiChipKind.PLAN -> chrome.copy(planEnabled = !chrome.planEnabled)
        AiChipKind.PROVIDER, AiChipKind.MODEL, AiChipKind.ATTACH, AiChipKind.MEMORY, AiChipKind.SETTINGS -> chrome
    }

    fun chips(chrome: AiWorkspaceChrome): List<AiChipSpec> = listOf(
        AiChipSpec(AiChipKind.PROVIDER, "Provider", chrome.provider),
        AiChipSpec(AiChipKind.MODEL, "模型", chrome.model),
        AiChipSpec(AiChipKind.MODE, "协作", chrome.collaboration),
        AiChipSpec(AiChipKind.RUN_PROFILE, "运行", chrome.runProfile),
        AiChipSpec(AiChipKind.PERM, "权限", chrome.permission),
        AiChipSpec(AiChipKind.THINK, "思考", chrome.thinking),
        AiChipSpec(AiChipKind.ATTACH, "附件"),
        AiChipSpec(AiChipKind.PLAN, "计划", if (chrome.planEnabled) "开启" else "关闭"),
        AiChipSpec(AiChipKind.MEMORY, "Memory/Skills"),
        AiChipSpec(AiChipKind.SETTINGS, "设置"),
    )
}

object AiWorkspaceCopy {
    const val SEND_OFFLINE: String = "主端 AI Runtime 不可用"
    const val ATTACH: String = "选择图片或文件（单文件最多 12MB）"
    const val PLAN: String = "计划模式会要求复杂任务先规划"
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
        AiChipKind.PROVIDER -> "Provider：" + chrome.provider
        AiChipKind.MODEL -> "模型：" + chrome.model
        AiChipKind.MODE -> "协作模式：" + chrome.collaboration
        AiChipKind.RUN_PROFILE -> "运行档位：" + chrome.runProfile
        AiChipKind.PERM -> "权限模式：" + chrome.permission
        AiChipKind.THINK -> "思考：" + chrome.thinking
        AiChipKind.ATTACH -> ATTACH
        AiChipKind.PLAN -> "计划：" + if (chrome.planEnabled) "开启" else "关闭"
        AiChipKind.MEMORY -> memoryChip(chrome)
        AiChipKind.SETTINGS -> null
    }

    fun sendNotice(online: Boolean): String = if (online) "" else SEND_OFFLINE

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
        runProfile: String? = null,
        permission: String? = null,
        thinking: String? = null,
        planEnabled: Boolean = false,
        memoryEnabled: Boolean = true,
        memoryCount: Int = 0,
        skillsEnabled: Boolean = true,
        online: Boolean = false,
    ): AiWorkspaceChrome = AiWorkspaceChrome(
        enabled = enabled,
        provider = provider?.takeIf { it.isNotBlank() } ?: "未选择 Provider",
        model = model?.takeIf { it.isNotBlank() } ?: "未选择模型",
        collaboration = collaboration?.takeIf { it.isNotBlank() } ?: "standard",
        runProfile = runProfile?.takeIf { it.isNotBlank() } ?: "balanced",
        permission = permission?.takeIf { it.isNotBlank() } ?: "ask",
        thinking = thinking?.takeIf { it.isNotBlank() } ?: "medium",
        planEnabled = planEnabled,
        memoryEnabled = memoryEnabled,
        memoryCount = memoryCount.coerceAtLeast(0),
        skillsEnabled = skillsEnabled,
        online = online,
    )
}
