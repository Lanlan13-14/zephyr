package one.zephyr.mobile.app

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/** Explicit receive picker. No stored-connection credential lookup occurs on this path. */
@Composable
internal fun PrimaryPtyPickerButton(
    host: PrimaryPtyTerminalHost,
    onSelect: (localSessionId: String, connectionId: String) -> Unit,
    onMessage: suspend (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var opened by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var rows by remember { mutableStateOf(emptyList<PrimaryPtyCandidate>()) }
    var failure by remember { mutableStateOf<String?>(null) }
    fun refresh() {
        loading = true
        failure = null
        scope.launch {
            try { rows = host.candidates() }
            catch (error: Exception) { failure = error.message ?: "加载主端会话失败" }
            finally { loading = false }
        }
    }
    TextButton(onClick = { opened = true; refresh() }, modifier = Modifier.fillMaxWidth()) {
        Text("接收主端 SSH 会话")
    }
    if (opened) AlertDialog(
        onDismissRequest = { opened = false },
        title = { Text("主端 SSH 接力") },
        text = {
            Column {
                Text("上游凭据留在主端（trusted-primary）；屏幕应用成功后才转移控制权，原端随后停止输入。")
                if (loading) Text("正在加载…", Modifier.padding(top = 12.dp))
                failure?.let { Text(it, Modifier.padding(top = 12.dp)) }
                if (!loading && failure == null && rows.isEmpty()) Text("暂无允许接力的主端 SSH 会话", Modifier.padding(top = 12.dp))
                rows.forEach { row ->
                    TextButton(onClick = {
                        opened = false
                        val localId = host.select(row)
                        onSelect(localId, row.connectionId)
                    }, modifier = Modifier.fillMaxWidth()) { Text("接收：${row.name}") }
                }
            }
        },
        confirmButton = { TextButton(onClick = { if (!loading) refresh() }) { Text("刷新") } },
        dismissButton = { TextButton(onClick = { opened = false }) { Text("关闭") } },
    )
}
