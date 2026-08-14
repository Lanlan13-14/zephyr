package one.zephyr.mobile.feature.tools

import one.zephyr.mobile.ui.icon.ZephyrIcons

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import one.zephyr.mobile.ui.component.HorizontalDivider
import one.zephyr.mobile.ui.component.Icon
import one.zephyr.mobile.ui.component.IconButton
import one.zephyr.mobile.ui.component.Surface
import one.zephyr.mobile.ui.component.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import one.zephyr.mobile.model.ActionGate
import one.zephyr.mobile.ui.chrome.HeaderAddButton
import one.zephyr.mobile.ui.chrome.RootPageHeader
import one.zephyr.mobile.ui.island.islandContentBottomInset
import one.zephyr.mobile.ui.theme.ZephyrRadius
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme

data class ToolsRootSummaries(
    val batch: String = "多主机执行 · 并发 4 · fail-fast",
    val docker: String = "容器、镜像与生命周期",
    val monitor: String = "CPU · 内存 · 磁盘 · 网络",
    val logs: String = "tail · 搜索 · 导出",
    val proxy: String = "SOCKS5:1080 默认",
    val sshKey: String = "secret 三态编辑",
    val jumpHost: String = "多跳路由依赖",
    val ai: String = "已启用 · Claude Opus · 协作模式",
    val fileSync: String = "已开启 · 每 5 分钟 · 3 项待同步",
    val clientToken: String = "查看/旋转需敏感验证",
    val serverSettings: String = "设置 · 备份与恢复",
    val backup: String = "加密导出 · 校验 · 恢复",
    val runtimeStatus: String = "版本 · capability · runtime",
    val appearance: String = "Frost · 深色",
    val language: String = "跟随系统",
    val appLock: String = "生物识别 · 回前台 1 分钟",
    val network: String = "网络与后台策略",
    val diagnostics: String = "版本 · 日志导出",
)

