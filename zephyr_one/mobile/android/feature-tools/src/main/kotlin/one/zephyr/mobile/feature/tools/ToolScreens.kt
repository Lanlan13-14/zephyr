package one.zephyr.mobile.feature.tools

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import one.zephyr.mobile.data.repository.ConnectionRepository
import one.zephyr.mobile.data.repository.ResourceRepository
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.NetworkPolicy
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.ProxyType
import one.zephyr.mobile.model.SecretState
import one.zephyr.mobile.model.SyncStatus
import one.zephyr.mobile.security.LockDelay
import one.zephyr.mobile.sync.SyncSettings
import one.zephyr.mobile.ui.chrome.HeaderAddButton
import one.zephyr.mobile.ui.chrome.PushedPageHeader
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme
import one.zephyr.mobile.ui.theme.ZephyrThemeId
import java.util.UUID

private val LANGUAGES = listOf(
    "system" to "跟随系统",
    "zh-Hans" to "简体中文",
    "zh-Hant" to "繁體中文",
    "en" to "English",
    "ja" to "日本語",
)

@Composable
fun AppearanceSettingsScreen(
    themeId: ZephyrThemeId,
    mode: String,
    onTheme: (ZephyrThemeId) -> Unit,
    onMode: (String) -> Unit,
    onBack: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "外观", onBack = onBack)
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = ZephyrSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            SectionLabel("主题色")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ZephyrThemeId.entries.forEach { id ->
                    FilterChip(
                        selected = id == themeId,
                        onClick = { onTheme(id) },
                        label = { Text(id.wireName.replaceFirstChar { it.uppercase() }) },
                    )
                }
            }
            SectionLabel("模式")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("auto" to "自动", "light" to "浅色", "dark" to "深色").forEach { (value, label) ->
                    FilterChip(selected = mode == value, onClick = { onMode(value) }, label = { Text(label) })
                }
            }
            Text(
                "终端 ANSI 输出色与 chrome 分离；浅色只改页面框架，不重写服务器颜色语义。",
                color = ZephyrTheme.palette.onFloatingMuted,
                fontSize = 12.sp,
            )
        }
    }
}

@Composable
fun LanguageSettingsScreen(
    selected: String,
    onSelect: (String) -> Unit,
    onBack: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "语言", onBack = onBack)
        Column(Modifier.padding(horizontal = ZephyrSpacing.lg)) {
            LANGUAGES.forEach { (code, label) ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { onSelect(code) }
                        .padding(vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(label, modifier = Modifier.weight(1f), fontWeight = if (selected == code) FontWeight.SemiBold else FontWeight.Normal)
                    if (selected == code) Text("已选", color = ZephyrTheme.palette.brand.accent, fontSize = 13.sp)
                }
            }
            Text("选择界面显示语言，立即生效并保存到本机", color = ZephyrTheme.palette.onFloatingMuted, fontSize = 12.sp)
        }
    }
}

@Composable
fun AppLockSettingsScreen(
    enabled: Boolean,
    delay: LockDelay,
    screenshotGuard: Boolean,
    availability: String,
    onEnabled: (Boolean) -> Unit,
    onDelay: (LockDelay) -> Unit,
    onScreenshot: (Boolean) -> Unit,
    onBack: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "本地解锁", onBack = onBack)
        Column(Modifier.padding(horizontal = ZephyrSpacing.lg), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("启用本地解锁", modifier = Modifier.weight(1f))
                Switch(checked = enabled, onCheckedChange = onEnabled)
            }
            Text(availability, color = ZephyrTheme.palette.onFloatingMuted, fontSize = 12.sp)
            if (enabled) {
                SectionLabel("回前台锁定")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = delay == LockDelay.IMMEDIATE, onClick = { onDelay(LockDelay.IMMEDIATE) }, label = { Text("立即") })
                    FilterChip(selected = delay == LockDelay.ONE_MINUTE, onClick = { onDelay(LockDelay.ONE_MINUTE) }, label = { Text("1 分钟") })
                    FilterChip(selected = delay == LockDelay.FIVE_MINUTES, onClick = { onDelay(LockDelay.FIVE_MINUTES) }, label = { Text("5 分钟") })
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("截图保护", modifier = Modifier.weight(1f))
                Switch(checked = screenshotGuard, onCheckedChange = onScreenshot)
            }
        }
    }
}

