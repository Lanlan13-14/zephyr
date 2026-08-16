package one.zephyr.mobile.feature.notes

import android.graphics.BitmapFactory
import android.media.MediaPlayer
import android.net.Uri
import android.view.ViewGroup
import android.widget.VideoView
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.launch
import one.zephyr.mobile.model.MobileApiException
import one.zephyr.mobile.protocol.ssh.SshFileKinds
import one.zephyr.mobile.ui.component.*
import one.zephyr.mobile.ui.icon.ZephyrIcons
import one.zephyr.mobile.ui.theme.ZephyrTheme
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

private const val EDIT_WRITE_LIMIT = 2 * 1024 * 1024

private data class BrowserFile(
    val path: String,
    val text: String,
    val baseline: RemoteFileRead,
    val encoding: FileEncoding = FileEncoding.UTF8,
    val lineEnding: String = if (text.contains("\r\n")) "crlf" else "lf",
    val dirty: Boolean = false,
)

private data class PreviewState(
    val path: String,
    val kind: SftpOpenKind,
    val bytes: ByteArray,
    val sizeBytes: Long,
)

private data class TransferJob(
    val label: String,
    val progress: Float,
    val detail: String,
)

private sealed interface SftpDialog {
    data class PromptName(val title: String, val initial: String, val confirm: String, val onConfirm: (String) -> Unit) : SftpDialog
    data class Confirm(val title: String, val body: String, val danger: Boolean = false, val onConfirm: () -> Unit) : SftpDialog
    data class Properties(val title: String, val lines: List<Pair<String, String>>) : SftpDialog
    data class Chmod(val path: String, val initial: String) : SftpDialog
    data class PasteConflict(val names: List<String>) : SftpDialog
    data class SaveConflict(val path: String) : SftpDialog
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SftpBrowserPane(
    port: SftpPort,
    connectionId: String,
    modifier: Modifier = Modifier,
    onMessage: (String) -> Unit = {},
    onDirtyChanged: (Boolean) -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var handle by remember(connectionId, port) { mutableStateOf<SftpSessionHandle?>(null) }
    var path by remember(connectionId) { mutableStateOf(".") }
    var pathDraft by remember { mutableStateOf(".") }
    var entries by remember { mutableStateOf<List<RemoteEntry>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var revision by remember { mutableIntStateOf(0) }
    var query by remember { mutableStateOf("") }
    var showHidden by remember { mutableStateOf(false) }
    var sortKey by remember { mutableStateOf(FileSortKey.NAME) }
    var selecting by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf<Set<String>>(emptySet()) }
    var editor by remember { mutableStateOf<BrowserFile?>(null) }
    var preview by remember { mutableStateOf<PreviewState?>(null) }
    var pendingClose by remember { mutableStateOf(false) }
    var dialog by remember { mutableStateOf<SftpDialog?>(null) }
    var clipboard by remember { mutableStateOf<SftpClipboard?>(null) }
    var transfer by remember { mutableStateOf<TransferJob?>(null) }
    var busy by remember { mutableStateOf(false) }
    var moreOpen by remember { mutableStateOf(false) }
    LaunchedEffect(editor?.dirty) { onDirtyChanged(editor?.dirty == true) }

    val overlayOpen = editor != null || preview != null
    BackHandler(enabled = overlayOpen || selecting) {
        when {
            editor?.dirty == true -> pendingClose = true
            editor != null -> editor = null
            preview != null -> preview = null
            selecting -> {
                selecting = false
                selected = emptySet()
            }
        }
    }

    DisposableEffect(connectionId, port) {
        onDispose { handle?.let { scope.launch { port.close(it) } } }
    }

    fun currentHandle(): SftpSessionHandle = handle ?: error("SFTP 会话已断开")

    fun refresh() {
        revision++
    }

    val uploadLauncher = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            runOp(onMessage, { busy = it }, { transfer = it }) {
                val active = currentHandle()
                uris.forEachIndexed { index, uri ->
                    val name = queryDisplayName(context, uri) ?: "upload-${index + 1}"
                    transfer = TransferJob("上传 $name", index.toFloat() / uris.size, "${index + 1}/${uris.size}")
                    val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                        ?: error("无法读取 $name")
                    if (bytes.size > EDIT_WRITE_LIMIT) error("$name 超过 ${SftpOpenPolicy.formatBytes(EDIT_WRITE_LIMIT.toLong())}，当前版本请改用较小文件")
                    port.upload(active, RemotePath.join(path, name), bytes)
                }
                onMessage("已上传 ${uris.size} 个文件")
                refresh()
            }
        }
    }
    var downloadTarget by remember { mutableStateOf<RemoteEntry?>(null) }
    val downloadLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
        val entry = downloadTarget
        downloadTarget = null
        if (uri == null || entry == null) return@rememberLauncherForActivityResult
        scope.launch {
            runOp(onMessage, { busy = it }, { transfer = it }) {
                val active = currentHandle()
                context.contentResolver.openOutputStream(uri)?.use { output ->
                    var offset = 0L
                    val total = entry.sizeBytes.coerceAtLeast(1L)
                    while (offset < entry.sizeBytes || entry.sizeBytes == 0L) {
                        val chunk = port.readRange(active, entry.path, offset, 256 * 1024)
                        if (chunk.bytes.isEmpty()) break
                        output.write(chunk.bytes)
                        offset += chunk.bytes.size
                        transfer = TransferJob("下载 ${entry.name}", (offset.toFloat() / total).coerceIn(0f, 1f), SftpOpenPolicy.formatBytes(offset))
                        if (chunk.bytes.size < 256 * 1024) break
                    }
                } ?: error("无法写入本机文件")
                onMessage("已下载 ${entry.name}")
            }
        }
    }

    LaunchedEffect(connectionId, revision) {
        loading = true
        error = null
        runCatching {
            val active = handle ?: port.open(connectionId).also {
                handle = it
                path = runCatching { port.canonicalPath(it, ".") }.getOrDefault("/")
                pathDraft = path
            }
            val listed = port.list(active, path)
            path = runCatching { port.canonicalPath(active, path) }.getOrDefault(path)
            pathDraft = path
            entries = listed.sortedWith(compareByDescending<RemoteEntry> { it.isDirectory }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
            selected = selected.intersect(listed.map { it.path }.toSet())
        }.onFailure { error = it.displayMessage() }
        loading = false
    }

    val visible = remember(entries, query, showHidden, sortKey) {
        SftpBrowserStates.filterAndSort(
            entries,
            SftpBrowserInput(
                connectionId = connectionId,
                directory = path,
                entries = entries,
                query = query,
                showHidden = showHidden,
                sortKey = sortKey,
            ),
        )
    }

    fun selectedEntries(): List<RemoteEntry> {
        val picked = entries.filter { it.path in selected }
        return picked.ifEmpty { emptyList() }
    }

    fun openEntry(entry: RemoteEntry) {
        if (selecting) {
            selected = if (entry.path in selected) selected - entry.path else selected + entry.path
            if (selected.isEmpty()) selecting = false
            return
        }
        val kind = SftpOpenPolicy.kindOf(entry)
        if (kind == SftpOpenKind.DIRECTORY) {
            path = entry.path
            pathDraft = entry.path
            refresh()
            return
        }
        SftpOpenPolicy.rejectReason(kind, entry.sizeBytes)?.let {
            onMessage(it)
            return
        }
        scope.launch {
            runOp(onMessage, { busy = it }, { transfer = it }) {
                when (kind) {
                    SftpOpenKind.TEXT -> {
                        val read = port.read(currentHandle(), entry.path, SftpOpenPolicy.TEXT_EDIT_LIMIT)
                        require(!read.truncated) { "文件超过 ${SftpOpenPolicy.formatBytes(SftpOpenPolicy.TEXT_EDIT_LIMIT)}，拒绝编辑" }
                        require(!FileEncoding.looksBinary(read.bytes)) { "检测到二进制内容，拒绝编辑" }
                        val encoding = FileEncoding.guess(read.bytes)
                        editor = BrowserFile(entry.path, encoding.decode(read.bytes), read, encoding)
                    }
                    SftpOpenKind.IMAGE, SftpOpenKind.MEDIA -> {
                        val read = port.readRange(
                            currentHandle(),
                            entry.path,
                            0L,
                            SftpOpenPolicy.previewLimit(kind).toInt(),
                        )
                        preview = PreviewState(entry.path, kind, read.bytes, entry.sizeBytes)
                    }
                    SftpOpenKind.ARCHIVE -> {
                        dialog = SftpDialog.PromptName(
                            title = "解压到",
                            initial = RemotePath.join(path, RemotePath.nameOf(entry.path).removeSuffix(SshFileKinds.archiveExtensionOf(entry.name)).ifBlank { entry.name + "-out" }),
                            confirm = "解压",
                        ) { target ->
                            scope.launch {
                                runOp(onMessage, { busy = it }, { transfer = it }) {
                                    port.exec(currentHandle(), SshFileKinds.extractCommand(entry.path, target)).requireOk("解压")
                                    onMessage("已解压到 $target")
                                    refresh()
                                }
                            }
                        }
                    }
                    SftpOpenKind.BINARY -> showProperties(currentHandle(), port, listOf(entry)) { dialog = it }
                    SftpOpenKind.DIRECTORY -> Unit
                }
            }
        }
    }

    fun runNamed(title: String, initial: String, confirm: String, block: suspend (String) -> Unit) {
        dialog = SftpDialog.PromptName(title, initial, confirm) { value ->
            scope.launch { runOp(onMessage, { busy = it }, { transfer = it }) { block(value) } }
        }
    }

    fun createFolder() = runNamed("新建文件夹", "new-folder", "创建") { name ->
        require(RemotePath.isValidLeafName(name)) { "名称无效" }
        port.createDirectory(currentHandle(), RemotePath.join(path, name))
        onMessage("已创建文件夹")
        refresh()
    }

    fun createFile() = runNamed("新建文件", "untitled.txt", "创建") { name ->
        require(RemotePath.isValidLeafName(name)) { "名称无效" }
        port.createFile(currentHandle(), RemotePath.join(path, name))
        onMessage("已创建文件")
        refresh()
    }

    fun renameSelected() {
        val entry = selectedEntries().singleOrNull() ?: return
        runNamed("重命名", entry.name, "确定") { name ->
            require(RemotePath.isValidLeafName(name)) { "名称无效" }
            port.rename(currentHandle(), entry.path, RemotePath.join(path, name))
            onMessage("已重命名")
            selected = emptySet()
            selecting = false
            refresh()
        }
    }

    fun deleteSelected() {
        val targets = selectedEntries()
        if (targets.isEmpty()) return
        dialog = SftpDialog.Confirm(
            title = "删除 ${targets.size} 项？",
            body = targets.joinToString("\n") { it.name },
            danger = true,
        ) {
            scope.launch {
                runOp(onMessage, { busy = it }, { transfer = it }) {
                    targets.forEach { entry ->
                        if (entry.isDirectory) {
                            port.exec(currentHandle(), SshFileKinds.recursiveDeleteCommand(entry.path)).requireOk("删除")
                        } else {
                            port.delete(currentHandle(), entry.path, recursive = false)
                        }
                    }
                    onMessage("已删除")
                    selected = emptySet()
                    selecting = false
                    refresh()
                }
            }
        }
    }

    fun copyOrCut(cut: Boolean) {
        val targets = selectedEntries()
        if (targets.isEmpty()) return
        clipboard = SftpClipboard(
            mode = if (cut) SftpClipboardMode.CUT else SftpClipboardMode.COPY,
            paths = targets.map { it.path },
            sourceDirectory = path,
        )
        onMessage(if (cut) "已剪切 ${targets.size} 项" else "已复制 ${targets.size} 项")
    }

    fun pasteClipboard() {
        val clip = clipboard ?: return
        val existing = entries.map { it.name }.toSet()
        val names = clip.paths.map(RemotePath::nameOf)
        if (names.any { it in existing }) {
            dialog = SftpDialog.PasteConflict(names.filter { it in existing })
            return
        }
        applyPaste(
            clip, SftpPasteConflictMode.COMPATIBLE, existing, port, path, currentHandle(),
            onMessage, { busy = it }, { transfer = it },
            {
                if (clip.mode == SftpClipboardMode.CUT) clipboard = null
                refresh()
            },
            scope,
        )
    }

    fun compressSelected() {
        val targets = selectedEntries()
        if (targets.isEmpty()) return
        val defaultName = (if (targets.size == 1) targets.first().name else RemotePath.nameOf(path).ifBlank { "archive" }) + ".tar.gz"
        runNamed("压缩到", RemotePath.join(path, defaultName), "压缩") { target ->
            port.exec(currentHandle(), SshFileKinds.compressCommand(targets.map { it.path }, target)).requireOk("压缩")
            onMessage("已压缩到 $target")
            refresh()
        }
    }

    fun chmodSelected() {
        val entry = selectedEntries().singleOrNull() ?: return
        dialog = SftpDialog.Chmod(entry.path, entry.permissions.ifBlank { "644" })
    }

    fun downloadSelected() {
        val entry = selectedEntries().singleOrNull() ?: return
        if (entry.isDirectory) {
            onMessage("目录请先压缩再下载")
            return
        }
        downloadTarget = entry
        downloadLauncher.launch(entry.name)
    }

    fun showSelectedProperties() {
        val targets = selectedEntries()
        if (targets.isEmpty()) return
        scope.launch {
            runOp(onMessage, { busy = it }, { transfer = it }) {
                showProperties(currentHandle(), port, targets) { dialog = it }
            }
        }
    }

    Box(modifier.fillMaxSize()) {
        when {
            editor != null -> SftpTextEditor(
                file = editor!!,
                onChange = { text, encoding, ending ->
                    editor = editor!!.copy(text = text, encoding = encoding, lineEnding = ending, dirty = true)
                },
                onBack = { if (editor!!.dirty) pendingClose = true else editor = null },
                onSave = {
                    val current = editor ?: return@SftpTextEditor
                    scope.launch {
                        runOp(onMessage, { busy = it }, { transfer = it }) {
                            val normalized = if (current.lineEnding == "crlf") {
                                current.text.replace("\r\n", "\n").replace("\n", "\r\n")
                            } else {
                                current.text.replace("\r\n", "\n")
                            }
                            val bytes = current.encoding.encode(normalized)
                            if (bytes.size > EDIT_WRITE_LIMIT) error("文件超过 2 MiB，拒绝保存")
                            val receipt = runCatching {
                                port.write(
                                    currentHandle(), current.path, bytes,
                                    current.baseline.mtimeMs, current.baseline.sha256, force = false,
                                )
                            }.getOrElse { failure ->
                                if (failure.message?.contains("已变化") == true || failure is one.zephyr.mobile.protocol.ssh.SshRemoteFileConflict) {
                                    dialog = SftpDialog.SaveConflict(current.path)
                                    return@runOp
                                }
                                throw failure
                            }
                            editor = current.copy(
                                baseline = RemoteFileRead(current.path, bytes, receipt.mtimeMs, receipt.sha256),
                                dirty = false,
                            )
                            onMessage("已保存")
                        }
                    }
                },
            )
            preview != null -> SftpPreviewPane(
                preview = preview!!,
                cacheDir = context.cacheDir,
                onBack = { preview = null },
                onMessage = onMessage,
            )
            else -> Column(Modifier.fillMaxSize()) {
                SftpPathBar(
                    path = pathDraft,
                    canGoUp = path != "/" && path != ".",
                    busy = busy || loading,
                    onPathChange = { pathDraft = it },
                    onGo = {
                        path = pathDraft.ifBlank { "/" }
                        refresh()
                    },
                    onUp = { path = parentPath(path); pathDraft = path; refresh() },
                    onRefresh = { refresh() },
                    moreOpen = moreOpen,
                    onToggleMore = { moreOpen = !moreOpen },
                    onHidden = { showHidden = !showHidden; moreOpen = false },
                    hiddenOn = showHidden,
                    sortKey = sortKey,
                    onSort = { sortKey = it; moreOpen = false },
                    onNewFolder = { moreOpen = false; createFolder() },
                    onNewFile = { moreOpen = false; createFile() },
                    onUpload = { moreOpen = false; uploadLauncher.launch("*/*") },
                    canPaste = clipboard != null,
                    onPaste = { moreOpen = false; pasteClipboard() },
                )
                SftpSearchBar(query = query, onQuery = { query = it }, selecting = selecting, selectedCount = selected.size)
                SftpActionBar(
                    selecting = selecting,
                    selectedCount = selected.size,
                    canPaste = clipboard != null,
                    onSelect = { selecting = !selecting; if (!selecting) selected = emptySet() },
                    onCopy = { copyOrCut(false) },
                    onCut = { copyOrCut(true) },
                    onPaste = { pasteClipboard() },
                    onRename = { renameSelected() },
                    onDelete = { deleteSelected() },
                    onCompress = { compressSelected() },
                    onChmod = { chmodSelected() },
                    onDownload = { downloadSelected() },
                    onProperties = { showSelectedProperties() },
                )
                transfer?.let { job ->
                    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)) {
                        Text(job.label, color = ZephyrTheme.palette.onFloatingMuted, fontSize = 11.sp)
                        LinearProgress(progress = job.progress, modifier = Modifier.padding(top = 4.dp))
                        Text(job.detail, color = ZephyrTheme.palette.onFloatingSubtle, fontSize = 10.sp)
                    }
                }
                when {
                    loading -> SftpEmpty("正在连接并读取 $path…")
                    error != null -> SftpError(error!!, onRetry = { refresh() })
                    visible.isEmpty() -> SftpEmpty(if (query.isNotBlank()) "没有匹配 $query 的项目" else "$path · 空目录")
                    else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                        items(visible, key = { it.path }) { entry ->
                            SftpEntryRow(
                                entry = entry,
                                selected = entry.path in selected,
                                selecting = selecting,
                                onClick = { openEntry(entry) },
                                onLongClick = {
                                    selecting = true
                                    selected = selected + entry.path
                                },
                            )
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

        when (val current = dialog) {
            is SftpDialog.PromptName -> NamePromptDialog(
                title = current.title,
                initial = current.initial,
                confirm = current.confirm,
                onDismiss = { dialog = null },
                onConfirm = { dialog = null; current.onConfirm(it) },
            )
            is SftpDialog.Confirm -> AlertDialog(
                onDismissRequest = { dialog = null },
                title = { Text(current.title) },
                text = { Text(current.body) },
                confirmButton = {
                    TextButton(onClick = { dialog = null; current.onConfirm() }) {
                        Text(if (current.danger) "删除" else "确定")
                    }
                },
                dismissButton = { TextButton(onClick = { dialog = null }) { Text("取消") } },
            )
            is SftpDialog.Properties -> AlertDialog(
                onDismissRequest = { dialog = null },
                title = { Text(current.title) },
                text = {
                    Column {
                        current.lines.forEach { (label, value) ->
                            Text("$label  $value", fontFamily = FontFamily.Monospace, fontSize = 12.sp)
                        }
                    }
                },
                confirmButton = { TextButton(onClick = { dialog = null }) { Text("关闭") } },
            )
            is SftpDialog.Chmod -> NamePromptDialog(
                title = "权限（八进制）",
                initial = current.initial,
                confirm = "应用",
                onDismiss = { dialog = null },
                onConfirm = { mode ->
                    dialog = null
                    scope.launch {
                        runOp(onMessage, { busy = it }, { transfer = it }) {
                            port.chmod(currentHandle(), current.path, SshFileKinds.decodeOctalMode(mode))
                            onMessage("已修改权限")
                            refresh()
                        }
                    }
                },
            )
            is SftpDialog.PasteConflict -> {
                val clip = clipboard
                AlertDialog(
                    onDismissRequest = { dialog = null },
                    title = { Text("目标已存在同名项目") },
                    text = { Text(current.names.joinToString("\n") + "\n\n覆盖 / 跳过 / 自动改名（兼容）") },
                    confirmButton = {
                        Column {
                            TextButton(onClick = {
                                dialog = null
                                if (clip != null) applyPaste(
                                    clip, SftpPasteConflictMode.OVERWRITE, entries.map { it.name }.toSet(),
                                    port, path, currentHandle(), onMessage, { busy = it }, { transfer = it },
                                    { if (clip.mode == SftpClipboardMode.CUT) clipboard = null; refresh() }, scope,
                                )
                            }) { Text("覆盖") }
                            TextButton(onClick = {
                                dialog = null
                                if (clip != null) applyPaste(
                                    clip, SftpPasteConflictMode.SKIP, entries.map { it.name }.toSet(),
                                    port, path, currentHandle(), onMessage, { busy = it }, { transfer = it },
                                    { if (clip.mode == SftpClipboardMode.CUT) clipboard = null; refresh() }, scope,
                                )
                            }) { Text("跳过") }
                            TextButton(onClick = {
                                dialog = null
                                if (clip != null) applyPaste(
                                    clip, SftpPasteConflictMode.COMPATIBLE, entries.map { it.name }.toSet(),
                                    port, path, currentHandle(), onMessage, { busy = it }, { transfer = it },
                                    { if (clip.mode == SftpClipboardMode.CUT) clipboard = null; refresh() }, scope,
                                )
                            }) { Text("兼容") }
                        }
                    },
                    dismissButton = { TextButton(onClick = { dialog = null }) { Text("取消") } },
                )
            }
            is SftpDialog.SaveConflict -> AlertDialog(
                onDismissRequest = { dialog = null },
                title = { Text("远端文件已变化") },
                text = { Text("保存会覆盖其他人刚写入的内容。") },
                confirmButton = {
                    TextButton(onClick = {
                        dialog = null
                        val currentFile = editor ?: return@TextButton
                        scope.launch {
                            runOp(onMessage, { busy = it }, { transfer = it }) {
                                val bytes = currentFile.encoding.encode(currentFile.text)
                                val receipt = port.write(currentHandle(), currentFile.path, bytes, null, null, force = true)
                                editor = currentFile.copy(
                                    baseline = RemoteFileRead(currentFile.path, bytes, receipt.mtimeMs, receipt.sha256),
                                    dirty = false,
                                )
                                onMessage("已强制覆盖保存")
                            }
                        }
                    }) { Text("覆盖远端") }
                },
                dismissButton = { TextButton(onClick = { dialog = null }) { Text("继续编辑") } },
            )
            null -> Unit
        }
    }
}

private suspend fun showProperties(
    handle: SftpSessionHandle,
    port: SftpPort,
    targets: List<RemoteEntry>,
    show: (SftpDialog) -> Unit,
) {
    val lines = ArrayList<Pair<String, String>>()
    var totalSize = 0L
    var files = 0
    var dirs = 0
    for (entry in targets) {
        val tree = runCatching {
            val raw = port.exec(handle, SshFileKinds.treePropertiesCommand(entry.path)).requireOk("属性")
            SshFileKinds.parseTreeProperties(raw)
        }.getOrNull()
        if (tree != null) {
            totalSize += tree.sizeBytes
            files += tree.fileCount
            dirs += tree.dirCount
            if (targets.size == 1) {
                lines += "名称" to entry.name
                lines += "路径" to entry.path
                lines += "类型" to when {
                    entry.isDirectory -> "目录"
                    entry.isSymlink -> "符号链接"
                    else -> "文件"
                }
                lines += "大小" to SftpOpenPolicy.formatBytes(tree.sizeBytes)
                lines += "文件" to tree.fileCount.toString()
                lines += "目录" to tree.dirCount.toString()
                lines += "修改" to SftpOpenPolicy.formatTime((if (tree.mtimeSec > 0) tree.mtimeSec * 1000L else entry.mtimeMs))
                if (entry.permissions.isNotBlank()) lines += "权限" to entry.permissions
            }
        } else if (targets.size == 1) {
            lines += "名称" to entry.name
            lines += "路径" to entry.path
            lines += "大小" to SftpOpenPolicy.formatBytes(entry.sizeBytes)
            lines += "修改" to SftpOpenPolicy.formatTime(entry.mtimeMs)
        }
    }
    if (targets.size > 1) {
        lines += "项目" to targets.size.toString()
        lines += "合计大小" to SftpOpenPolicy.formatBytes(totalSize)
        lines += "文件" to files.toString()
        lines += "目录" to dirs.toString()
    }
    show(SftpDialog.Properties(if (targets.size == 1) "属性 · ${targets.first().name}" else "属性 · ${targets.size} 项", lines))
}

@Composable
private fun SftpPathBar(
    path: String,
    canGoUp: Boolean,
    busy: Boolean,
    onPathChange: (String) -> Unit,
    onGo: () -> Unit,
    onUp: () -> Unit,
    onRefresh: () -> Unit,
    moreOpen: Boolean,
    onToggleMore: () -> Unit,
    onHidden: () -> Unit,
    hiddenOn: Boolean,
    sortKey: FileSortKey,
    onSort: (FileSortKey) -> Unit,
    onNewFolder: () -> Unit,
    onNewFile: () -> Unit,
    onUpload: () -> Unit,
    canPaste: Boolean,
    onPaste: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().background(ZephyrTheme.palette.surfaces.content)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            IconButton(onClick = onUp, enabled = canGoUp && !busy) { Icon(ZephyrIcons.Back, "返回上一级") }
            BasicTextField(
                value = path,
                onValueChange = onPathChange,
                singleLine = true,
                textStyle = androidx.compose.ui.text.TextStyle(
                    color = ZephyrTheme.palette.onFloating,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                ),
                modifier = Modifier
                    .weight(1f)
                    .clip(androidx.compose.foundation.shape.RoundedCornerShape(8.dp))
                    .background(ZephyrTheme.palette.surfaces.elevated)
                    .padding(horizontal = 8.dp, vertical = 7.dp),
            )
            TextButton(onClick = onGo, enabled = !busy) { Text("跳转") }
            IconButton(onClick = onRefresh, enabled = !busy) { Icon(ZephyrIcons.Refresh, "刷新") }
            Box {
                IconButton(onClick = onToggleMore) { Icon(ZephyrIcons.More, "更多") }
                DropdownMenu(expanded = moreOpen, onDismissRequest = onToggleMore) {
                    DropdownMenuItem({ Text("新建文件夹") }, onNewFolder)
                    DropdownMenuItem({ Text("新建文件") }, onNewFile)
                    DropdownMenuItem({ Text("上传文件") }, onUpload)
                    DropdownMenuItem({ Text("粘贴") }, onPaste, enabled = canPaste)
                    DropdownMenuItem({ Text(if (hiddenOn) "隐藏点文件" else "显示点文件") }, onHidden)
                    DropdownMenuItem({ Text("按名称排序") }, { onSort(FileSortKey.NAME) })
                    DropdownMenuItem({ Text("按大小排序") }, { onSort(FileSortKey.SIZE) })
                    DropdownMenuItem({ Text("按时间排序") }, { onSort(FileSortKey.MTIME) })
                    @Suppress("UNUSED_VARIABLE")
                    val keepSort = sortKey
                }
            }
        }
    }
}

