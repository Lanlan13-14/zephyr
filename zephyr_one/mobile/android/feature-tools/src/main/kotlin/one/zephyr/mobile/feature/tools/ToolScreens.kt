package one.zephyr.mobile.feature.tools

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import one.zephyr.mobile.ui.component.AlertDialog
import one.zephyr.mobile.ui.component.Button
import one.zephyr.mobile.ui.component.FilterChip
import one.zephyr.mobile.ui.component.LinearProgress
import one.zephyr.mobile.ui.component.OutlinedTextField
import one.zephyr.mobile.ui.component.Slider
import one.zephyr.mobile.ui.component.Switch
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.component.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
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
import one.zephyr.mobile.ui.component.pressScale
import one.zephyr.mobile.ui.theme.ZephyrRadius
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme
import one.zephyr.mobile.ui.theme.ZephyrThemeId
import java.util.UUID

@Composable
fun AppearanceSettingsScreen(
    themeId: ZephyrThemeId,
    mode: String,
    onTheme: (ZephyrThemeId) -> Unit,
    onMode: (String) -> Unit,
    onBack: () -> Unit,
) {
    val palette = ZephyrTheme.palette
    var terminalFont by remember { mutableStateOf(13) }
    var ligatures by remember { mutableStateOf(false) }
    var customBackground by remember { mutableStateOf(false) }
    var customSelection by remember { mutableStateOf(false) }
    var splitMode by remember { mutableStateOf(0) }
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = stringResource(R.string.tools_appearance), onBack = onBack)
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = ZephyrSpacing.lg),
        ) {
            SectionLabel(stringResource(R.string.tools_appearance_theme))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                ZephyrThemeId.entries.forEach { id ->
                    val on = id == themeId
                    val interaction = remember { MutableInteractionSource() }
                    Column(
                        modifier = Modifier
                            .weight(1f)
                            .height(82.dp)
                            .pressScale(0.95f, interaction = interaction)
                            .clip(RoundedCornerShape(ZephyrRadius.md))
                            .background(palette.surfaces.content)
                            .border(
                                BorderStroke(2.dp, if (on) palette.brand.accent else Color.Transparent),
                                RoundedCornerShape(ZephyrRadius.md),
                            )
                            .clickable(interactionSource = interaction, indication = null) { onTheme(id) }
                            .padding(horizontal = 6.dp, vertical = 10.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Box(
                            Modifier
                                .size(34.dp)
                                .clip(CircleShape)
                                .background(Brush.linearGradient(listOf(id.swatchLight(), id.swatch()))),
                        )
                        Text(
                            id.wireName.replaceFirstChar { it.uppercase() },
                            color = if (on) palette.onBackground else palette.onFloatingMuted,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
            }
            SectionLabel(stringResource(R.string.tools_appearance_mode))
            one.zephyr.mobile.ui.component.GroupCard {
                Box(Modifier.padding(12.dp)) {
                    one.zephyr.mobile.ui.component.SegmentedControl(
                        options = listOf(
                            stringResource(R.string.tools_appearance_auto),
                            stringResource(R.string.tools_appearance_light),
                            stringResource(R.string.tools_appearance_dark),
                        ),
                        selectedIndex = listOf("auto", "light", "dark").indexOf(mode).coerceAtLeast(0),
                        onSelect = { onMode(listOf("auto", "light", "dark")[it]) },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            SectionLabel("终端")
            one.zephyr.mobile.ui.component.GroupCard {
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "终端字号",
                    trailing = {
                        one.zephyr.mobile.ui.component.SegmentedControl(
                            options = listOf("12", "13", "14", "15"),
                            selectedIndex = (terminalFont - 12).coerceIn(0, 3),
                            onSelect = { terminalFont = it + 12 },
                            modifier = Modifier.width(141.dp),
                        )
                    },
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "终端背景来源",
                    value = "纯黑 #07090C",
                    showChevron = true,
                    onClick = {},
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "允许终端字体连字",
                    subtitle = "仅同样式 run 内",
                    trailing = { Switch(ligatures, { ligatures = it }) },
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "自定义终端背景色",
                    subtitle = "所有配色模式生效",
                    trailing = { Switch(customBackground, { customBackground = it }) },
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "自定义选中色",
                    subtitle = "选中背景 + 选中文字",
                    trailing = { Switch(customSelection, { customSelection = it }) },
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "分屏",
                    subtitle = "双终端共享底部按钮 · 或一侧停靠工具",
                    showDivider = false,
                    trailing = {
                        one.zephyr.mobile.ui.component.SegmentedControl(
                            options = listOf("关", "双终端", "工具左", "工具右"),
                            selectedIndex = splitMode,
                            onSelect = { splitMode = it },
                            modifier = Modifier.width(205.dp),
                        )
                    },
                )
            }
            Text(
                stringResource(R.string.tools_appearance_note),
                color = palette.onFloatingSubtle,
                fontSize = 12.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 14.dp),
            )
        }
    }
}

@Composable
private fun ZephyrThemeId.swatch(): Color = when (this) {
    ZephyrThemeId.FROST -> Color(0xFF0A84FF)
    ZephyrThemeId.LAVA -> Color(0xFFBF5A1F)
    ZephyrThemeId.ASAGI -> Color(0xFF4D9C8A)
    ZephyrThemeId.CYBER -> Color(0xFF4F9DA6)
}

private fun ZephyrThemeId.swatchLight(): Color = when (this) {
    ZephyrThemeId.FROST -> Color(0xFFEEF2F7)
    ZephyrThemeId.LAVA -> Color(0xFFF1E8DF)
    ZephyrThemeId.ASAGI -> Color(0xFFEDF4F2)
    ZephyrThemeId.CYBER -> Color(0xFFEEF3F5)
}

@Composable
fun LanguageSettingsScreen(
    selected: String,
    onSelect: (String) -> Unit,
    onBack: () -> Unit,
) {
    val current = one.zephyr.mobile.ui.locale.AppLanguage.fromStored(selected)
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = stringResource(R.string.tools_language), onBack = onBack)
        Column(Modifier.padding(horizontal = ZephyrSpacing.lg)) {
            one.zephyr.mobile.ui.component.GroupCard {
                one.zephyr.mobile.ui.locale.AppLanguage.stored.forEachIndexed { index, lang ->
                    one.zephyr.mobile.ui.component.SettingsRow(
                        title = lang.nativeLabel,
                        selected = current == lang,
                        showDivider = index != one.zephyr.mobile.ui.locale.AppLanguage.stored.lastIndex,
                        onClick = { onSelect(lang.code) },
                    )
                }
            }
            Text(
                stringResource(R.string.tools_language_hint),
                color = ZephyrTheme.palette.onFloatingSubtle,
                fontSize = 12.sp,
                modifier = Modifier.padding(start = 4.dp, top = 12.dp),
            )
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
    onOpenDiagnostics: () -> Unit = {},
    onUnbind: (() -> Unit)? = null,
    onBack: () -> Unit,
) {
    val palette = ZephyrTheme.palette
    val phase = when {
        status.isRunning -> "正在同步"
        status.conflictCount > 0 -> "需要处理冲突"
        status.lastSuccessAt != null -> "镜像已同步"
        else -> "镜像待同步"
    }
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "文件同步", onBack = onBack)
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = ZephyrSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(0.dp),
        ) {
            one.zephyr.mobile.ui.component.GroupCard {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 15.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            Modifier.size(48.dp).clip(CircleShape).background(palette.status.success.copy(alpha = .16f)),
                            contentAlignment = Alignment.Center,
                        ) {
                            one.zephyr.mobile.ui.component.Icon(
                                one.zephyr.mobile.ui.icon.ZephyrIcons.Refresh,
                                contentDescription = null,
                                tint = palette.status.success,
                                modifier = Modifier.size(24.dp),
                            )
                        }
                        Column(Modifier.weight(1f).padding(start = 14.dp)) {
                            Text(phase, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                            Text(
                                if (localMode) "本机镜像" else "上次成功 · 下次自动 ${intervalLabel(settings.intervalSec)}",
                                color = palette.onFloatingSubtle,
                                fontSize = 12.5.sp,
                            )
                        }
                        Switch(settings.automaticEnabled, onAutomatic, enabled = !localMode)
                    }
                    LinearProgress(
                        progress = if (status.isRunning) .55f else 0f,
                        modifier = Modifier.padding(vertical = 14.dp),
                        color = palette.status.success,
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "cursor ${if (status.pendingCount > 0) status.pendingCount else 0} · 0 B/s",
                            color = palette.onFloatingSubtle,
                            fontSize = 12.5.sp,
                            modifier = Modifier.weight(1f),
                        )
                        Button(onClick = onSyncNow, enabled = !localMode && status.canSyncNow) { Text("立即同步") }
                    }
                }
            }
            one.zephyr.mobile.ui.component.SectionLabel("状态")
            one.zephyr.mobile.ui.component.GroupCard {
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "冲突中心",
                    showChevron = true,
                    onClick = onOpenConflicts,
                    leading = { ToolRowIcon(one.zephyr.mobile.ui.icon.ZephyrIcons.Warn, palette.status.warning) },
                    trailing = {
                        if (status.conflictCount > 0) {
                            Text(
                                "${status.conflictCount} 个冲突",
                                color = palette.status.warning,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Bold,
                                modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(palette.status.warning.copy(alpha = .15f)).padding(horizontal = 9.dp, vertical = 4.dp),
                            )
                        }
                    },
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "One 设备",
                    subtitle = "Pixel 8 Pro（本机）· iPad Air",
                    showChevron = true,
                    onClick = onOpenDevices,
                    leading = { ToolRowIcon(one.zephyr.mobile.ui.icon.ZephyrIcons.Devices) },
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "Client Token",
                    subtitle = "one-mobile-prod · lastUsed 2 分钟前",
                    showChevron = true,
                    onClick = onOpenTokens,
                    leading = { ToolRowIcon(one.zephyr.mobile.ui.icon.ZephyrIcons.Ticket) },
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "本机共享目录",
                    subtitle = "文件桥接 · 授权有效 · 只读",
                    showChevron = true,
                    onClick = onOpenShares,
                    leading = { ToolRowIcon(one.zephyr.mobile.ui.icon.ZephyrIcons.File) },
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "诊断",
                    subtitle = "幂等 / 墓碑 / secret envelope 正常",
                    showChevron = true,
                    showDivider = false,
                    onClick = onOpenDiagnostics,
                    leading = { ToolRowIcon(one.zephyr.mobile.ui.icon.ZephyrIcons.Activity) },
                )
            }
            one.zephyr.mobile.ui.component.SectionLabel("策略")
            one.zephyr.mobile.ui.component.GroupCard {
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "自动同步",
                    trailing = { Switch(settings.automaticEnabled, onAutomatic, enabled = !localMode) },
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "目标间隔",
                    value = intervalLabel(settings.intervalSec),
                    showChevron = true,
                    onClick = { onInterval(nextInterval(settings.intervalSec)) },
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "网络策略",
                    value = if (settings.networkPolicy == NetworkPolicy.WIFI_ONLY) "仅 Wi-Fi 传大文件" else "任意网络",
                    showChevron = true,
                    onClick = {
                        onPolicy(if (settings.networkPolicy == NetworkPolicy.WIFI_ONLY) NetworkPolicy.ANY else NetworkPolicy.WIFI_ONLY)
                    },
                )
                if (onUnbind != null) {
                    one.zephyr.mobile.ui.component.SettingsRow(
                        title = "解绑并删除本地镜像",
                        subtitle = "先 revoke 后清本机 · 需敏感验证",
                        titleColor = palette.status.error,
                        showChevron = true,
                        showDivider = false,
                        onClick = onUnbind,
                    )
                }
            }
        }
    }
}