@Composable
fun NetworkSettingsScreen(
    policy: NetworkPolicy,
    onPolicy: (NetworkPolicy) -> Unit,
    onBack: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "网络", onBack = onBack)
        Column(Modifier.padding(horizontal = ZephyrSpacing.lg), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionLabel("蜂窝策略")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = policy == NetworkPolicy.ANY, onClick = { onPolicy(NetworkPolicy.ANY) }, label = { Text("任意网络") })
                FilterChip(selected = policy == NetworkPolicy.WIFI_ONLY, onClick = { onPolicy(NetworkPolicy.WIFI_ONLY) }, label = { Text("仅 Wi-Fi") })
            }
            Text("大文件和备份走该策略。立即同步在绑定存活时始终可用。", color = ZephyrTheme.palette.onFloatingMuted, fontSize = 12.sp)
        }
    }
}

@Composable
fun DiagnosticsScreen(
    appVersion: String,
    onExport: () -> Unit,
    onBack: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "关于 Zephyr One", onBack = onBack)
        Column(Modifier.padding(horizontal = ZephyrSpacing.lg), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("版本", color = ZephyrTheme.palette.onFloatingMuted, fontSize = 12.sp)
            Text("One $appVersion")
            TextButton(onClick = onExport) { Text("导出诊断日志") }
            Text("诊断只含错误码 / requestId，不含 host / 用户 / 路径 / 密钥。", color = ZephyrTheme.palette.onFloatingMuted, fontSize = 12.sp)
        }
    }
}

@Composable
fun FileSyncScreen(
    status: SyncStatus,
    settings: SyncSettings,
    localMode: Boolean,
    onAutomatic: (Boolean) -> Unit,
    onInterval: (Int) -> Unit,
    onPolicy: (NetworkPolicy) -> Unit,
    onSyncNow: () -> Unit,
    onOpenTokens: () -> Unit,
    onOpenConflicts: () -> Unit = {},
    onOpenDevices: () -> Unit = {},
    onOpenShares: () -> Unit = {},
    onUnbind: (() -> Unit)? = null,
    onBack: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "文件同步", onBack = onBack)
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = ZephyrSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                when {
                    localMode -> "本地模式 · 未绑定服务器"
                    status.isRunning -> "同步中"
                    status.conflictCount > 0 -> "有 ${status.conflictCount} 个冲突"
                    status.pendingCount > 0 -> "${status.pendingCount} 项待同步"
                    status.lastSuccessAt != null -> "镜像已同步"
                    else -> "尚未同步"
                },
                fontWeight = FontWeight.SemiBold,
            )
            TextButton(onClick = onSyncNow, enabled = !localMode && status.canSyncNow) { Text("立即同步") }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("自动同步", modifier = Modifier.weight(1f))
                Switch(checked = settings.automaticEnabled, onCheckedChange = onAutomatic, enabled = !localMode)
            }
            var interval by remember(settings.intervalSec) { mutableStateOf(settings.intervalSec.toFloat()) }
            Text("目标间隔 ${interval.toInt()} 秒")
            Slider(
                value = interval.coerceIn(30f, 3_600f),
                onValueChange = { interval = it },
                onValueChangeFinished = { onInterval(interval.toInt()) },
                valueRange = 30f..3_600f,
                enabled = !localMode,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = settings.networkPolicy == NetworkPolicy.ANY, onClick = { onPolicy(NetworkPolicy.ANY) }, label = { Text("任意网络") }, enabled = !localMode)
                FilterChip(selected = settings.networkPolicy == NetworkPolicy.WIFI_ONLY, onClick = { onPolicy(NetworkPolicy.WIFI_ONLY) }, label = { Text("仅 Wi-Fi") }, enabled = !localMode)
            }
            TextButton(onClick = onOpenConflicts) { Text("冲突中心 ${status.conflictCount} ›") }
            TextButton(onClick = onOpenDevices) { Text("One 设备 ›") }
            TextButton(onClick = onOpenTokens) { Text("Client Token ›") }
            TextButton(onClick = onOpenShares) { Text("本机共享目录 ›") }
            if (onUnbind != null) {
                TextButton(onClick = onUnbind) { Text("解绑并删除本地镜像") }
            }
            Text("解绑会先 revoke 设备再清本机镜像，需要敏感验证。", color = ZephyrTheme.palette.onFloatingMuted, fontSize = 12.sp)
        }
    }
}