@Composable
private fun SftpSearchBar(query: String, onQuery: (String) -> Unit, selecting: Boolean, selectedCount: Int) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OutlinedTextField(
            value = query,
            onValueChange = onQuery,
            modifier = Modifier.weight(1f),
            singleLine = true,
            placeholder = { Text("搜索当前目录…", color = ZephyrTheme.palette.onFloatingSubtle) },
        )
        if (selecting) {
            Text("已选 $selectedCount", color = ZephyrTheme.palette.brand.accent, fontSize = 11.sp, modifier = Modifier.padding(start = 8.dp))
        }
    }
}

@Composable
private fun SftpActionBar(
    selecting: Boolean,
    selectedCount: Int,
    canPaste: Boolean,
    onSelect: () -> Unit,
    onCopy: () -> Unit,
    onCut: () -> Unit,
    onPaste: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
    onCompress: () -> Unit,
    onChmod: () -> Unit,
    onDownload: () -> Unit,
    onProperties: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        MiniChip(if (selecting) "取消选择" else "选择", onSelect)
        if (selectedCount > 0) {
            MiniChip("复制", onCopy)
            MiniChip("剪切", onCut)
            MiniChip("重命名", onRename, enabled = selectedCount == 1)
            MiniChip("删除", onDelete)
            MiniChip("压缩", onCompress)
            MiniChip("权限", onChmod, enabled = selectedCount == 1)
            MiniChip("下载", onDownload, enabled = selectedCount == 1)
            MiniChip("属性", onProperties)
        }
        MiniChip("粘贴", onPaste, enabled = canPaste)
    }
}

