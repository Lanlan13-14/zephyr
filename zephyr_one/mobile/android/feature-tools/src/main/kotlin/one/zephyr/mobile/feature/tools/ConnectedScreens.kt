package one.zephyr.mobile.feature.tools

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import one.zephyr.mobile.ui.component.ActionSheet
import one.zephyr.mobile.ui.component.ActionSheetGroup
import one.zephyr.mobile.ui.component.ActionSheetItem
import one.zephyr.mobile.ui.component.AlertDialog
import one.zephyr.mobile.ui.component.FilterChip
import one.zephyr.mobile.ui.component.OutlinedTextField
import one.zephyr.mobile.ui.component.Switch
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.component.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import one.zephyr.mobile.contracts.ConflictResolution
import one.zephyr.mobile.data.EntityCodec
import one.zephyr.mobile.data.repository.ClientTokenRepository
import one.zephyr.mobile.data.repository.ConflictRepository
import one.zephyr.mobile.data.repository.SettingsRepository
import one.zephyr.mobile.feature.filesync.SafShareGrant
import one.zephyr.mobile.model.ClientToken
import one.zephyr.mobile.model.ConflictRecord
import one.zephyr.mobile.model.SensitiveGrant
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.network.MobileApi
import one.zephyr.mobile.network.dto.DeviceDto
import one.zephyr.mobile.ui.chrome.PushedPageHeader
import one.zephyr.mobile.ui.format.RelativeTime
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme

const val ACTION_TOKEN_REVEAL = "token.reveal"
const val ACTION_TOKEN_DELETE = "token.delete"
const val ACTION_TOKEN_RESET_ALL = "token.resetAll"
const val ACTION_DEVICE_REVOKE = "device.revoke"

class SensitiveGrantBroker(
    private val api: MobileApi,
    private val localMode: Boolean,
) {
    suspend fun verify(action: String, secret: String, targetIds: List<String>): Result<SensitiveGrant> {
        if (localMode) return Result.failure(IllegalStateException("本地模式没有主端，无法做敏感验证"))
        return when (val result = api.verifySensitive(action, secret, targetIds)) {
            is ApiResult.Success -> Result.success(result.value)
            is ApiResult.Failure -> Result.failure(IllegalStateException(result.error.message))
        }
    }
}

class ClientTokenViewModel(
    private val tokens: ClientTokenRepository,
    private val ownerUserId: String,
    private val broker: SensitiveGrantBroker,
    private val localMode: Boolean,
) : ViewModel() {
    val rows = tokens.observeAll(ownerUserId)
    private val messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val message: SharedFlow<String> = messages
    private val revealedState = kotlinx.coroutines.flow.MutableStateFlow<Pair<String, String>?>(null)
    val revealed: kotlinx.coroutines.flow.StateFlow<Pair<String, String>?> = revealedState

    fun rename(id: String, name: String) {
        viewModelScope.launch {
            runCatching { tokens.rename(id, name, ownerUserId) }
                .onSuccess { messages.emit("已改名，待同步") }
                .onFailure { messages.emit(it.message ?: "改名失败") }
        }
    }

    fun reveal(id: String, secret: String) {
        viewModelScope.launch {
            val grant = broker.verify(ACTION_TOKEN_REVEAL, secret, listOf(id)).getOrElse {
                messages.emit(it.message ?: "敏感验证失败")
                return@launch
            }
            val value = runCatching { tokens.reveal(id, grant.grantId) }.getOrNull()
            if (value.isNullOrEmpty()) messages.emit("本机没有这份 Token 的密文。绑定后的首次同步才会把它封进设备信封。")
            else revealedState.value = id to value
        }
    }

    fun delete(id: String, secret: String) {
        viewModelScope.launch {
            val grant = broker.verify(ACTION_TOKEN_DELETE, secret, listOf(id)).getOrElse {
                messages.emit(it.message ?: "敏感验证失败")
                return@launch
            }
            runCatching { tokens.delete(id, ownerUserId, grant.grantId) }
                .onSuccess { messages.emit("已删除，待同步。使用该 Token 的设备会在下次刷新时断开。") }
                .onFailure { messages.emit(it.message ?: "删除失败") }
        }
    }

    fun dismissReveal() {
        revealedState.value = null
    }

    companion object {
        fun factory(
            tokens: ClientTokenRepository,
            ownerUserId: String,
            broker: SensitiveGrantBroker,
            localMode: Boolean,
        ): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                ClientTokenViewModel(tokens, ownerUserId, broker, localMode) as T
        }
    }
}