@Composable
fun ClientTokenScreen(localMode: Boolean, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "Client Token", onBack = onBack)
        Text(
            if (localMode) {
                "本地模式没有主端 Token。绑定服务器后可在此查看、旋转或删除，查看/旋转/删除均需当前密码或 TOTP。"
            } else {
                "查看 / 复制 / 旋转 / 删除均需当前密码或 TOTP。grant 单次且 action+target 绑定。敏感验证门尚未接到本机 UI，不会在这里明文列出 secret。"
            },
            modifier = Modifier.padding(ZephyrSpacing.lg),
            color = ZephyrTheme.palette.onFloatingMuted,
        )
    }
}

@Composable
fun ServerSettingsScreen(
    state: ServerSettingsUiState,
    onBack: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "服务器设置", onBack = onBack)
        Column(Modifier.padding(horizontal = ZephyrSpacing.lg), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            SettingRow("外观", state.appearanceSummary.ifBlank { "由主端维护" })
            SettingRow("笔记功能", if (state.notesEnabled) "开启" else "关闭")
            SettingRow("AI runtime", if (state.aiRuntimeAvailable) "可用" else "未启用")
            SettingRow("版本", state.serverVersion.ifBlank { "未知" })
            state.statusItems.forEach { SettingRow(it.label, it.value) }
            Text(
                "普通用户看到只读公共设置；admin 按服务端授权显示可编辑 section。账号安全 / SMTP / 备案不在 One。",
                color = ZephyrTheme.palette.onFloatingMuted,
                fontSize = 12.sp,
            )
        }
    }
}

@Composable
fun BackupRestoreScreen(localMode: Boolean, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "备份与恢复", onBack = onBack)
        Column(Modifier.padding(horizontal = ZephyrSpacing.lg), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionLabel("导出")
            Text("范围 连接 / 笔记 / 片段 / 设置 · AES-256-GCM · v${BackupFlow.FORMAT_VERSION}")
            SectionLabel("导入")
            Text("从文件恢复… 影响确认 → 服务端验证 → 所有 One 重新绑定")
            Text(
                if (localMode) {
                    "本地模式没有主端备份任务。绑定管理员账号后才能在主端生成或校验备份。"
                } else {
                    "主端尚未发布 /api/mobile/v1/backup。失败时会明确显示「原数据已回滚 / 未改动」，不会假装成功。"
                },
                color = ZephyrTheme.palette.onFloatingMuted,
                fontSize = 12.sp,
            )
        }
    }
}

@Composable
fun RuntimeStatusScreen(
    appVersion: String,
    localMode: Boolean,
    pending: Int,
    conflicts: Int,
    onBack: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "运行状态", onBack = onBack)
        Column(Modifier.padding(horizontal = ZephyrSpacing.lg), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            SettingRow("One", appVersion)
            SettingRow("模式", if (localMode) "本地工作区" else "已绑定主端")
            SettingRow("待同步", pending.toString())
            SettingRow("冲突", conflicts.toString())
        }
    }
}

@Composable
fun DockerMonitorScreen(
    connections: List<Connection>,
    section: OpsSection,
    onBack: () -> Unit,
) {
    val title = when (section) {
        OpsSection.DOCKER -> "Docker / 监控"
        OpsSection.METRICS -> "监控"
        OpsSection.LOGS -> "日志"
    }
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = title, onBack = onBack)
        Column(Modifier.padding(horizontal = ZephyrSpacing.lg), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(UnavailableOpsPort().let { "SSH 引擎在此版本中尚未接入（ADR-002 M0 未关闭），无法读取 Docker、监控或日志。" }, color = ZephyrTheme.palette.onFloatingMuted)
            connections.filter { it.protocol == Protocol.SSH && it.capabilities.canObserve }.forEach { connection ->
                Text("${connection.name} · ${connection.host}", fontWeight = FontWeight.Medium)
            }
            Text("离线时显示最后 snapshot 时间，不把旧值说成实时。", color = ZephyrTheme.palette.onFloatingMuted, fontSize = 12.sp)
        }
    }
}