@Composable
private fun MiniChip(label: String, onClick: () -> Unit, enabled: Boolean = true) {
    AssistChip(onClick = onClick, enabled = enabled, label = { Text(label, fontSize = 11.sp) })
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SftpEntryRow(
    entry: RemoteEntry,
    selected: Boolean,
    selecting: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    val kind = SftpOpenPolicy.kindOf(entry)
    val icon = when (kind) {
        SftpOpenKind.DIRECTORY -> ZephyrIcons.File
        SftpOpenKind.IMAGE -> ZephyrIcons.Camera
        SftpOpenKind.MEDIA -> ZephyrIcons.Volume
        SftpOpenKind.ARCHIVE -> ZephyrIcons.Inbox
        SftpOpenKind.TEXT -> ZephyrIcons.Notes
        SftpOpenKind.BINARY -> ZephyrIcons.File
    }
    val tint = when {
        selected -> ZephyrTheme.palette.brand.accent
        kind == SftpOpenKind.DIRECTORY -> ZephyrTheme.palette.protocol.sftp
        else -> ZephyrTheme.palette.onFloatingMuted
    }
    val meta = buildString {
        append(if (entry.isDirectory) "目录" else SftpOpenPolicy.formatBytes(entry.sizeBytes))
        if (entry.permissions.isNotBlank()) append(" · ").append(entry.permissions)
        val time = SftpOpenPolicy.formatTime(entry.mtimeMs)
        if (time != "—") append(" · ").append(time)
    }
    Row(
        Modifier
            .fillMaxWidth()
            .background(if (selected) ZephyrTheme.palette.brand.accent.copy(alpha = 0.12f) else Color.Transparent)
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(20.dp))
        Column(Modifier.weight(1f)) {
            Text(entry.name, color = ZephyrTheme.palette.onFloating, maxLines = 1, fontWeight = FontWeight.Medium)
            Text(meta, color = ZephyrTheme.palette.onFloatingSubtle, fontSize = 11.sp, maxLines = 1)
        }
        Text(if (selecting && selected) "✓" else "›", color = ZephyrTheme.palette.onFloatingSubtle, fontSize = 18.sp)
    }
}

