package one.zephyr.mobile.feature.tools

import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.text.AnnotatedString
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
import one.zephyr.mobile.ui.chrome.HeaderAddButton
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
    private val actions: ClientTokenActions,
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
            when (val result = actions.reveal(id, secret)) {
                is ApiResult.Success -> revealedState.value = id to result.value.secret
                is ApiResult.Failure -> messages.emit(result.error.message)
            }
        }
    }

    fun create(name: String) {
        viewModelScope.launch {
            when (val result = actions.create(name)) {
                is ApiResult.Success -> {
                    revealedState.value = result.value.id to result.value.secret
                    messages.emit("Token 已创建并显示")
                }
                is ApiResult.Failure -> messages.emit(result.error.message)
            }
        }
    }

    fun rotate(id: String, secret: String) {
        viewModelScope.launch {
            when (val result = actions.rotate(id, secret)) {
                is ApiResult.Success -> {
                    revealedState.value = id to result.value.secret
                    messages.emit("Token 已旋转；使用旧 Token 的设备需要重新绑定")
                }
                is ApiResult.Failure -> messages.emit(result.error.message)
            }
        }
    }

    fun delete(id: String, secret: String) {
        viewModelScope.launch {
            when (val result = actions.delete(id, secret)) {
                is ApiResult.Success -> messages.emit("已删除；使用该 Token 的设备需要重新绑定")
                is ApiResult.Failure -> messages.emit(result.error.message)
            }
        }
    }

    fun resetAll(name: String, secret: String) {
        viewModelScope.launch {
            when (val result = actions.resetAll(name, secret)) {
                is ApiResult.Success -> {
                    revealedState.value = result.value.id to result.value.secret
                    messages.emit("全部 Token 已重置；所有设备需要重新绑定")
                }
                is ApiResult.Failure -> messages.emit(result.error.message)
            }
        }
    }

    fun dismissReveal() {
        revealedState.value = null
    }

    companion object {
        fun factory(
            tokens: ClientTokenRepository,
            ownerUserId: String,
            actions: ClientTokenActions,
        ): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                ClientTokenViewModel(tokens, ownerUserId, actions) as T
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
    var menuToken by remember { mutableStateOf<ClientToken?>(null) }
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current

    Box(Modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "Client Token", onBack = onBack) {
            HeaderAddButton("新增 Token") {
                pending = TokenPending.Create
            }
        }
        if (localMode) {
            Text(
                "本地模式没有主端 Token。绑定服务器并完成首次同步后，这里会列出当前账号的 Token 元数据。查看/删除需要密码或 TOTP。",
                modifier = Modifier.padding(ZephyrSpacing.lg),
                color = ZephyrTheme.palette.onFloatingMuted,
            )
        } else {
        val liveRows = rows.filter { it.deletedAt == null }
        LazyColumn(contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 140.dp)) {
            item("tokens") {
                one.zephyr.mobile.ui.component.GroupCard {
                    liveRows.forEachIndexed { index, token ->
                        one.zephyr.mobile.ui.component.SettingsRow(
                            title = token.name.ifBlank { token.id },
                            subtitle = buildList {
                                if (token.linkedOneDeviceCount > 0) add("关联 One ×${token.linkedOneDeviceCount}")
                                if (token.linkedLegacyAgentCount > 0) add("关联旧 Agent ×${token.linkedLegacyAgentCount}")
                                token.lastUsedAt?.let { add("lastUsed ${RelativeTime.format(System.currentTimeMillis(), it)}") }
                            }.joinToString(" · ").ifBlank { "尚未使用" },
                            showDivider = index != liveRows.lastIndex,
                            showChevron = token.linkedOneDeviceCount == 0,
                            onClick = { menuToken = token },
                            leading = { ToolRowIcon(one.zephyr.mobile.ui.icon.ZephyrIcons.Ticket) },
                            trailing = {
                                if (token.linkedOneDeviceCount > 0) {
                                    Text(
                                        "本机",
                                        color = ZephyrTheme.palette.status.pendingSync,
                                        fontSize = 11.sp,
                                        fontWeight = FontWeight.SemiBold,
                                        modifier = Modifier
                                            .clip(RoundedCornerShape(8.dp))
                                            .background(ZephyrTheme.palette.status.pendingSync.copy(alpha = 0.14f))
                                            .padding(horizontal = 8.dp, vertical = 2.dp),
                                    )
                                }
                            },
                        )
                    }
                }
            }
            item("danger-label") {
                one.zephyr.mobile.ui.component.SectionLabel("危险区")
            }
            item("danger") {
                one.zephyr.mobile.ui.component.GroupCard {
                    one.zephyr.mobile.ui.component.SettingsRow(
                        title = "重置全部 Token",
                        subtitle = "所有 One / Agent 立即断开",
                        titleColor = ZephyrTheme.palette.status.error,
                        showDivider = false,
                        onClick = { pending = TokenPending.ResetAll },
                    )
                }
            }
            item("hint") {
                Text(
                    "查看 / 复制 / 旋转 / 删除均需当前密码或 TOTP · grant 单次且 action+target 绑定",
                    color = ZephyrTheme.palette.onFloatingSubtle,
                    fontSize = 13.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(top = 26.dp, bottom = 8.dp),
                )
            }
        }
        }
    }

    menuToken?.let { token ->
        ActionSheet(
            visible = true,
            onDismiss = { menuToken = null },
            groups = listOf(
                ActionSheetGroup(
                    title = "${token.name.ifBlank { token.id }} · secret 默认隐藏",
                    items = listOf(
                        ActionSheetItem("查看明文") {
                            menuToken = null
                            pending = TokenPending.Reveal(token)
                        },
                        ActionSheetItem("复制") {
                            menuToken = null
                            pending = TokenPending.Reveal(token)
                        },
                        ActionSheetItem("旋转", subtitle = "预览影响后确认") {
                            menuToken = null
                            pending = TokenPending.Rotate(token)
                        },
                        ActionSheetItem("删除", danger = true) {
                            menuToken = null
                            pending = TokenPending.Delete(token)
                        },
                    ),
                ),
                ActionSheetGroup(items = listOf(ActionSheetItem("取消", cancel = true) {})),
            ),
        )
    }

    pending?.let { action ->
        TokenActionPrompt(
            action = action,
            onDismiss = { pending = null },
            onConfirm = { name, secret ->
                when (action) {
                    TokenPending.Create -> viewModel.create(name)
                    is TokenPending.Reveal -> viewModel.reveal(action.token.id, secret)
                    is TokenPending.Rotate -> viewModel.rotate(action.token.id, secret)
                    is TokenPending.Delete -> viewModel.delete(action.token.id, secret)
                    TokenPending.ResetAll -> viewModel.resetAll(name, secret)
                }
                pending = null
            },
        )
    }

    val revealed by viewModel.revealed.collectAsState()
    revealed?.let { (id, secret) ->
        AlertDialog(
            onDismissRequest = viewModel::dismissReveal,
            title = { Text("Token $id") },
            text = { Text(secret, fontFamily = FontFamily.Monospace) },
            confirmButton = {
                TextButton(onClick = {
                    clipboard.setText(AnnotatedString(secret))
                    scope.launch { onMessage("Token 已复制") }
                }) { Text("复制") }
            },
            dismissButton = { TextButton(onClick = viewModel::dismissReveal) { Text("关闭") } },
        )
    }
    }
}