@Composable
fun AiSettingsScreen(onBack: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "AI 助理", onBack = onBack)
        Column(Modifier.padding(horizontal = ZephyrSpacing.lg), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("主端未启用 AI runtime，或本机构建尚未接入 NativeSurfaceBridge。")
            Text("能力目录与同版本 Zephyr 主端一致，不会维护手机子集。共享 Provider 不展示 API Key。", color = ZephyrTheme.palette.onFloatingMuted, fontSize = 12.sp)
        }
    }
}

class ResourceListViewModel(
    private val resources: ResourceRepository,
    private val connections: ConnectionRepository,
    private val ownerUserId: String,
    val kind: ResourceKind,
) : ViewModel() {
    private val rowsState = MutableStateFlow<List<ResourceRow>>(emptyList())
    val rows: StateFlow<List<ResourceRow>> = rowsState.asStateFlow()
    private val usable = MutableStateFlow<Set<String>>(emptySet())
    val usableConnectionIds: StateFlow<Set<String>> = usable.asStateFlow()

    init {
        viewModelScope.launch {
            when (kind) {
                ResourceKind.PROXY -> resources.observeProxies(ownerUserId).collect { list ->
                    rowsState.value = list.filter { it.deletedAt == null }.map { ResourceRows.of(it) }
                }
                ResourceKind.SSH_KEY -> resources.observeSshKeys(ownerUserId).collect { list ->
                    rowsState.value = list.filter { it.deletedAt == null }.map { ResourceRows.of(it) }
                }
                ResourceKind.JUMP_HOST -> resources.observeJumpHosts(ownerUserId).collect { list ->
                    rowsState.value = list.filter { it.deletedAt == null }.map { host ->
                        ResourceRows.of(host, connectionName = "")
                    }
                }
            }
        }
        viewModelScope.launch {
            connections.observeAll(ownerUserId).collect { list ->
                usable.value = list.filter { it.protocol == Protocol.SSH && it.capabilities.canUse }.map { it.id }.toSet()
            }
        }
    }

    fun delete(id: String) {
        viewModelScope.launch { runCatching { resources.delete(kind.entityType, id, ownerUserId) } }
    }

    companion object {
        fun factory(
            resources: ResourceRepository,
            connections: ConnectionRepository,
            ownerUserId: String,
            kind: ResourceKind,
        ): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                ResourceListViewModel(resources, connections, ownerUserId, kind) as T
        }
    }
}

@Composable
fun ResourceListRoute(
    viewModel: ResourceListViewModel,
    onBack: () -> Unit,
    onCreate: () -> Unit,
    onOpen: (String) -> Unit,
) {
    val rows by viewModel.rows.collectAsState()
    val title = when (viewModel.kind) {
        ResourceKind.PROXY -> "代理池"
        ResourceKind.SSH_KEY -> "SSH 密钥库"
        ResourceKind.JUMP_HOST -> "JumpHost"
    }
    var pending by remember { mutableStateOf<ResourceRow?>(null) }
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = title, onBack = onBack) {
            HeaderAddButton("新建", onCreate)
        }
        LazyColumn(contentPadding = PaddingValues(horizontal = ZephyrSpacing.lg, vertical = 8.dp)) {
            items(rows, key = { it.id }) { row ->
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clickable { onOpen(row.id) }
                        .padding(vertical = 12.dp),
                ) {
                    Text(row.name, fontWeight = FontWeight.SemiBold)
                    Text(row.subtitle, color = ZephyrTheme.palette.onFloatingMuted, fontSize = 12.sp)
                    TextButton(onClick = { pending = row }) { Text("删除") }
                }
            }
            item {
                Text(
                    "编辑时留空密码不会覆盖已保存密码 · 被引用时删除受保护",
                    color = ZephyrTheme.palette.onFloatingMuted,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(vertical = 12.dp),
                )
            }
        }
    }
    pending?.let { target ->
        AlertDialog(
            onDismissRequest = { pending = null },
            title = { Text("删除 ${target.name}") },
            text = { Text(if (target.isReferenced) "仍被连接引用，无法删除。" else "删除进入同步 tombstone。") },
            confirmButton = {
                TextButton(
                    enabled = !target.isReferenced,
                    onClick = {
                        viewModel.delete(target.id)
                        pending = null
                    },
                ) { Text("删除") }
            },
            dismissButton = { TextButton(onClick = { pending = null }) { Text("取消") } },
        )
    }
}