@Composable
private fun SftpTextEditor(
    file: BrowserFile,
    onChange: (String, FileEncoding, String) -> Unit,
    onBack: () -> Unit,
    onSave: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().background(ZephyrTheme.palette.surfaces.content).padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            IconButton(onClick = onBack) { Icon(ZephyrIcons.Back, "返回文件列表") }
            Column(Modifier.weight(1f)) {
                Text(file.path.substringAfterLast('/'), color = ZephyrTheme.palette.onFloating, fontWeight = FontWeight.SemiBold)
                Text(if (file.dirty) "未保存" else file.path, color = ZephyrTheme.palette.onFloatingSubtle, fontSize = 10.sp, maxLines = 1)
            }
            PrimaryButton(onClick = onSave, enabled = file.dirty) { Text("保存") }
        }
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FileEncoding.entries.forEach { encoding ->
                FilterChip(
                    selected = file.encoding == encoding,
                    onClick = { onChange(encoding.decode(file.baseline.bytes), encoding, file.lineEnding) },
                    enabled = encoding.isAvailable,
                    label = { Text(encoding.label, fontSize = 11.sp) },
                )
            }
            FilterChip(
                selected = file.lineEnding == "lf",
                onClick = { onChange(file.text, file.encoding, "lf") },
                label = { Text("LF", fontSize = 11.sp) },
            )
            FilterChip(
                selected = file.lineEnding == "crlf",
                onClick = { onChange(file.text, file.encoding, "crlf") },
                label = { Text("CRLF", fontSize = 11.sp) },
            )
        }
        BasicTextField(
            value = file.text,
            onValueChange = { onChange(it, file.encoding, file.lineEnding) },
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
private fun SftpPreviewPane(
    preview: PreviewState,
    cacheDir: File,
    onBack: () -> Unit,
    onMessage: (String) -> Unit,
) {
    Column(Modifier.fillMaxSize().background(ZephyrTheme.palette.surfaces.background)) {
        Row(
            Modifier.fillMaxWidth().background(ZephyrTheme.palette.surfaces.content).padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) { Icon(ZephyrIcons.Back, "关闭预览") }
            Column(Modifier.weight(1f)) {
                Text(preview.path.substringAfterLast('/'), color = ZephyrTheme.palette.onFloating, fontWeight = FontWeight.SemiBold)
                Text(
                    "${if (preview.kind == SftpOpenKind.IMAGE) "图片预览" else "媒体预览"} · ${SftpOpenPolicy.formatBytes(preview.sizeBytes)}",
                    color = ZephyrTheme.palette.onFloatingSubtle,
                    fontSize = 10.sp,
                )
            }
        }
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            when (preview.kind) {
                SftpOpenKind.IMAGE -> {
                    val bitmap = remember(preview.bytes) {
                        runCatching { BitmapFactory.decodeByteArray(preview.bytes, 0, preview.bytes.size) }.getOrNull()
                    }
                    if (bitmap != null) {
                        Image(
                            bitmap = bitmap.asImageBitmap(),
                            contentDescription = preview.path,
                            modifier = Modifier.fillMaxSize().padding(12.dp),
                            contentScale = ContentScale.Fit,
                        )
                    } else {
                        Text("无法解码该图片格式，请下载后用系统应用打开", color = ZephyrTheme.palette.onFloatingSubtle)
                    }
                }
                SftpOpenKind.MEDIA -> {
                    val mediaFile = remember(preview.path, preview.bytes) {
                        val ext = SshFileKinds.extensionOf(preview.path).ifBlank { "bin" }
                        File(cacheDir, "sftp-preview-${preview.path.hashCode()}.$ext").apply {
                            writeBytes(preview.bytes)
                        }
                    }
                    DisposableEffect(mediaFile) { onDispose { mediaFile.delete() } }
                    if (SshFileKinds.isVideo(preview.path)) {
                        AndroidView(
                            factory = { context ->
                                VideoView(context).apply {
                                    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                                    setVideoURI(Uri.fromFile(mediaFile))
                                    setOnErrorListener { _, _, _ ->
                                        onMessage("该视频编码当前设备无法播放")
                                        true
                                    }
                                    setOnPreparedListener { it.isLooping = false; start() }
                                }
                            },
                            modifier = Modifier.fillMaxSize(),
                        )
                    } else {
                        val player = remember {
                            MediaPlayer().apply {
                                setDataSource(mediaFile.absolutePath)
                                setOnErrorListener { _, _, _ ->
                                    onMessage("该音频编码当前设备无法播放")
                                    true
                                }
                                prepare()
                                start()
                            }
                        }
                        DisposableEffect(player) { onDispose { player.release() } }
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(ZephyrIcons.Volume, null, tint = ZephyrTheme.palette.brand.accent, modifier = Modifier.size(48.dp))
                            Text("正在播放 ${preview.path.substringAfterLast('/')}", color = ZephyrTheme.palette.onFloating, modifier = Modifier.padding(top = 12.dp))
                        }
                    }
                }
                else -> Text("不支持预览", color = ZephyrTheme.palette.onFloatingSubtle)
            }
        }
    }
}