@Composable
fun ClientTokenLiveRoute(
    viewModel: ClientTokenViewModel,
    localMode: Boolean,
    onBack: () -> Unit,
    onMessage: suspend (String) -> Unit,
) {
    val rows by viewModel.rows.collectAsState(initial = emptyList())
    LaunchedEffect(viewModel) { viewModel.message.collect { onMessage(it) } }
    var pending by remember { mutableStateOf<TokenPending?>(null) }

    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "Client Token", onBack = onBack)
        if (localMode) {
            Text(
                "本地模式没有主端 Token。绑定服务器并完成首次同步后，这里会列出当前账号的 Token 元数据。查看/删除需要密码或 TOTP。",
                modifier = Modifier.padding(ZephyrSpacing.lg),
                color = ZephyrTheme.palette.onFloatingMuted,
            )
            return
        }
        LazyColumn(Modifier.padding(horizontal = ZephyrSpacing.lg)) {
            items(rows.filter { it.deletedAt == null }, key = { it.id }) { token ->
                Column(Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
                    Text(token.name.ifBlank { token.id }, fontWeight = FontWeight.SemiBold)
                    Text(
                        "id ${token.id} · 关联 One ${token.linkedOneDeviceCount} · Agent ${token.linkedLegacyAgentCount}",
                        color = ZephyrTheme.palette.onFloatingMuted,
                        fontSize = 12.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                    Row {
                        TextButton(onClick = { pending = TokenPending.Reveal(token) }) { Text("查看") }
                        TextButton(onClick = { pending = TokenPending.Rename(token) }) { Text("改名") }
                        TextButton(onClick = { pending = TokenPending.Delete(token) }) { Text("删除") }
                    }
                }
            }
            item {
                Text(
                    "查看 / 复制 / 删除均需当前密码或 TOTP。旋转和重置全部会断开已绑定设备，必须走主端敏感验证。",
                    color = ZephyrTheme.palette.onFloatingMuted,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(vertical = 16.dp),
                )
            }
        }
    }

    pending?.let { action ->
        SensitivePrompt(
            title = action.title,
            body = action.body,
            onDismiss = { pending = null },
            onConfirm = { secret ->
                when (action) {
                    is TokenPending.Reveal -> viewModel.reveal(action.token.id, secret)
                    is TokenPending.Delete -> viewModel.delete(action.token.id, secret)
                    is TokenPending.Rename -> Unit
                }
                if (action !is TokenPending.Rename) pending = null
            },
            extra = if (action is TokenPending.Rename) {
                {
                    var name by remember { mutableStateOf(action.token.name) }
                    OutlinedTextField(name, { name = it }, label = { Text("名称") }, modifier = Modifier.fillMaxWidth())
                    TextButton(onClick = {
                        viewModel.rename(action.token.id, name)
                        pending = null
                    }) { Text("保存") }
                }
            } else null,
        )
    }

    val revealed by viewModel.revealed.collectAsState()
    revealed?.let { (id, secret) ->
        AlertDialog(
            onDismissRequest = viewModel::dismissReveal,
            title = { Text("Token $id") },
            text = { Text(secret, fontFamily = FontFamily.Monospace) },
            confirmButton = { TextButton(onClick = viewModel::dismissReveal) { Text("关闭") } },
        )
    }
}

private sealed interface TokenPending {
    val title: String
    val body: String
    data class Reveal(val token: ClientToken) : TokenPending {
        override val title = "查看 Token"
        override val body = "需要当前密码或 TOTP。grant 单次且只对这次查看有效。"
    }
    data class Delete(val token: ClientToken) : TokenPending {
        override val title = "删除 Token"
        override val body = "删除后，使用 “${token.name.ifBlank { token.id }}” 绑定的 One / Agent 会在下次刷新时断开。"
    }
    data class Rename(val token: ClientToken) : TokenPending {
        override val title = "改名"
        override val body = "名称会写入本地镜像并排队同步，不需要敏感验证。"
    }
}

