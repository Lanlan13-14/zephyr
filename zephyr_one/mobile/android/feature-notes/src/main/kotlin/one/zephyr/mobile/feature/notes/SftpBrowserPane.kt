package one.zephyr.mobile.feature.notes

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import one.zephyr.mobile.model.MobileApiException
import one.zephyr.mobile.ui.component.*
import one.zephyr.mobile.ui.icon.ZephyrIcons
import one.zephyr.mobile.ui.theme.ZephyrTheme
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

private const val EDIT_READ_LIMIT = 512L * 1024L
private const val EDIT_WRITE_LIMIT = 1024 * 1024

private data class BrowserFile(
    val path: String,
    val text: String,
    val baseline: RemoteFileRead,
    val dirty: Boolean = false,
)

@Composable
fun SftpBrowserPane(
    port: SftpPort,
    connectionId: String,
    modifier: Modifier = Modifier,
    onMessage: (String) -> Unit = {},
    onDirtyChanged: (Boolean) -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    var handle by remember(connectionId, port) { mutableStateOf<SftpSessionHandle?>(null) }
    var path by remember(connectionId) { mutableStateOf(".") }
    var entries by remember { mutableStateOf<List<RemoteEntry>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var revision by remember { mutableIntStateOf(0) }
    var editor by remember { mutableStateOf<BrowserFile?>(null) }
    var pendingClose by remember { mutableStateOf(false) }
    LaunchedEffect(editor?.dirty) { onDirtyChanged(editor?.dirty == true) }

    BackHandler(enabled = editor != null) {
        if (editor?.dirty == true) pendingClose = true else editor = null
    }

    DisposableEffect(connectionId, port) {
        onDispose { handle?.let { scope.launch { port.close(it) } } }
    }

    LaunchedEffect(connectionId, revision) {
        loading = true
        error = null
        runCatching {
            val active = handle ?: port.open(connectionId).also {
                handle = it
                path = runCatching { port.canonicalPath(it, ".") }.getOrDefault("/")
            }
            val listed = port.list(active, path)
            entries = listed.sortedWith(compareByDescending<RemoteEntry> { it.isDirectory }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
        }.onFailure { error = it.displayMessage() }
        loading = false
    }

    if (editor != null) {
        SftpTextEditor(
            file = editor!!,
            onChange = { editor = editor!!.copy(text = it, dirty = true) },
            onBack = { if (editor!!.dirty) pendingClose = true else editor = null },
            onSave = {
                scope.launch {
                    val current = editor ?: return@launch
                    val bytes = current.text.toByteArray(Charsets.UTF_8)
                    if (bytes.size > EDIT_WRITE_LIMIT) {
                        onMessage("文件超过 1 MiB，拒绝保存")
                        return@launch
                    }
                    runCatching {
                        port.write(
                            handle ?: error("SFTP 会话已断开"), current.path, bytes,
                            current.baseline.mtimeMs, current.baseline.sha256, force = false,
                        )
                    }.onSuccess { receipt ->
                        editor = current.copy(
                            baseline = RemoteFileRead(current.path, bytes, receipt.mtimeMs, receipt.sha256),
                            dirty = false,
                        )
                        onMessage("已保存")
                    }.onFailure { onMessage(it.displayMessage()) }
                }
            },
        )
    } else {
        Column(modifier.fillMaxSize()) {
            SftpPathBar(
                path = path,
                canGoUp = path != "/" && path != ".",
                onUp = { path = parentPath(path); revision++ },
                onRefresh = { revision++ },
            )
            when {
                loading -> SftpEmpty("正在连接并读取 $path…")
                error != null -> SftpError(error!!, onRetry = { revision++ })
                entries.isEmpty() -> SftpEmpty("$path · 空目录")
                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                    items(entries, key = { it.path }) { entry ->
                        SftpEntryRow(entry) {
                            if (entry.isDirectory) {
                                path = entry.path
                                revision++
                            } else {
                                scope.launch {
                                    runCatching {
                                        val read = port.read(handle ?: error("SFTP 会话已断开"), entry.path, EDIT_READ_LIMIT)
                                        require(!read.truncated) { "文件超过 512 KiB，拒绝编辑" }
                                        val text = decodeUtf8Text(read.bytes)
                                        BrowserFile(entry.path, text, read)
                                    }.onSuccess { editor = it }.onFailure { onMessage(it.displayMessage()) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (pendingClose) {
        AlertDialog(
            onDismissRequest = { pendingClose = false },
            title = { Text("放弃未保存修改？") },
            text = { Text("返回文件列表会丢失当前修改。") },
            confirmButton = { TextButton(onClick = { pendingClose = false; editor = null }) { Text("放弃") } },
            dismissButton = { TextButton(onClick = { pendingClose = false }) { Text("继续编辑") } },
        )
    }
}

@Composable
private fun SftpPathBar(path: String, canGoUp: Boolean, onUp: () -> Unit, onRefresh: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(ZephyrTheme.palette.surfaces.content).padding(horizontal = 8.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        IconButton(onClick = onUp, enabled = canGoUp) {
            Icon(ZephyrIcons.Back, "返回上一级")
        }
        Text(
            path, modifier = Modifier.weight(1f), maxLines = 1,
            color = ZephyrTheme.palette.onFloating, fontFamily = FontFamily.Monospace, fontSize = 12.sp,
        )
        IconButton(onClick = onRefresh) {
            Icon(ZephyrIcons.Refresh, "刷新")
        }
    }
}

@Composable
private fun SftpEntryRow(entry: RemoteEntry, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(
            if (entry.isDirectory) ZephyrIcons.File else ZephyrIcons.Notes,
            null,
            tint = if (entry.isDirectory) ZephyrTheme.palette.protocol.sftp else ZephyrTheme.palette.onFloatingMuted,
            modifier = Modifier.size(20.dp),
        )
        Column(Modifier.weight(1f)) {
            Text(entry.name, color = ZephyrTheme.palette.onFloating, maxLines = 1, fontWeight = FontWeight.Medium)
            Text(
                if (entry.isDirectory) "目录" else formatRemoteSize(entry.sizeBytes),
                color = ZephyrTheme.palette.onFloatingSubtle, fontSize = 11.sp,
            )
        }
        Text("›", color = ZephyrTheme.palette.onFloatingSubtle, fontSize = 18.sp)
    }
}

@Composable
private fun SftpTextEditor(file: BrowserFile, onChange: (String) -> Unit, onBack: () -> Unit, onSave: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().background(ZephyrTheme.palette.surfaces.content).padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            IconButton(onClick = onBack) {
                Icon(ZephyrIcons.Back, "返回文件列表")
            }
            Column(Modifier.weight(1f)) {
                Text(file.path.substringAfterLast('/'), color = ZephyrTheme.palette.onFloating, fontWeight = FontWeight.SemiBold)
                Text(if (file.dirty) "未保存" else file.path, color = ZephyrTheme.palette.onFloatingSubtle, fontSize = 10.sp, maxLines = 1)
            }
            PrimaryButton(onClick = onSave, enabled = file.dirty) { Text("保存") }
        }
        BasicTextField(
            value = file.text,
            onValueChange = onChange,
            modifier = Modifier.fillMaxSize().background(ZephyrTheme.palette.surfaces.background).padding(14.dp),
            textStyle = androidx.compose.ui.text.TextStyle(
                color = ZephyrTheme.palette.onFloating,
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                lineHeight = 19.sp,
            ),
        )
    }
}

@Composable
private fun SftpEmpty(message: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(message, color = ZephyrTheme.palette.onFloatingSubtle)
    }
}

@Composable
private fun SftpError(message: String, onRetry: () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(message, color = ZephyrTheme.palette.status.error)
        Spacer(Modifier.height(12.dp))
        PrimaryButton(onClick = onRetry, ghost = true) { Text("重试") }
    }
}

internal fun parentPath(path: String): String {
    val normalized = path.trimEnd('/')
    if (normalized.isEmpty() || normalized == "." || normalized == "/") return "/"
    val parent = normalized.substringBeforeLast('/', missingDelimiterValue = ".")
    return if (parent.isEmpty()) "/" else parent
}

internal fun decodeUtf8Text(bytes: ByteArray): String {
    require(bytes.none { it == 0.toByte() }) { "检测到二进制内容，拒绝编辑" }
    val decoder = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
    return decoder.decode(ByteBuffer.wrap(bytes)).toString()
}

private fun Throwable.displayMessage(): String =
    (this as? MobileApiException)?.error?.message ?: message ?: "SFTP 操作失败"

private fun formatRemoteSize(bytes: Long): String = when {
    bytes >= 1024L * 1024L * 1024L -> "${bytes / (1024L * 1024L * 1024L)} GiB"
    bytes >= 1024L * 1024L -> "${bytes / (1024L * 1024L)} MiB"
    bytes >= 1024L -> "${bytes / 1024L} KiB"
    else -> "$bytes B"
}