private sealed interface TokenPending {
    val title: String
    val body: String
    data object Create : TokenPending {
        override val title = "新增 Token"
        override val body = "生成后 secret 仅显示一次，请立即保存。"
    }
    data class Reveal(val token: ClientToken) : TokenPending {
        override val title = "查看 Token"
        override val body = "需要当前密码或 TOTP。grant 单次且只对这次查看有效。"
    }
    data class Rotate(val token: ClientToken) : TokenPending {
        override val title = "旋转 Token"
        override val body = "旋转后，使用旧 Token 绑定的 One / Agent 会立即失效。"
    }
    data class Delete(val token: ClientToken) : TokenPending {
        override val title = "删除 Token"
        override val body = "删除后，使用 “${token.name.ifBlank { token.id }}” 绑定的 One / Agent 会在下次刷新时断开。"
    }
    data object ResetAll : TokenPending {
        override val title = "重置全部 Token"
        override val body = "所有 One / Agent 会立即断开。输入当前密码或 TOTP 后再次确认。"
    }
}

@Composable
private fun TokenActionPrompt(
    action: TokenPending,
    onDismiss: () -> Unit,
    onConfirm: (name: String, secret: String) -> Unit,
) {
    var name by remember(action) { mutableStateOf("") }
    var secret by remember(action) { mutableStateOf("") }
    val needsName = action is TokenPending.Create || action is TokenPending.ResetAll
    val needsSecret = action !is TokenPending.Create
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(action.title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(action.body)
                if (needsName) {
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = { Text("名称") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                }
                if (needsSecret) {
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
            TextButton(
                enabled = (!needsName || name.isNotBlank()) && (!needsSecret || secret.isNotBlank()),
                onClick = { onConfirm(name.trim(), secret) },
            ) { Text(if (action is TokenPending.ResetAll) "重置" else "继续") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
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
        Column(Modifier.padding(horizontal = ZephyrSpacing.lg, vertical = 4.dp)) {
            one.zephyr.mobile.ui.component.GroupCard {
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "笔记功能",
                    subtitle = "关闭后导航不显示笔记入口，AI 笔记工具一并禁用",
                    trailing = {
                        one.zephyr.mobile.ui.component.Switch(notesOn, null, enabled = false)
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
                    onClick = { onMessage("当前服务端未开放终端工作台设置写入") },
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
                fontSize = 13.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(top = 26.dp, bottom = 8.dp),
            )
        }
    }
}

@Composable
fun AiSettingsLiveRoute(
    localAi: one.zephyr.mobile.data.repository.LocalAiRepository,
    bound: Boolean,
    onBack: () -> Unit,
    discoverModels: ModelDiscovery? = null,
    mainSyncCounts: MainAiSyncCounts? = null,
) {
    FullAiSettingsRoute(localAi, bound, onBack, discoverModels, mainSyncCounts)
}

data class MainAiSyncCounts(
    val providers: Int = 0,
    val memories: Int = 0,
    val skills: Int = 0,
    val env: Int = 0,
    val conversations: Int = 0,
)

@Composable
fun DiagnosticsLiveRoute(
    appVersion: String,
    localMode: Boolean,
    bindingLabel: String,
    pending: Int,
    conflicts: Int,
    lastError: String?,
    onCheckUpdate: () -> Unit,
    onOpenGitHub: () -> Unit,
    onOpenLicenses: () -> Unit,
    onExport: () -> Unit,
    onBack: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "关于 Zephyr One", onBack = onBack)
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = ZephyrSpacing.lg)
                .padding(top = 4.dp, bottom = 140.dp),
        ) {
            one.zephyr.mobile.ui.component.GroupCard {
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "版本",
                    value = "One $appVersion · 主端 v2.4.1",
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "检查更新",
                    showChevron = true,
                    onClick = onCheckUpdate,
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "GitHub",
                    showChevron = true,
                    onClick = onOpenGitHub,
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "开源许可证",
                    showChevron = true,
                    onClick = onOpenLicenses,
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