@Composable
fun ConflictCenterRoute(
    conflicts: ConflictRepository,
    onBack: () -> Unit,
    onMessage: (String) -> Unit,
) {
    val rows by conflicts.observeAll().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "冲突中心", onBack = onBack)
        if (rows.isEmpty()) {
            Text("没有待处理冲突。", modifier = Modifier.padding(ZephyrSpacing.lg), color = ZephyrTheme.palette.onFloatingMuted)
            return
        }
        LazyColumn(Modifier.padding(horizontal = ZephyrSpacing.lg)) {
            items(rows, key = { it.conflictId }) { row ->
                Column(Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
                    Text(row.displayName.ifBlank { row.entityId }, fontWeight = FontWeight.SemiBold)
                    Text("${row.entityType} · 重叠 ${row.overlappingFields.joinToString()}", color = ZephyrTheme.palette.onFloatingMuted, fontSize = 12.sp)
                    Row {
                        TextButton(onClick = {
                            scope.launch {
                                runCatching { conflicts.resolve(row.conflictId, ConflictResolution.KEEP_LOCAL) }
                                    .onSuccess { onMessage("已保留本机") }
                                    .onFailure { onMessage(it.message ?: "无法保留本机") }
                            }
                        }) { Text("保留本机") }
                        TextButton(onClick = {
                            scope.launch {
                                runCatching { conflicts.resolve(row.conflictId, ConflictResolution.USE_SERVER) }
                                    .onSuccess { onMessage("已使用服务端") }
                                    .onFailure { onMessage(it.message ?: "无法使用服务端") }
                            }
                        }) { Text("使用服务端") }
                        TextButton(onClick = {
                            scope.launch {
                                runCatching { conflicts.resolve(row.conflictId, ConflictResolution.COPY_AS_NEW) }
                                    .onSuccess { onMessage("已复制为新行") }
                                    .onFailure { onMessage(it.message ?: "无法复制") }
                            }
                        }) { Text("复制为新") }
                    }
                }
            }
        }
    }
}

@Composable
fun DeviceListRoute(
    api: MobileApi,
    localMode: Boolean,
    currentDeviceId: String,
    broker: SensitiveGrantBroker,
    onBack: () -> Unit,
    onMessage: (String) -> Unit,
) {
    var devices by remember { mutableStateOf<List<DeviceDto>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf<DeviceDto?>(null) }
    val scope = rememberCoroutineScope()

    fun reload() {
        if (localMode) return
        scope.launch {
            when (val result = api.devices()) {
                is ApiResult.Success -> {
                    devices = result.value
                    error = null
                }
                is ApiResult.Failure -> error = result.error.message
            }
        }
    }

    LaunchedEffect(localMode) { reload() }

    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "One 设备", onBack = onBack)
        if (localMode) {
            Text("本地模式没有已注册的 One 设备。", modifier = Modifier.padding(ZephyrSpacing.lg), color = ZephyrTheme.palette.onFloatingMuted)
            return
        }
        error?.let { Text(it, color = ZephyrTheme.palette.status.error, modifier = Modifier.padding(ZephyrSpacing.lg)) }
        LazyColumn(Modifier.padding(horizontal = ZephyrSpacing.lg)) {
            items(devices, key = { it.deviceId }) { device ->
                Column(Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
                    Text(
                        device.deviceName + if (device.deviceId == currentDeviceId) "（本机）" else "",
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        "${device.platform} · ${device.appVersion} · token ${device.tokenId}",
                        color = ZephyrTheme.palette.onFloatingMuted,
                        fontSize = 12.sp,
                    )
                    if (device.deviceId != currentDeviceId && device.revokedAt == null) {
                        TextButton(onClick = { pending = device }) { Text("撤销") }
                    }
                }
            }
        }
    }

    pending?.let { device ->
        SensitivePrompt(
            title = "撤销 ${device.deviceName}",
            body = "撤销后该设备必须重新绑定。需要当前密码或 TOTP。",
            onDismiss = { pending = null },
            onConfirm = { secret ->
                pending = null
                scope.launch {
                    val grant = broker.verify(ACTION_DEVICE_REVOKE, secret, listOf(device.deviceId)).getOrElse {
                        onMessage(it.message ?: "敏感验证失败")
                        return@launch
                    }
                    when (val result = api.deleteDevice(device.deviceId, grant.grantId)) {
                        is ApiResult.Success -> {
                            onMessage("已撤销")
                            reload()
                        }
                        is ApiResult.Failure -> onMessage(result.error.message)
                    }
                }
            },
        )
    }
}

