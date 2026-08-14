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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
    val aiMemory = dottedBool(payload, "ai.memory.enabled", fallback = false)
    val appearance = dottedText(payload, "appearance", fallback = "由主端维护")
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "服务器设置", onBack = onBack)
        Column(Modifier.padding(horizontal = ZephyrSpacing.lg), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            SettingLine("外观", appearance.ifBlank { "由主端维护" })
            SettingLine("笔记功能", if (notesEnabled) "开启" else "关闭")
            SettingLine("AI runtime", if (aiEnabled) "可用" else "未启用")
            SettingLine("AI Memory", if (aiMemory) "开启" else "关闭")
            Text(
                "这些值来自本机镜像里的 serverSettings。普通用户只读；账号安全 / SMTP / 备案不在 One。",
                color = ZephyrTheme.palette.onFloatingMuted,
                fontSize = 12.sp,
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
    val payload by settings.observeSection("oneUserSettings", ServerSettingsPolicy.SECTION_KEY)
        .collectAsState(initial = kotlinx.serialization.json.JsonObject(emptyMap()))
    val server by settings.observeSection("serverSettings", ServerSettingsPolicy.SECTION_KEY)
        .collectAsState(initial = kotlinx.serialization.json.JsonObject(emptyMap()))
    val name = dottedText(payload, "ai.assistantName", fallback = "Zephyr AI")
    val layout = dottedText(payload, "ai.panelLayout", fallback = "floating")
    val enabled = dottedBool(server, "ai.enabled", fallback = false)
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "AI 助理", onBack = onBack)
        Column(Modifier.padding(horizontal = ZephyrSpacing.lg), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            SettingLine("主端 runtime", if (enabled) "已启用" else "未启用")
            SettingLine("助理名", name)
            SettingLine("面板布局", layout)
            Text(
                "浮窗执行链和 NativeSurfaceBridge 还没接到本机构建。共享 Provider 不会在这里展示 API Key。",
                color = ZephyrTheme.palette.onFloatingMuted,
                fontSize = 12.sp,
            )
        }
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
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            SettingLine("One", appVersion)
            SettingLine("工作区", if (localMode) "本地" else bindingLabel)
            SettingLine("待同步", pending.toString())
            SettingLine("冲突", conflicts.toString())
            lastError?.let { SettingLine("上次同步错误", it) }
            TextButton(onClick = onExport) { Text("导出诊断") }
            Text("诊断只含版本 / 模式 / 计数 / 错误码，不含 host / 用户 / 路径 / 密钥。", color = ZephyrTheme.palette.onFloatingMuted, fontSize = 12.sp)
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