class ResourceEditorViewModel(
    private val resources: ResourceRepository,
    private val ownerUserId: String,
    val kind: ResourceKind,
    private val entityId: String?,
    private val newIdFactory: () -> String,
    private val usableConnectionIds: () -> Set<String>,
) : ViewModel() {
    private val proxyState = MutableStateFlow<ProxyDraft?>(null)
    val proxyFlow: StateFlow<ProxyDraft?> = proxyState.asStateFlow()
    private val keyState = MutableStateFlow<SshKeyDraft?>(null)
    val keyFlow: StateFlow<SshKeyDraft?> = keyState.asStateFlow()
    private val jumpState = MutableStateFlow<JumpHostDraft?>(null)
    val jumpFlow: StateFlow<JumpHostDraft?> = jumpState.asStateFlow()
    val proxy: ProxyDraft? get() = proxyState.value
    val key: SshKeyDraft? get() = keyState.value
    val jump: JumpHostDraft? get() = jumpState.value
    private val messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val message: SharedFlow<String> = messages
    private val done = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val finished: SharedFlow<Unit> = done

    init {
        viewModelScope.launch { load() }
    }

    private suspend fun load() {
        when (kind) {
            ResourceKind.PROXY -> {
                val existing = entityId?.let { resources.findProxy(it) }
                proxyState.value = existing?.let(ProxyDraft::edit) ?: ProxyDraft.create(ownerUserId, newIdFactory())
            }
            ResourceKind.SSH_KEY -> {
                val existing = entityId?.let { resources.findSshKey(it) }
                keyState.value = existing?.let(SshKeyDraft::edit) ?: SshKeyDraft.create(ownerUserId, newIdFactory())
            }
            ResourceKind.JUMP_HOST -> {
                val existing = entityId?.let { resources.findJumpHost(it) }
                jumpState.value = existing?.let(JumpHostDraft::edit) ?: JumpHostDraft.create(ownerUserId, newIdFactory())
            }
        }
    }

    fun setProxy(block: (ProxyDraft) -> ProxyDraft) {
        proxyState.value = proxyState.value?.let(block)
    }

    fun setKey(block: (SshKeyDraft) -> SshKeyDraft) {
        keyState.value = keyState.value?.let(block)
    }

    fun setJump(block: (JumpHostDraft) -> JumpHostDraft) {
        jumpState.value = jumpState.value?.let(block)
    }

    fun save() {
        viewModelScope.launch {
            val outcome = runCatching {
                when (kind) {
                    ResourceKind.PROXY -> {
                        val draft = proxy ?: return@launch
                        if (!draft.canSave) error(draft.validate().firstOrNull()?.message ?: "无法保存")
                        resources.saveProxy(draft.normalized(), draft.changedFields(), draft.password, ownerUserId, draft.isCreate)
                    }
                    ResourceKind.SSH_KEY -> {
                        val draft = key ?: return@launch
                        if (!draft.canSave) error(draft.validate().firstOrNull()?.message ?: "无法保存")
                        resources.saveSshKey(draft.normalized(), draft.changedFields(), draft.privateKey, draft.passphrase, ownerUserId, draft.isCreate)
                    }
                    ResourceKind.JUMP_HOST -> {
                        val draft = jump ?: return@launch
                        val usable = usableConnectionIds()
                        if (!draft.canSave(usable)) error(draft.validate(usable).firstOrNull()?.message ?: "无法保存")
                        resources.saveJumpHost(draft.normalized(), draft.changedFields(), ownerUserId, draft.isCreate)
                    }
                }
            }
            outcome.onSuccess {
                messages.emit("已保存，待同步")
                done.emit(Unit)
            }.onFailure { messages.emit(it.message ?: "保存未完成") }
        }
    }

    companion object {
        fun factory(
            resources: ResourceRepository,
            ownerUserId: String,
            kind: ResourceKind,
            entityId: String?,
            usableConnectionIds: () -> Set<String>,
            newIdFactory: () -> String = { UUID.randomUUID().toString() },
        ): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                ResourceEditorViewModel(resources, ownerUserId, kind, entityId, newIdFactory, usableConnectionIds) as T
        }
    }
}