@Composable
private fun NamePromptDialog(
    title: String,
    initial: String,
    confirm: String,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var value by remember(initial) { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(value = value, onValueChange = { value = it }, singleLine = true)
        },
        confirmButton = { TextButton(onClick = { onConfirm(value.trim()) }, enabled = value.isNotBlank()) { Text(confirm) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
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

private fun queryDisplayName(context: android.content.Context, uri: Uri): String? {
    val cursor = context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)
    return cursor?.use {
        if (it.moveToFirst()) it.getString(0) else null
    }
}

private suspend fun runOp(
    onMessage: (String) -> Unit,
    setBusy: (Boolean) -> Unit,
    setTransfer: (TransferJob?) -> Unit,
    block: suspend () -> Unit,
) {
    setBusy(true)
    try {
        block()
    } catch (error: Throwable) {
        onMessage(error.displayMessage())
    } finally {
        setBusy(false)
        setTransfer(null)
    }
}

private fun applyPaste(
    clip: SftpClipboard,
    mode: SftpPasteConflictMode,
    existing: Set<String>,
    port: SftpPort,
    directory: String,
    handle: SftpSessionHandle,
    onMessage: (String) -> Unit,
    setBusy: (Boolean) -> Unit,
    setTransfer: (TransferJob?) -> Unit,
    onDone: () -> Unit,
    scope: kotlinx.coroutines.CoroutineScope,
) {
    scope.launch {
        runOp(onMessage, setBusy, setTransfer) {
            val plan = SftpClipboardOps.planPaste(clip, directory, existing, mode)
            val command = SftpClipboardOps.commandFor(plan, cut = clip.mode == SftpClipboardMode.CUT)
                ?: error("没有可粘贴的项目")
            port.exec(handle, command).requireOk("粘贴")
            onMessage("已粘贴 ${plan.copies.size} 项")
            onDone()
        }
    }
}