private fun intervalLabel(seconds: Int): String = when {
    seconds < 60 -> "$seconds 秒"
    seconds % 60 == 0 -> "${seconds / 60} 分钟"
    else -> "$seconds 秒"
}

private fun nextInterval(seconds: Int): Int {
    val values = listOf(30, 60, 300, 900, 1800, 3600)
    return values.firstOrNull { it > seconds } ?: values.first()
}

@Composable
internal fun ToolRowIcon(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    tint: Color = ZephyrTheme.palette.onFloatingMuted,
) {
    Box(
        Modifier.size(30.dp).clip(RoundedCornerShape(8.dp)).background(ZephyrTheme.palette.surfaces.elevated),
        contentAlignment = Alignment.Center,
    ) {
        one.zephyr.mobile.ui.component.Icon(icon, null, tint = tint, modifier = Modifier.size(17.dp))
    }
}

@Composable
fun ClientTokenScreen(localMode: Boolean, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "Client Token", onBack = onBack)
        Text(
            if (localMode) {
                "未绑定主端时没有服务器 Token。本机工作区不需要它。绑定后可在此查看、旋转或删除，均需当前密码或 TOTP。"
            } else {
                "查看 / 复制 / 旋转 / 删除均需当前密码或 TOTP。grant 单次且 action+target 绑定。不会在这里明文列出 secret。"
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
fun ServerHubScreen(
    onOpenSettings: () -> Unit,
    onOpenBackup: () -> Unit,
    onBack: () -> Unit,
) {
    val palette = ZephyrTheme.palette
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "服务器", onBack = onBack)
        Column(Modifier.padding(horizontal = ZephyrSpacing.lg)) {
            one.zephyr.mobile.ui.component.GroupCard {
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "设置",
                    subtitle = "仅当前账号有权限且 One 有用途的项",
                    showChevron = true,
                    onClick = onOpenSettings,
                    leading = {
                        Box(
                            Modifier.size(30.dp).clip(RoundedCornerShape(8.dp)).background(palette.surfaces.elevated),
                            contentAlignment = Alignment.Center,
                        ) {
                            one.zephyr.mobile.ui.component.Icon(
                                one.zephyr.mobile.ui.icon.ZephyrIcons.Gear,
                                contentDescription = null,
                                tint = palette.onFloatingMuted,
                                modifier = Modifier.size(17.dp),
                            )
                        }
                    },
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "备份与恢复",
                    subtitle = "导出加密备份 · 导入需双密码",
                    showChevron = true,
                    showDivider = false,
                    onClick = onOpenBackup,
                    leading = {
                        Box(
                            Modifier.size(30.dp).clip(RoundedCornerShape(8.dp)).background(palette.surfaces.elevated),
                            contentAlignment = Alignment.Center,
                        ) {
                            one.zephyr.mobile.ui.component.Icon(
                                one.zephyr.mobile.ui.icon.ZephyrIcons.Save,
                                contentDescription = null,
                                tint = palette.onFloatingMuted,
                                modifier = Modifier.size(17.dp),
                            )
                        }
                    },
                )
            }
        }
    }
}