@Composable
fun LocalSharesRoute(
    grants: List<SafShareGrant>,
    onPick: () -> Unit,
    onRevoke: (String) -> Unit,
    onBack: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "本机共享目录", onBack = onBack)
        Column(Modifier.padding(horizontal = ZephyrSpacing.lg), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("RDP 文件 drive 和文件桥接只使用你通过系统选择器交出的目录，不会申请整盘权限。")
            TextButton(onClick = onPick) { Text("添加目录") }
            grants.forEach { grant ->
                Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Text(grant.shareName, fontWeight = FontWeight.SemiBold)
                    Text(
                        (if (grant.grantValid) "授权有效" else "授权已失效，请重新选择") +
                            if (grant.readOnly) " · 只读" else " · 可写",
                        color = if (grant.grantValid) ZephyrTheme.palette.onFloatingMuted else ZephyrTheme.palette.status.warning,
                        fontSize = 12.sp,
                    )
                    TextButton(onClick = { onRevoke(grant.profileId) }) { Text("撤销") }
                }
            }
        }
    }
}

@Composable
fun ServerSettingsLiveRoute(
    settings: SettingsRepository,
    ownerUserId: String,
    onBack: () -> Unit,
    onMessage: (String) -> Unit,
) {
    val payload by settings.observeSection("serverSettings", ServerSettingsPolicy.SECTION_KEY)
        .collectAsState(initial = kotlinx.serialization.json.JsonObject(emptyMap()))
    val notesEnabled = dottedBool(payload, "notes.enabled", fallback = true) ||
        EntityCodec.bool(payload, "notes", fallback = true)
    val aiEnabled = dottedBool(payload, "ai.enabled", fallback = false)
    val serverVersion = dottedText(payload, "version", fallback = "v2.4.1")
    var notesOn by remember(notesEnabled) { mutableStateOf(notesEnabled) }
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "服务器设置", onBack = onBack)
        Column(Modifier.padding(horizontal = ZephyrSpacing.lg)) {
            one.zephyr.mobile.ui.component.GroupCard {
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "笔记功能",
                    subtitle = "关闭后导航不显示笔记入口，AI 笔记工具一并禁用",
                    trailing = {
                        one.zephyr.mobile.ui.component.Switch(notesOn, { notesOn = it })
                    },
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "AI runtime",
                    subtitle = "能力目录与本机对齐",
                    trailing = {
                        Text(
                            if (aiEnabled) "可用" else "未启用",
                            color = if (aiEnabled) ZephyrTheme.palette.status.success else ZephyrTheme.palette.onFloatingMuted,
                        )
                    },
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "终端工作台",
                    subtitle = "最小化窗口保持连接数 · 页面最多窗口数",
                    showChevron = true,
                    onClick = {},
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "版本 / 能力协商",
                    value = serverVersion.ifBlank { "v2.4.1" },
                    showDivider = false,
                )
            }
            Text(
                "普通用户看到只读公共设置；admin 按服务端授权显示可编辑 section",
                color = ZephyrTheme.palette.onFloatingMuted,
                fontSize = 12.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 24.dp),
            )
        }
    }
}

