package one.zephyr.mobile.app

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import one.zephyr.mobile.app.di.AccountContainer
import one.zephyr.mobile.data.LocalImportPlanner
import one.zephyr.mobile.ui.component.AlertDialog
import one.zephyr.mobile.ui.component.Checkbox
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.component.TextButton

/** Defaults are intentionally empty: viewing the preview never consents to an upload. */
@Composable
internal fun LocalImportDialog(account: AccountContainer, onDismiss: () -> Unit) {
    val view by account.localImport.view.collectAsState()
    val scope = rememberCoroutineScope()
    var selected by remember(account.generation) { mutableStateOf(emptySet<String>()) }
    var credentials by remember(account.generation) { mutableStateOf(false) }
    var confirmed by remember(account.generation) { mutableStateOf(false) }
    LaunchedEffect(view.pendingTypes) {
        view.pendingTypes?.let { selected = it; credentials = view.pendingCredentials }
    }
    val enabled = view.ready && !view.busy
    AlertDialog(
        onDismissRequest = { if (!view.busy) onDismiss() },
        title = { Text("本机数据首次导入") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("目标账户：${account.binding.username}\n本机原数据保留。默认仅本机；不会自动上传或迁移所有权。")
                Text("复制会创建新 ID，重映射依赖，并取消原共享授权。设置、活动记录、设备身份及令牌不复制。")
                for ((type, count) in view.counts.toSortedMap()) {
                    val eligible = LocalImportPlanner.eligible(type)
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = type in selected,
                            enabled = enabled && eligible && view.pendingTypes == null,
                            onCheckedChange = { checked ->
                                selected = if (checked) selected + type else selected - type
                                confirmed = false
                            },
                        )
                        Text("${importTypeLabel(type)}：$count" + if (eligible) "" else "（仅保留本机）")
                    }
                }
                if (view.pendingTypes != null) Text("已有未完成批次：请继续原选择。已复制的项目不会重复创建，完成前暂停上传。")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(credentials, { credentials = it; confirmed = false }, enabled = enabled && view.pendingTypes == null)
                    Text("同时复制所选类型的凭据（默认不复制）")
                }
                Text("存在关联的连接、跳板、密钥、代理、AI 提供商或会话时，必须一并选择对应类型。")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(confirmed, { confirmed = it }, enabled = enabled && selected.isNotEmpty())
                    Text("我确认将所选副本上传至以上账户")
                }
                if (!view.ready) Text("等待账户快照完成；此时不会上传本机数据。")
                view.error?.let { Text(it) }
                if (view.busy) Text("正在复制；中断后可继续原批次…")
                TextButton(onClick = { scope.launch { runCatching { account.refreshLocalImport() } } }, enabled = !view.busy) { Text("刷新预览") }
            }
        },
        confirmButton = {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                TextButton(
                    enabled = enabled && view.pendingTypes == null,
                    onClick = { scope.launch { account.decideLocalImport(emptySet(), false, false); if (!account.localImport.view.value.required) onDismiss() } },
                ) { Text("仅保留本机（默认）") }
                TextButton(
                    enabled = enabled && selected.isNotEmpty() && confirmed,
                    onClick = { scope.launch { account.decideLocalImport(selected, credentials, confirmed); if (!account.localImport.view.value.required) onDismiss() } },
                ) { Text(if (view.pendingTypes == null) "复制为新实体并上传" else "继续原复制批次") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !view.busy) { Text("稍后决定（保持暂停上传）") } },
    )
}

private fun importTypeLabel(type: String): String = when (type) {
    "connection" -> "连接"; "proxy" -> "代理"; "sshKey" -> "SSH 密钥"; "jumpHost" -> "跳板"
    "note" -> "笔记"; "snippet" -> "命令片段"; "aiProvider" -> "AI 提供商"; "aiMemory" -> "AI 记忆"
    "aiSkill" -> "AI 技能"; "aiEnv" -> "AI 环境变量"; "aiTodo" -> "AI 待办"
    "aiConversation" -> "AI 会话"; "aiMessage" -> "AI 消息"
    else -> type
}