/** S40 route contract. Callers must bind every catalog destination explicitly. */
@Composable
fun ToolsRootRoute(
    inventory: ToolsInventory,
    summaries: ToolsRootSummaries,
    onAddTool: () -> Unit,
    onOpenBatchExecution: () -> Unit,
    onOpenDocker: () -> Unit,
    onOpenMonitor: () -> Unit,
    onOpenLogs: () -> Unit,
    onOpenProxies: () -> Unit,
    onOpenSshKeys: () -> Unit,
    onOpenJumpHosts: () -> Unit,
    onOpenAiWorkspace: () -> Unit,
    onOpenFileSync: () -> Unit,
    onOpenClientToken: () -> Unit,
    onOpenServerSettings: () -> Unit,
    onOpenBackupRestore: () -> Unit,
    onOpenRuntimeStatus: () -> Unit,
    onOpenAppearance: () -> Unit,
    onOpenLanguage: () -> Unit,
    onOpenAppLock: () -> Unit,
    onOpenNetwork: () -> Unit,
    onOpenDiagnostics: () -> Unit,
    onUnavailableTool: (ToolEntry, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    ToolsRootScreen(
        inventory = inventory,
        summaries = summaries,
        onAddTool = onAddTool,
        onOpenTool = { entry ->
            when (entry) {
                ToolEntry.BATCH_EXEC -> onOpenBatchExecution()
                ToolEntry.DOCKER -> onOpenDocker()
                ToolEntry.MONITOR -> onOpenMonitor()
                ToolEntry.LOGS -> onOpenLogs()
                ToolEntry.PROXY -> onOpenProxies()
                ToolEntry.SSH_KEY -> onOpenSshKeys()
                ToolEntry.JUMP_HOST -> onOpenJumpHosts()
                ToolEntry.AI_WORKSPACE -> onOpenAiWorkspace()
                ToolEntry.FILE_SYNC -> onOpenFileSync()
                ToolEntry.CLIENT_TOKEN -> onOpenClientToken()
                ToolEntry.SERVER_SETTINGS -> onOpenServerSettings()
                ToolEntry.BACKUP_RESTORE -> onOpenBackupRestore()
                ToolEntry.RUNTIME_STATUS -> onOpenRuntimeStatus()
                ToolEntry.APPEARANCE -> onOpenAppearance()
                ToolEntry.LANGUAGE -> onOpenLanguage()
                ToolEntry.APP_LOCK -> onOpenAppLock()
                ToolEntry.NETWORK -> onOpenNetwork()
                ToolEntry.DIAGNOSTICS -> onOpenDiagnostics()
            }
        },
        onUnavailableTool = onUnavailableTool,
        modifier = modifier,
    )
}

@Composable
fun ToolsRootScreen(
    inventory: ToolsInventory,
    summaries: ToolsRootSummaries,
    onAddTool: () -> Unit,
    onOpenTool: (ToolEntry) -> Unit,
    onUnavailableTool: (ToolEntry, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxSize()) {
        RootPageHeader(title = stringResource(R.string.tools_root_title)) {
            HeaderAddButton(stringResource(R.string.tools_root_add), onAddTool)
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = ZephyrSpacing.lg),
            contentPadding = PaddingValues(bottom = islandContentBottomInset()),
            verticalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm),
        ) {
            ToolsCatalog.sections().forEachIndexed { sectionIndex, section ->
                item("section-${section.name}") { ToolsSectionTitle(section, compact = sectionIndex == 0) }
                item("group-${section.name}") {
                    val rows = ToolsCatalog.visibleRows(section, inventory)
                    ToolsGroup {
                        rows.forEachIndexed { index, entry ->
                            val gate = ToolsCatalog.gate(entry, inventory)
                            ToolRow(
                                entry = entry,
                                detail = toolDetail(entry, summaries, inventory, gate),
                                gate = gate,
                                showDivider = index != rows.lastIndex,
                                onClick = { onOpenTool(entry) },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ToolsSectionTitle(section: ToolSection, compact: Boolean) {
    Text(
        text = when (section) {
            ToolSection.REMOTE_OPS -> stringResource(R.string.tools_section_remote)
            ToolSection.RESOURCES -> stringResource(R.string.tools_section_resources)
            ToolSection.AI -> stringResource(R.string.tools_section_ai)
            ToolSection.FILE_SYNC -> stringResource(R.string.tools_section_file_sync)
            ToolSection.SERVER -> stringResource(R.string.tools_section_server)
            ToolSection.ONE -> stringResource(R.string.tools_section_one)
        }.uppercase(),
        color = ZephyrTheme.palette.onFloatingMuted,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(start = ZephyrSpacing.xs, top = if (compact) 2.dp else ZephyrSpacing.md, bottom = 2.dp)
            .semantics { heading() },
    )
}

@Composable
private fun ToolsGroup(content: @Composable () -> Unit) {
    Surface(
        color = ZephyrTheme.palette.surfaces.content,
        shape = RoundedCornerShape(ZephyrRadius.md),
        border = BorderStroke(1.dp, ZephyrTheme.palette.surfaces.outline.copy(alpha = .35f)),
    ) { Column { content() } }
}

@Composable
private fun ToolRow(
    entry: ToolEntry,
    detail: String,
    gate: ActionGate,
    showDivider: Boolean,
    onClick: () -> Unit,
) {
    val tint = toolTint(entry)
    val alpha = if (gate is ActionGate.Disabled) .62f else 1f
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 58.dp).clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(shape = RoundedCornerShape(8.dp), color = ZephyrTheme.palette.surfaces.elevated) {
                Box(Modifier.size(30.dp), contentAlignment = Alignment.Center) {
                    Icon(toolIcon(entry), null, tint = tint.copy(alpha = alpha), modifier = Modifier.size(17.dp))
                }
            }
            Spacer(Modifier.width(ZephyrSpacing.md))
            Column(Modifier.weight(1f)) {
                Text(toolTitle(entry), fontSize = 14.sp, color = ZephyrTheme.palette.onBackground.copy(alpha = alpha))
                Text(
                    detail,
                    fontSize = 11.5.sp,
                    color = if (gate is ActionGate.Disabled) ZephyrTheme.palette.status.warning else ZephyrTheme.palette.onFloatingMuted,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Icon(ZephyrIcons.Chevron, null, tint = ZephyrTheme.palette.onFloatingMuted.copy(alpha = alpha), modifier = Modifier.size(18.dp))
        }
        if (showDivider) HorizontalDivider(Modifier.padding(start = 56.dp), color = ZephyrTheme.palette.surfaces.outline.copy(alpha = .35f))
    }
}

@Composable
private fun toolTitle(entry: ToolEntry): String = when (entry) {
    ToolEntry.BATCH_EXEC -> stringResource(R.string.tools_batch)
    ToolEntry.DOCKER -> stringResource(R.string.tools_docker)
    ToolEntry.MONITOR -> stringResource(R.string.tools_monitor)
    ToolEntry.LOGS -> stringResource(R.string.tools_logs)
    ToolEntry.PROXY -> stringResource(R.string.tools_proxy)
    ToolEntry.SSH_KEY -> stringResource(R.string.tools_ssh_key)
    ToolEntry.JUMP_HOST -> stringResource(R.string.tools_jump_host)
    ToolEntry.AI_WORKSPACE -> stringResource(R.string.tools_ai)
    ToolEntry.FILE_SYNC -> stringResource(R.string.tools_file_sync)
    ToolEntry.CLIENT_TOKEN -> stringResource(R.string.tools_client_token)
    ToolEntry.SERVER_SETTINGS -> stringResource(R.string.tools_server)
    ToolEntry.BACKUP_RESTORE -> stringResource(R.string.tools_backup)
    ToolEntry.RUNTIME_STATUS -> stringResource(R.string.tools_runtime_status)
    ToolEntry.APPEARANCE -> stringResource(R.string.tools_appearance)
    ToolEntry.LANGUAGE -> stringResource(R.string.tools_language)
    ToolEntry.APP_LOCK -> stringResource(R.string.tools_app_lock)
    ToolEntry.NETWORK -> stringResource(R.string.tools_network)
    ToolEntry.DIAGNOSTICS -> stringResource(R.string.tools_diagnostics)
}

private fun toolDetail(entry: ToolEntry, summaries: ToolsRootSummaries, inventory: ToolsInventory, gate: ActionGate): String {
    if (gate is ActionGate.Disabled) return gate.reason
    return when (entry) {
        ToolEntry.BATCH_EXEC -> summaries.batch
        ToolEntry.DOCKER -> summaries.docker
        ToolEntry.MONITOR -> summaries.monitor
        ToolEntry.LOGS -> summaries.logs
        ToolEntry.PROXY -> summaries.proxy
        ToolEntry.SSH_KEY -> summaries.sshKey
        ToolEntry.JUMP_HOST -> summaries.jumpHost
        ToolEntry.AI_WORKSPACE -> summaries.ai
        ToolEntry.FILE_SYNC -> summaries.fileSync
        ToolEntry.CLIENT_TOKEN -> summaries.clientToken
        ToolEntry.SERVER_SETTINGS -> summaries.serverSettings
        ToolEntry.BACKUP_RESTORE -> summaries.backup
        ToolEntry.RUNTIME_STATUS -> summaries.runtimeStatus
        ToolEntry.APPEARANCE -> summaries.appearance
        ToolEntry.LANGUAGE -> summaries.language
        ToolEntry.APP_LOCK -> summaries.appLock
        ToolEntry.NETWORK -> summaries.network
        ToolEntry.DIAGNOSTICS -> summaries.diagnostics
    }
}

@Composable
private fun toolTint(entry: ToolEntry): Color = when (entry) {
    ToolEntry.BATCH_EXEC, ToolEntry.DOCKER, ToolEntry.MONITOR, ToolEntry.LOGS -> ZephyrTheme.palette.protocol.ssh
    ToolEntry.AI_WORKSPACE -> ZephyrTheme.palette.brand.accent
    ToolEntry.FILE_SYNC -> ZephyrTheme.palette.status.pendingSync
    else -> ZephyrTheme.palette.onFloatingMuted
}

private fun toolIcon(entry: ToolEntry): ImageVector = when (entry) {
    ToolEntry.BATCH_EXEC -> ZephyrIcons.Bolt
    ToolEntry.DOCKER -> ZephyrIcons.Docker
    ToolEntry.MONITOR -> ZephyrIcons.Monitor
    ToolEntry.LOGS -> ZephyrIcons.Notes
    ToolEntry.PROXY -> ZephyrIcons.Globe
    ToolEntry.SSH_KEY -> ZephyrIcons.Key
    ToolEntry.JUMP_HOST -> ZephyrIcons.JumpHost
    ToolEntry.AI_WORKSPACE -> ZephyrIcons.AiSpark
    ToolEntry.FILE_SYNC -> ZephyrIcons.Refresh
    ToolEntry.CLIENT_TOKEN -> ZephyrIcons.Ticket
    ToolEntry.SERVER_SETTINGS -> ZephyrIcons.Server
    ToolEntry.BACKUP_RESTORE -> ZephyrIcons.Save
    ToolEntry.RUNTIME_STATUS -> ZephyrIcons.Server
    ToolEntry.APPEARANCE -> ZephyrIcons.Theme
    ToolEntry.LANGUAGE -> ZephyrIcons.Globe
    ToolEntry.APP_LOCK -> ZephyrIcons.Lock
    ToolEntry.NETWORK -> ZephyrIcons.Refresh
    ToolEntry.DIAGNOSTICS -> ZephyrIcons.Activity
}