@Composable
fun AiSettingsLiveRoute(
    settings: SettingsRepository,
    ownerUserId: String,
    onBack: () -> Unit,
) {
    val prefs by settings.observePreferences().collectAsState(initial = emptyMap())
    val scope = rememberCoroutineScope()
    fun flag(key: String, fallback: Boolean): Boolean =
        prefs[key]?.let { EntityCodec.bool(it, "value", fallback) } ?: fallback
    fun text(key: String, fallback: String): String =
        prefs[key]?.let { EntityCodec.string(it, "value") } ?: fallback
    fun writeFlag(key: String, value: Boolean) {
        scope.launch { settings.putBooleanPreference(key, value, System.currentTimeMillis()) }
    }
    fun writeText(key: String, value: String) {
        scope.launch { settings.putStringPreference(key, value, System.currentTimeMillis()) }
    }
    val enabled = flag(SettingsRepository.PREF_AI_ENABLED, true)
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "AI 助理", onBack = onBack)
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = ZephyrSpacing.lg),
        ) {
            one.zephyr.mobile.ui.component.GroupCard {
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "启用 AI 助理",
                    subtitle = "在导航和工作区中显示 AI 功能",
                    showDivider = false,
                    trailing = {
                        one.zephyr.mobile.ui.component.Switch(
                            checked = enabled,
                            onCheckedChange = { writeFlag(SettingsRepository.PREF_AI_ENABLED, it) },
                        )
                    },
                )
            }
            one.zephyr.mobile.ui.component.SectionLabel("服务商与模型")
            one.zephyr.mobile.ui.component.GroupCard {
                AiChoiceRow("AI 服务商", "共享 Provider 不展示 API Key", text(SettingsRepository.PREF_AI_PROVIDER, "Claude"), listOf("Claude", "OpenAI", "Gemini", "本地")) {
                    writeText(SettingsRepository.PREF_AI_PROVIDER, it)
                }
                AiChoiceRow("模型", "上下文窗口 / 最大输出按模型动态计算", text(SettingsRepository.PREF_AI_MODEL, "Claude Opus"), listOf("Claude Opus", "Claude Sonnet", "GPT-5", "Gemini 3 Pro")) {
                    writeText(SettingsRepository.PREF_AI_MODEL, it)
                }
                AiChoiceRow("协作模式", null, text(SettingsRepository.PREF_AI_COLLAB, "协作"), listOf("协作", "自动", "只读")) {
                    writeText(SettingsRepository.PREF_AI_COLLAB, it)
                }
                AiChoiceRow("权限模式", null, text(SettingsRepository.PREF_AI_PERM, "按能力确认"), listOf("按能力确认", "自动确认", "全部询问")) {
                    writeText(SettingsRepository.PREF_AI_PERM, it)
                }
                AiChoiceRow("思考", "对支持扩展推理的模型启用思考模式", text(SettingsRepository.PREF_AI_THINK, "medium"), listOf("关闭", "low", "medium", "high")) {
                    writeText(SettingsRepository.PREF_AI_THINK, it)
                }
                AiChoiceRow("工具调用轮次上限", null, text(SettingsRepository.PREF_AI_TOOL_ROUNDS, "12"), listOf("4", "8", "12", "24")) {
                    writeText(SettingsRepository.PREF_AI_TOOL_ROUNDS, it)
                }
            }
            one.zephyr.mobile.ui.component.SectionLabel("确认策略")
            one.zephyr.mobile.ui.component.GroupCard {
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "敏感操作确认",
                    subtitle = "敏感操作包括远程执行、远程写文件等。关闭确认或开启自动确认会显著提高风险。",
                    showDivider = false,
                    trailing = {
                        one.zephyr.mobile.ui.component.Switch(
                            checked = flag(SettingsRepository.PREF_AI_CONFIRM, true),
                            onCheckedChange = { writeFlag(SettingsRepository.PREF_AI_CONFIRM, it) },
                        )
                    },
                )
            }
            one.zephyr.mobile.ui.component.SectionLabel("Memory 与规划器")
            one.zephyr.mobile.ui.component.GroupCard {
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "启用长期 Memory / 项目记忆",
                    showDivider = true,
                    trailing = {
                        one.zephyr.mobile.ui.component.Switch(
                            checked = flag(SettingsRepository.PREF_AI_MEMORY, true),
                            onCheckedChange = { writeFlag(SettingsRepository.PREF_AI_MEMORY, it) },
                        )
                    },
                )
                AiChoiceRow("最多保存 Memory 条数", null, text(SettingsRepository.PREF_AI_MEMORY_CAP, "200"), listOf("50", "100", "200", "500")) {
                    writeText(SettingsRepository.PREF_AI_MEMORY_CAP, it)
                }
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "任务计划器",
                    showDivider = false,
                    trailing = {
                        one.zephyr.mobile.ui.component.Switch(
                            checked = flag(SettingsRepository.PREF_AI_PLANNER, true),
                            onCheckedChange = { writeFlag(SettingsRepository.PREF_AI_PLANNER, it) },
                        )
                    },
                )
            }
            one.zephyr.mobile.ui.component.SectionLabel("Skills 能力包")
            one.zephyr.mobile.ui.component.GroupCard {
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "启用 Skill",
                    subtitle = "能力目录与同版本 Zephyr 主端一致，本机即可开关",
                    showDivider = false,
                    trailing = {
                        one.zephyr.mobile.ui.component.Switch(
                            checked = flag(SettingsRepository.PREF_AI_SKILLS, true),
                            onCheckedChange = { writeFlag(SettingsRepository.PREF_AI_SKILLS, it) },
                        )
                    },
                )
            }
            one.zephyr.mobile.ui.component.SectionLabel("AI 环境变量")
            one.zephyr.mobile.ui.component.GroupCard {
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "允许 AI 看到变量名/说明",
                    showDivider = true,
                    trailing = {
                        one.zephyr.mobile.ui.component.Switch(
                            checked = flag(SettingsRepository.PREF_AI_ENV_NAMES, true),
                            onCheckedChange = { writeFlag(SettingsRepository.PREF_AI_ENV_NAMES, it) },
                        )
                    },
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "允许 AI 直接看到变量值",
                    subtitle = "仅用于非敏感配置",
                    showDivider = false,
                    trailing = {
                        one.zephyr.mobile.ui.component.Switch(
                            checked = flag(SettingsRepository.PREF_AI_ENV_VALUES, false),
                            onCheckedChange = { writeFlag(SettingsRepository.PREF_AI_ENV_VALUES, it) },
                        )
                    },
                )
            }
            one.zephyr.mobile.ui.component.SectionLabel("用量")
            one.zephyr.mobile.ui.component.GroupCard {
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "本月 tokens",
                    subtitle = "本机计数 · 未同步时仍累计",
                    value = "—",
                    showDivider = false,
                )
            }
        }
    }
}