@Composable
fun ResourceEditorRoute(
    viewModel: ResourceEditorViewModel,
    usableConnectionIds: Set<String>,
    connections: List<Connection>,
    onBack: () -> Unit,
    onMessage: suspend (String) -> Unit,
) {
    val proxy by viewModel.proxyFlow.collectAsState()
    val key by viewModel.keyFlow.collectAsState()
    val jump by viewModel.jumpFlow.collectAsState()
    LaunchedEffect(viewModel) { viewModel.message.collect { onMessage(it) } }
    LaunchedEffect(viewModel) { viewModel.finished.collect { onBack() } }
    val title = when (viewModel.kind) {
        ResourceKind.PROXY -> "编辑代理"
        ResourceKind.SSH_KEY -> "编辑 SSH Key"
        ResourceKind.JUMP_HOST -> "编辑 JumpHost"
    }
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = title, onBack = onBack) {
            TextButton(onClick = viewModel::save) { Text("保存") }
        }
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = ZephyrSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            when (viewModel.kind) {
                ResourceKind.PROXY -> proxy?.let { draft ->
                    OutlinedTextField(draft.current.name, { value -> viewModel.setProxy { d -> d.withName(value) } }, label = { Text("名称") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(draft.current.host, { value -> viewModel.setProxy { d -> d.withHost(value) } }, label = { Text("主机") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(draft.current.port.toString(), { value ->
                        value.toIntOrNull()?.let { port -> viewModel.setProxy { d -> d.withPort(port) } }
                    }, label = { Text("端口") }, modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        ProxyType.entries.forEach { type ->
                            FilterChip(selected = draft.current.type == type, onClick = { viewModel.setProxy { d -> d.withType(type) } }, label = { Text(type.wireName) })
                        }
                    }
                    OutlinedTextField(draft.current.username, { value -> viewModel.setProxy { d -> d.withUsername(value) } }, label = { Text("用户名") }, modifier = Modifier.fillMaxWidth())
                    SecretField(label = "密码（留空保持不变）") { value ->
                        viewModel.setProxy { d -> d.withPassword(if (value.isBlank()) SecretState.Unchanged else SecretState.Replace(value)) }
                    }
                }
                ResourceKind.SSH_KEY -> key?.let { draft ->
                    OutlinedTextField(draft.current.name, { value -> viewModel.setKey { d -> d.withName(value) } }, label = { Text("名称") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(draft.current.remark, { value -> viewModel.setKey { d -> d.withRemark(value) } }, label = { Text("备注") }, modifier = Modifier.fillMaxWidth())
                    SecretField(label = "私钥（留空保持不变）", minHeight = 140.dp) { value ->
                        viewModel.setKey { d -> d.withPrivateKey(if (value.isBlank()) SecretState.Unchanged else SecretState.Replace(value)) }
                    }
                    SecretField(label = "口令（留空保持不变）") { value ->
                        viewModel.setKey { d -> d.withPassphrase(if (value.isBlank()) SecretState.Unchanged else SecretState.Replace(value)) }
                    }
                }
                ResourceKind.JUMP_HOST -> jump?.let { draft ->
                    OutlinedTextField(draft.current.name, { value -> viewModel.setJump { d -> d.withName(value) } }, label = { Text("名称") }, modifier = Modifier.fillMaxWidth())
                    Text("目标 SSH 连接")
                    connections.filter { it.id in usableConnectionIds }.forEach { connection ->
                        FilterChip(
                            selected = draft.current.connectionId == connection.id,
                            onClick = { viewModel.setJump { d -> d.withConnection(connection.id) } },
                            label = { Text(connection.name) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SecretField(
    label: String,
    minHeight: androidx.compose.ui.unit.Dp = 56.dp,
    onValue: (String) -> Unit,
) {
    var text by remember { mutableStateOf("") }
    OutlinedTextField(
        value = text,
        onValueChange = { value ->
            text = value
            onValue(value)
        },
        label = { Text(label) },
        modifier = Modifier.fillMaxWidth().height(minHeight.coerceAtLeast(56.dp)),
    )
}

@Composable
private fun SectionLabel(text: String) {
    Text(text.uppercase(), color = ZephyrTheme.palette.onFloatingMuted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
}

@Composable
private fun SettingRow(label: String, value: String) {
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(label, fontWeight = FontWeight.Medium)
        Text(value, color = ZephyrTheme.palette.onFloatingMuted, fontSize = 13.sp)
    }
}