@Composable
fun BackupRestoreScreen(localMode: Boolean, onBack: () -> Unit) {
    var webDavEnabled by remember { mutableStateOf(false) }
    val palette = ZephyrTheme.palette
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "备份与恢复", onBack = onBack)
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = ZephyrSpacing.lg),
        ) {
            SectionLabel("导出")
            one.zephyr.mobile.ui.component.GroupCard {
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "范围",
                    subtitle = "连接 / 笔记 / 片段 / 设置 · AES-256-GCM · v${BackupFlow.FORMAT_VERSION}",
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "生成加密备份…",
                    titleColor = palette.brand.accent,
                    showDivider = false,
                    onClick = {},
                )
            }
            SectionLabel("导入")
            one.zephyr.mobile.ui.component.GroupCard {
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "从文件恢复…",
                    subtitle = "影响确认 → 服务端验证 → 所有 One 重新绑定",
                    titleColor = palette.brand.accent,
                    showDivider = false,
                    onClick = {},
                )
            }
            SectionLabel("WebDAV 备份")
            one.zephyr.mobile.ui.component.GroupCard {
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "启用 WebDAV 备份",
                    subtitle = "账号级加密备份到独立目录 · 仅 HTTPS",
                    trailing = { Switch(webDavEnabled, { webDavEnabled = it }) },
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "地址",
                    value = "https://dav.example.com/…",
                )
                one.zephyr.mobile.ui.component.SettingsRow(
                    title = "立即备份",
                    titleColor = palette.brand.accent,
                    showDivider = false,
                    onClick = {},
                )
            }
            Text(
                "失败时明确显示「原数据已回滚 / 未改动」",
                color = palette.onFloatingMuted,
                fontSize = 12.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
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
            Text("AI 在本机独立运行。Provider、模型、Memory 和 Skills 都存在这台设备上，不依赖主端。")
            Text("共享 Provider 不会在这里展示 API Key。", color = ZephyrTheme.palette.onFloatingMuted, fontSize = 12.sp)
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