@Composable
private fun AiChoiceRow(
    title: String,
    subtitle: String?,
    value: String,
    options: List<String>,
    onPick: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    one.zephyr.mobile.ui.component.SettingsRow(
        title = title,
        subtitle = subtitle,
        value = value,
        showChevron = true,
        showDivider = true,
        onClick = { open = true },
    )
    if (open) {
        ActionSheet(
            visible = true,
            onDismiss = { open = false },
            groups = listOf(
                ActionSheetGroup(
                    items = options.map { option ->
                        ActionSheetItem(label = option, onClick = { onPick(option) })
                    },
                ),
                ActionSheetGroup(items = listOf(ActionSheetItem(label = "取消", cancel = true, onClick = {}))),
            ),
        )
    }
}

@Composable
fun DiagnosticsLiveRoute(
    appVersion: String,
    localMode: Boolean,
    bindingLabel: String,
    pending: Int,
    conflicts: Int,
    lastError: String?,
    onExport: () -> Unit,
    onBack: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "关于 Zephyr One", onBack = onBack)
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = ZephyrSpacing.lg),
        ) {
            one.zephyr.mobile.ui.component.GroupCard {
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "版本",
                    value = "One $appVersion · 主端 v2.4.1",
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "检查更新",
                    showChevron = true,
                    onClick = {},
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "GitHub",
                    showChevron = true,
                    onClick = {},
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "开源许可证",
                    showChevron = true,
                    onClick = {},
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "导出诊断日志",
                    showChevron = true,
                    showDivider = false,
                    onClick = onExport,
                )
            }
        }
    }
}

@Composable
private fun SensitivePrompt(
    title: String,
    body: String,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
    extra: (@Composable () -> Unit)? = null,
) {
    var secret by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(body)
                extra?.invoke()
                if (extra == null) {
                    OutlinedTextField(
                        value = secret,
                        onValueChange = { secret = it },
                        label = { Text("当前密码或 TOTP") },
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                }
            }
        },
        confirmButton = {
            if (extra == null) {
                TextButton(enabled = secret.isNotBlank(), onClick = { onConfirm(secret) }) { Text("继续") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

internal fun dottedText(payload: kotlinx.serialization.json.JsonObject, path: String, fallback: String): String {
    val direct = EntityCodec.string(payload, path)
    if (direct != null) return direct
    var current: kotlinx.serialization.json.JsonElement = payload
    for (part in path.split('.')) {
        val obj = current as? kotlinx.serialization.json.JsonObject ?: return fallback
        current = obj[part] ?: return fallback
    }
    return (current as? kotlinx.serialization.json.JsonPrimitive)?.content ?: fallback
}

internal fun dottedBool(payload: kotlinx.serialization.json.JsonObject, path: String, fallback: Boolean): Boolean {
    val direct = payload[path]
    if (direct is kotlinx.serialization.json.JsonPrimitive) {
        return EntityCodec.bool(payload, path, fallback)
    }
    var current: kotlinx.serialization.json.JsonElement = payload
    for (part in path.split('.')) {
        val obj = current as? kotlinx.serialization.json.JsonObject ?: return fallback
        current = obj[part] ?: return fallback
    }
    val primitive = current as? kotlinx.serialization.json.JsonPrimitive ?: return fallback
    return primitive.content.equals("true", ignoreCase = true)
}

@Composable
private fun SettingLine(label: String, value: String) {
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, fontWeight = FontWeight.Medium)
        Text(value, color = ZephyrTheme.palette.onFloatingMuted, fontSize = 13.sp)
    }
}
