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
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import one.zephyr.mobile.model.MobileApiException
import one.zephyr.mobile.protocol.ssh.SshFileKinds
import one.zephyr.mobile.ui.component.*
import one.zephyr.mobile.ui.icon.ZephyrIcons
import one.zephyr.mobile.ui.theme.ZephyrTheme
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

private data class BrowserFile(
    val path: String,
    val text: String,
    val baseline: RemoteFileRead,
    val encoding: FileEncoding = FileEncoding.UTF8,
    val lineEnding: String = if (text.contains("\r\n")) "crlf" else "lf",
    val tabSize: Int = 4,
    val wrap: Boolean = true,
    val dirty: Boolean = false,
    val generation: Int = 0,
) {
    val title: String get() = path.substringAfterLast('/').ifBlank { path }
}

private data class PreviewState(
    val path: String,
    val kind: SftpOpenKind,
    val bytes: ByteArray,
    val sizeBytes: Long,
    val cacheFile: File? = null,
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
    connectionName: String = "",
    clipboard: SftpClipboard? = null,
    onClipboard: (SftpClipboard?) -> Unit = {},
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
    var editors by remember { mutableStateOf<List<BrowserFile>>(emptyList()) }
    var editorIndex by remember { mutableIntStateOf(0) }
    val editor = editors.getOrNull(editorIndex)
    val histories = remember(connectionId) { mutableMapOf<String, SftpEditorHistory>() }
    var preview by remember { mutableStateOf<PreviewState?>(null) }
    var pendingClose by remember { mutableStateOf(false) }
    var dialog by remember { mutableStateOf<SftpDialog?>(null) }
    var localClipboard by remember { mutableStateOf(clipboard) }
    LaunchedEffect(clipboard) { localClipboard = clipboard }
    var connecting by remember { mutableStateOf(false) }
    var transfers by remember { mutableStateOf<List<SftpTransferOps.Transfer>>(emptyList()) }
    var transfer by remember { mutableStateOf<TransferJob?>(null) }
    var busy by remember { mutableStateOf(false) }
    var moreOpen by remember { mutableStateOf(false) }
    var bundleTarget by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(editors.any { it.dirty }) { onDirtyChanged(editors.any { it.dirty }) }

    fun currentHandle(): SftpSessionHandle = handle ?: error("SFTP 会话已断开")

    fun setClip(value: SftpClipboard?) {
        localClipboard = value
        onClipboard(value)
    }

    fun refresh() {
        revision++
    }

    fun reconnect() {
        val old = handle
        handle = null
        if (old != null) {
            scope.launch { runCatching { port.close(old) } }
        }
        revision++
    }

    fun upsertEditor(file: BrowserFile) {
        val existing = editors.indexOfFirst { it.path == file.path }
        editors = if (existing >= 0) editors.toMutableList().also { it[existing] = file } else editors + file
        editorIndex = if (existing >= 0) existing else editors.lastIndex
    }

    fun updateActive(transform: (BrowserFile) -> BrowserFile) {
        val current = editor ?: return
        upsertEditor(transform(current))
    }

    fun closeEditor(force: Boolean, index: Int = editorIndex) {
        val target = editors.getOrNull(index) ?: return
        if (target.dirty && !force) {
            editorIndex = index
            pendingClose = true
            return
        }
        val next = editors.toMutableList().also { it.removeAt(index) }
        histories.remove(target.path)
        editors = next
        editorIndex = editorIndex.coerceAtMost((next.size - 1).coerceAtLeast(0))
    }

    val overlayOpen = editors.isNotEmpty() || preview != null
    BackHandler(enabled = overlayOpen || selecting) {
        when {
            editor?.dirty == true -> pendingClose = true
            editors.isNotEmpty() -> closeEditor(force = false)
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

    fun pushTransfer(job: SftpTransferOps.Transfer) {
        transfers = listOf(job) + transfers.filterNot { it.id == job.id }.take(7)
        transfer = TransferJob(job.label, job.fraction, job.detail.ifBlank { SftpOpenPolicy.formatBytes(job.loaded) })
    }

    val uploadLauncher = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            runOp(onMessage, { busy = it }, { transfer = it }) {
                val active = currentHandle()
                uris.forEachIndexed { index, uri ->
                    val name = queryDisplayName(context, uri) ?: "upload-${index + 1}"
                    val remote = RemotePath.join(path, name)
                    val total = querySize(context, uri)
                    val id = "up-$name-${System.currentTimeMillis()}"
                    pushTransfer(SftpTransferOps.Transfer(id, "上传 $name", SftpTransferOps.Direction.UPLOAD, remote, total = total, detail = "${index + 1}/${uris.size}"))
                    context.contentResolver.openInputStream(uri)?.use { input ->
                        val buffer = ByteArray(SftpTransferOps.STREAM_CHUNK)
                        var loaded = 0L
                        port.writeStream(active, remote) {
                            val read = input.read(buffer)
                            if (read <= 0) null else {
                                loaded += read
                                pushTransfer(
                                    SftpTransferOps.Transfer(
                                        id, "上传 $name", SftpTransferOps.Direction.UPLOAD, remote,
                                        loaded = loaded, total = total,
                                        detail = SftpOpenPolicy.formatBytes(loaded),
                                    ),
                                )
                                buffer.copyOf(read)
                            }
                        }
                    } ?: error("无法读取 $name")
                    pushTransfer(
                        SftpTransferOps.Transfer(
                            id, "上传 $name", SftpTransferOps.Direction.UPLOAD, remote,
                            loaded = total, total = total,
                            status = SftpTransferOps.Status.DONE, detail = "完成",
                        ),
                    )
                }
                onMessage("已上传 ${uris.size} 个文件")
                refresh()
            }
        }
    }
    var downloadTarget by remember { mutableStateOf<RemoteEntry?>(null) }
    val downloadLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
        val entry = downloadTarget
        val bundle = bundleTarget
        downloadTarget = null
        bundleTarget = null
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            runOp(onMessage, { busy = it }, { transfer = it }) {
                val active = currentHandle()
                if (bundle != null) {
                    streamDownload(port, active, bundle, uri, context, "打包下载", { pushTransfer(it) })
                    runCatching { port.exec(active, SftpTransferOps.cleanupCommand(bundle)) }
                    onMessage("已打包下载")
                    return@runOp
                }
                val target = entry ?: return@runOp
                streamDownload(port, active, target.path, uri, context, target.name, { pushTransfer(it) }, target.sizeBytes)
                onMessage("已下载 ${target.name}")
            }
        }
    }

    LaunchedEffect(connectionId, revision) {
        loading = true
        error = null
        connecting = handle == null
        runCatching {
            val active = handle ?: port.open(connectionId).also {
                handle = it
                path = runCatching { port.canonicalPath(it, ".") }.getOrDefault("/")
                pathDraft = path
            }
            connecting = false
            val listed = port.list(active, path)
            path = runCatching { port.canonicalPath(active, path) }.getOrDefault(path)
            pathDraft = path
            entries = listed.sortedWith(compareByDescending<RemoteEntry> { it.isDirectory }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
            selected = selected.intersect(listed.map { it.path }.toSet())
        }.onFailure {
            connecting = false
            error = if (handle == null) {
                "无法自动连接${if (connectionName.isBlank()) "" else " $connectionName"}：${it.displayMessage()}"
            } else {
                it.displayMessage()
            }
        }
        loading = false
        connecting = false
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
                        val existing = editors.indexOfFirst { it.path == entry.path }
                        if (existing >= 0) {
                            editorIndex = existing
                            return@runOp
                        }
                        val read = port.read(currentHandle(), entry.path, SftpOpenPolicy.TEXT_EDIT_LIMIT)
                        require(!read.truncated) { "文件超过 ${SftpOpenPolicy.formatBytes(SftpOpenPolicy.TEXT_EDIT_LIMIT)}，拒绝编辑" }
                        require(!FileEncoding.looksBinary(read.bytes)) { "检测到二进制内容，拒绝编辑" }
                        val encoding = FileEncoding.guess(read.bytes)
                        upsertEditor(BrowserFile(entry.path, encoding.decode(read.bytes), read, encoding))
                    }
                    SftpOpenKind.IMAGE -> {
                        val read = port.readRange(
                            currentHandle(),
                            entry.path,
                            0L,
                            SftpOpenPolicy.IMAGE_PREVIEW_LIMIT.toInt(),
                        )
                        preview = PreviewState(entry.path, kind, read.bytes, entry.sizeBytes)
                    }
                    SftpOpenKind.MEDIA -> {
                        val cache = File(context.cacheDir, "sftp-preview-${entry.path.hashCode()}.${SshFileKinds.extensionOf(entry.path).ifBlank { "bin" }}")
                        cache.outputStream().use { output ->
                            port.readStream(currentHandle(), entry.path, 0L) { _, bytes, _ ->
                                output.write(bytes)
                            }
                        }
                        preview = PreviewState(entry.path, kind, ByteArray(0), entry.sizeBytes, cacheFile = cache)
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
        setClip(
            SftpClipboard(
                mode = if (cut) SftpClipboardMode.CUT else SftpClipboardMode.COPY,
                paths = targets.map { it.path },
                sourceDirectory = path,
                sourceConnectionId = connectionId,
            ),
        )
        onMessage(if (cut) "已剪切 ${targets.size} 项" else "已复制 ${targets.size} 项")
    }

    fun pasteClipboard() {
        val clip = localClipboard ?: return
        val existing = entries.map { it.name }.toSet()
        val names = clip.paths.map(RemotePath::nameOf)
        if (names.any { it in existing }) {
            dialog = SftpDialog.PasteConflict(names.filter { it in existing })
            return
        }
        applyPaste(
            clip, SftpPasteConflictMode.COMPATIBLE, existing, port, path, currentHandle(), connectionId,
            onMessage, { busy = it }, { transfer = it },
            {
                if (clip.mode == SftpClipboardMode.CUT) setClip(null)
                refresh()
            },
            scope,
        )
    }

    fun openSelected() {
        val targets = selectedEntries().filter { !it.isDirectory }
        if (targets.isEmpty()) {
            onMessage("请先勾选要打开的文件")
            return
        }
        selecting = false
        selected = emptySet()
        scope.launch {
            runOp(onMessage, { busy = it }, { transfer = it }) {
                var opened = 0
                targets.forEach { entry ->
                    val kind = SftpOpenPolicy.kindOf(entry)
                    if (kind != SftpOpenKind.TEXT) return@forEach
                    SftpOpenPolicy.rejectReason(kind, entry.sizeBytes)?.let { return@forEach }
                    if (editors.any { it.path == entry.path }) {
                        opened += 1
                        return@forEach
                    }
                    val read = port.read(currentHandle(), entry.path, SftpOpenPolicy.TEXT_EDIT_LIMIT)
                    if (read.truncated || FileEncoding.looksBinary(read.bytes)) return@forEach
                    val encoding = FileEncoding.guess(read.bytes)
                    upsertEditor(BrowserFile(entry.path, encoding.decode(read.bytes), read, encoding))
                    opened += 1
                }
                if (opened == 0) error("没有可同时打开的文本文件")
                onMessage("已打开 $opened 个文件")
            }
        }
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
        val targets = selectedEntries()
        if (targets.isEmpty()) return
        if (targets.size == 1 && !targets.first().isDirectory) {
            downloadTarget = targets.first()
            downloadLauncher.launch(targets.first().name)
            return
        }
        scope.launch {
            runOp(onMessage, { busy = it }, { transfer = it }) {
                val name = SftpTransferOps.bundleName()
                val remote = SftpTransferOps.remoteTempPath(name)
                val id = "bundle-$name"
                pushTransfer(SftpTransferOps.Transfer(id, "打包 $name", SftpTransferOps.Direction.ARCHIVE, remote, detail = "压缩中"))
                port.exec(currentHandle(), SftpTransferOps.bundleCommand(targets.map { it.path }, remote)).requireOk("打包")
                bundleTarget = remote
                downloadLauncher.launch(name)
            }
        }
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
                files = editors,
                activeIndex = editorIndex,
                onSelect = { editorIndex = it },
                onCloseTab = { closeEditor(force = false, index = it) },
                onChange = { text, encoding, ending, tabSize, wrap ->
                    updateActive { current ->
                        val sameText = current.text == text
                        val sameMeta = current.encoding == encoding &&
                            current.lineEnding == ending &&
                            current.tabSize == tabSize &&
                            current.wrap == wrap
                        if (sameText && sameMeta) return@updateActive current
                        val history = histories.getOrPut(current.path) { SftpEditorHistory() }
                        history.record(current.text, text)
                        current.copy(
                            text = text,
                            encoding = encoding,
                            lineEnding = ending,
                            tabSize = tabSize,
                            wrap = wrap,
                            dirty = true,
                            generation = if (sameText) current.generation else current.generation + 1,
                        )
                    }
                },
                onUndo = { latest ->
                    updateActive { current ->
                        val previous = histories[current.path]?.undo(latest) ?: return@updateActive current
                        current.copy(text = previous, dirty = true, generation = current.generation + 1)
                    }
                },
                onRedo = { latest ->
                    updateActive { current ->
                        val next = histories[current.path]?.redo(latest) ?: return@updateActive current
                        current.copy(text = next, dirty = true, generation = current.generation + 1)
                    }
                },
                onFormat = { latest ->
                    updateActive { current ->
                        val formatted = SftpEditorSupport.formatDocument(latest, current.tabSize)
                        histories.getOrPut(current.path) { SftpEditorHistory() }.record(latest, formatted)
                        current.copy(text = formatted, dirty = true, generation = current.generation + 1)
                    }
                },
                onBack = { closeEditor(force = false) },
                onSave = { latest ->
                    val current = (editor ?: return@SftpTextEditor).copy(text = latest)
                    scope.launch {
                        runOp(onMessage, { busy = it }, { transfer = it }) {
                            val normalized = if (current.lineEnding == "crlf") {
                                current.text.replace("\r\n", "\n").replace("\n", "\r\n")
                            } else {
                                current.text.replace("\r\n", "\n")
                            }
                            val bytes = current.encoding.encode(normalized)
                            if (bytes.size > SftpOpenPolicy.TEXT_EDIT_LIMIT) {
                                error("文件超过 ${SftpOpenPolicy.formatBytes(SftpOpenPolicy.TEXT_EDIT_LIMIT)}，拒绝保存")
                            }
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
                            histories[current.path]?.clear()
                            upsertEditor(
                                current.copy(
                                    baseline = RemoteFileRead(current.path, bytes, receipt.mtimeMs, receipt.sha256),
                                    dirty = false,
                                    generation = current.generation + 1,
                                ),
                            )
                            onMessage("已保存")
                        }
                    }
                },
                onWorkspaceSearch = { query ->
                    scope.launch {
                        runOp(onMessage, { busy = it }, { transfer = it }) {
                            val raw = port.exec(currentHandle(), SftpEditorSupport.workspaceSearchCommand(path, query)).requireOk("搜目录")
                            val (hits, scanned) = SftpEditorSupport.parseWorkspaceHits(raw)
                            dialog = SftpDialog.Properties(
                                "搜目录 · $query · $scanned 个文件",
                                hits.take(80).map { "${it.path}:${it.line}" to it.text },
                            )
                        }
                    }
                },
                onOpenHit = { pathToOpen ->
                    val name = RemotePath.nameOf(pathToOpen)
                    openEntry(RemoteEntry(name, pathToOpen, false, 0L, 0L))
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
                    canPaste = localClipboard != null,
                    onPaste = { moreOpen = false; pasteClipboard() },
                )
                SftpSearchBar(query = query, onQuery = { query = it }, selecting = selecting, selectedCount = selected.size)
                SftpActionBar(
                    selecting = selecting,
                    selectedCount = selected.size,
                    canPaste = localClipboard != null,
                    onSelect = { selecting = !selecting; if (!selecting) selected = emptySet() },
                    onOpen = { openSelected() },
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
                if (transfers.isNotEmpty()) {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)) {
                        Text("传输", color = ZephyrTheme.palette.onFloatingSubtle, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                        transfers.take(5).forEach { job ->
                            Text(job.label, color = ZephyrTheme.palette.onFloatingMuted, fontSize = 11.sp, modifier = Modifier.padding(top = 6.dp))
                            LinearProgress(progress = job.fraction, modifier = Modifier.padding(top = 4.dp))
                            Text(
                                (if (job.detail.isNotBlank()) job.detail + " · " else "") + job.status.name.lowercase(),
                                color = ZephyrTheme.palette.onFloatingSubtle,
                                fontSize = 10.sp,
                            )
                        }
                    }
                } else {
                    transfer?.let { job ->
                        Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)) {
                            Text(job.label, color = ZephyrTheme.palette.onFloatingMuted, fontSize = 11.sp)
                            LinearProgress(progress = job.progress, modifier = Modifier.padding(top = 4.dp))
                            Text(job.detail, color = ZephyrTheme.palette.onFloatingSubtle, fontSize = 10.sp)
                        }
                    }
                }
                when {
                    connecting || (loading && handle == null) ->
                        SftpEmpty("正在自动连接${if (connectionName.isBlank()) "" else " $connectionName"}…")
                    loading -> SftpEmpty("正在读取 $path…")
                    error != null -> SftpError(error!!, onRetry = { reconnect() })
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
                confirmButton = { TextButton(onClick = { pendingClose = false; closeEditor(force = true) }) { Text("放弃") } },
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
                    // AlertDialog owns the sole bounded verticalScroll. Nesting another scrollable
                    // Column here makes Compose measure it with infinite height and crash.
                    Column {
                        current.lines.forEach { (label, value) ->
                            val jump = label.contains(':') && label.startsWith("/")
                            Text(
                                "$label  $value",
                                fontFamily = FontFamily.Monospace,
                                fontSize = 12.sp,
                                color = if (jump) ZephyrTheme.palette.brand.accent else ZephyrTheme.palette.onFloating,
                                modifier = if (jump) Modifier.clickable {
                                    dialog = null
                                    val pathToOpen = label.substringBefore(':')
                                    openEntry(RemoteEntry(RemotePath.nameOf(pathToOpen), pathToOpen, false, 0L, 0L))
                                } else Modifier,
                            )
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
                val clip = localClipboard
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
                                    port, path, currentHandle(), connectionId, onMessage, { busy = it }, { transfer = it },
                                    { if (clip.mode == SftpClipboardMode.CUT) setClip(null); refresh() }, scope,
                                )
                            }) { Text("覆盖") }
                            TextButton(onClick = {
                                dialog = null
                                if (clip != null) applyPaste(
                                    clip, SftpPasteConflictMode.SKIP, entries.map { it.name }.toSet(),
                                    port, path, currentHandle(), connectionId, onMessage, { busy = it }, { transfer = it },
                                    { if (clip.mode == SftpClipboardMode.CUT) setClip(null); refresh() }, scope,
                                )
                            }) { Text("跳过") }
                            TextButton(onClick = {
                                dialog = null
                                if (clip != null) applyPaste(
                                    clip, SftpPasteConflictMode.COMPATIBLE, entries.map { it.name }.toSet(),
                                    port, path, currentHandle(), connectionId, onMessage, { busy = it }, { transfer = it },
                                    { if (clip.mode == SftpClipboardMode.CUT) setClip(null); refresh() }, scope,
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
                                histories[currentFile.path]?.clear()
                                upsertEditor(
                                    currentFile.copy(
                                        baseline = RemoteFileRead(currentFile.path, bytes, receipt.mtimeMs, receipt.sha256),
                                        dirty = false,
                                        generation = currentFile.generation + 1,
                                    ),
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
    onOpen: () -> Unit,
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
            MiniChip("打开", onOpen)
            MiniChip("复制", onCopy)
            MiniChip("剪切", onCut)
            MiniChip("重命名", onRename, enabled = selectedCount == 1)
            MiniChip("删除", onDelete)
            MiniChip("压缩", onCompress)
            MiniChip("权限", onChmod, enabled = selectedCount == 1)
            MiniChip("下载", onDownload, enabled = selectedCount >= 1)
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
    files: List<BrowserFile>,
    activeIndex: Int,
    onSelect: (Int) -> Unit,
    onCloseTab: (Int) -> Unit,
    onChange: (String, FileEncoding, String, Int, Boolean) -> Unit,
    onUndo: (String) -> Unit,
    onRedo: (String) -> Unit,
    onFormat: (String) -> Unit,
    onBack: () -> Unit,
    onSave: (String) -> Unit,
    onWorkspaceSearch: (String) -> Unit,
    onOpenHit: (String) -> Unit,
) {
    val file = files.getOrNull(activeIndex) ?: return
    var findQuery by remember { mutableStateOf("") }
    var findOpen by remember { mutableStateOf(false) }
    var outlineOpen by remember { mutableStateOf(false) }
    var workspaceQuery by remember { mutableStateOf("") }
    var workspaceOpen by remember { mutableStateOf(false) }
    var draft by remember(file.path) {
        mutableStateOf(TextFieldValue(file.text, TextRange(file.text.length)))
    }
    LaunchedEffect(file.path, file.generation) {
        if (draft.text != file.text) {
            val nextSelection = draft.selection.start.coerceIn(0, file.text.length)
            draft = TextFieldValue(file.text, TextRange(nextSelection))
        }
    }
    var analysisText by remember(file.path) { mutableStateOf(file.text) }
    LaunchedEffect(draft.text, findOpen, outlineOpen, findQuery) {
        if (!findOpen && !outlineOpen) {
            analysisText = draft.text
            return@LaunchedEffect
        }
        delay(180)
        analysisText = draft.text
    }
    val hits = remember(analysisText, findQuery, findOpen) {
        if (!findOpen || findQuery.isBlank()) emptyList() else SftpEditorSupport.findInText(analysisText, findQuery)
    }
    val outline = remember(analysisText, file.path, outlineOpen) {
        if (!outlineOpen) emptyList() else SftpEditorSupport.outline(analysisText, file.path)
    }
    fun commitDraft() {
        if (draft.text != file.text) {
            onChange(draft.text, file.encoding, file.lineEnding, file.tabSize, file.wrap)
        }
    }
    // First differing keystroke marks dirty immediately so BackHandler cannot
    // drop the file as clean. Later keystrokes stay local for 140ms.
    LaunchedEffect(draft.text, file.path, file.encoding, file.lineEnding, file.tabSize, file.wrap) {
        if (draft.text == file.text) return@LaunchedEffect
        if (file.dirty) delay(140)
        onChange(draft.text, file.encoding, file.lineEnding, file.tabSize, file.wrap)
    }
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().background(ZephyrTheme.palette.surfaces.content).padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            IconButton(onClick = { commitDraft(); onBack() }) { Icon(ZephyrIcons.Back, "返回文件列表") }
            Column(Modifier.weight(1f)) {
                Text(file.title, color = ZephyrTheme.palette.onFloating, fontWeight = FontWeight.SemiBold, maxLines = 1)
                Text(
                    (if (file.dirty || draft.text != file.text) "未保存 · " else "") + SftpEditorSupport.languageOf(file.path) + " · " + file.path,
                    color = ZephyrTheme.palette.onFloatingSubtle,
                    fontSize = 10.sp,
                    maxLines = 1,
                )
            }
            PrimaryButton(
                onClick = { onSave(draft.text) },
                enabled = file.dirty || draft.text != file.text,
            ) { Text("保存") }
        }
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            files.forEachIndexed { index, tab ->
                AssistChip(
                    onClick = { commitDraft(); onSelect(index) },
                    label = { Text((if (tab.dirty || (index == activeIndex && draft.text != file.text)) "● " else "") + tab.title, fontSize = 11.sp) },
                )
                if (index == activeIndex) {
                    TextButton(onClick = { commitDraft(); onCloseTab(index) }) { Text("×") }
                }
            }
        }
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FileEncoding.entries.forEach { encoding ->
                FilterChip(
                    selected = file.encoding == encoding,
                    onClick = { onChange(encoding.decode(file.baseline.bytes), encoding, file.lineEnding, file.tabSize, file.wrap) },
                    enabled = encoding.isAvailable,
                    label = { Text(encoding.label, fontSize = 11.sp) },
                )
            }
            FilterChip(selected = file.lineEnding == "lf", onClick = { onChange(draft.text, file.encoding, "lf", file.tabSize, file.wrap) }, label = { Text("LF", fontSize = 11.sp) })
            FilterChip(selected = file.lineEnding == "crlf", onClick = { onChange(draft.text, file.encoding, "crlf", file.tabSize, file.wrap) }, label = { Text("CRLF", fontSize = 11.sp) })
            FilterChip(selected = file.tabSize == 2, onClick = { onChange(draft.text, file.encoding, file.lineEnding, 2, file.wrap) }, label = { Text("Tab 2", fontSize = 11.sp) })
            FilterChip(selected = file.tabSize == 4, onClick = { onChange(draft.text, file.encoding, file.lineEnding, 4, file.wrap) }, label = { Text("Tab 4", fontSize = 11.sp) })
            FilterChip(selected = file.wrap, onClick = { onChange(draft.text, file.encoding, file.lineEnding, file.tabSize, !file.wrap) }, label = { Text("换行", fontSize = 11.sp) })
            AssistChip(onClick = { commitDraft(); onUndo(draft.text) }, label = { Text("撤回", fontSize = 11.sp) })
            AssistChip(onClick = { commitDraft(); onRedo(draft.text) }, label = { Text("前进", fontSize = 11.sp) })
            AssistChip(onClick = { commitDraft(); onFormat(draft.text) }, label = { Text("格式化", fontSize = 11.sp) })
            AssistChip(onClick = { findOpen = !findOpen }, label = { Text("查找", fontSize = 11.sp) })
            AssistChip(onClick = { outlineOpen = !outlineOpen }, label = { Text("大纲", fontSize = 11.sp) })
            AssistChip(onClick = { workspaceOpen = !workspaceOpen }, label = { Text("搜目录", fontSize = 11.sp) })
        }
        if (findOpen) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(value = findQuery, onValueChange = { findQuery = it }, modifier = Modifier.weight(1f), singleLine = true, placeholder = { Text("在文件中查找") })
                Text("${hits.size}", color = ZephyrTheme.palette.onFloatingSubtle, fontSize = 11.sp, modifier = Modifier.padding(start = 8.dp))
            }
            if (hits.isNotEmpty()) {
                Column(Modifier.fillMaxWidth().heightIn(max = 120.dp).verticalScroll(rememberScrollState()).padding(horizontal = 12.dp)) {
                    hits.take(40).forEach { hit ->
                        Text("L${hit.line}:${hit.column}  ${hit.text}", color = ZephyrTheme.palette.onFloatingMuted, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
                    }
                }
            }
        }
        if (workspaceOpen) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(value = workspaceQuery, onValueChange = { workspaceQuery = it }, modifier = Modifier.weight(1f), singleLine = true, placeholder = { Text("在当前 SFTP 目录搜索文本…") })
                TextButton(onClick = { if (workspaceQuery.isNotBlank()) onWorkspaceSearch(workspaceQuery) }) { Text("搜索") }
            }
        }
        Row(Modifier.fillMaxSize()) {
            BasicTextField(
                value = draft,
                onValueChange = { draft = it },
                modifier = Modifier
                    .weight(1f)
                    .fillMaxSize()
                    .background(ZephyrTheme.palette.surfaces.background)
                    .verticalScroll(rememberScrollState())
                    .then(if (file.wrap) Modifier else Modifier.horizontalScroll(rememberScrollState()))
                    .padding(14.dp),
                textStyle = androidx.compose.ui.text.TextStyle(
                    color = ZephyrTheme.palette.onFloating,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 13.sp,
                    lineHeight = 19.sp,
                ),
                softWrap = file.wrap,
            )
            if (outlineOpen) {
                Column(
                    Modifier.width(160.dp).fillMaxSize().background(ZephyrTheme.palette.surfaces.content).verticalScroll(rememberScrollState()).padding(8.dp),
                ) {
                    Text("大纲", color = ZephyrTheme.palette.onFloatingSubtle, fontSize = 11.sp)
                    if (outline.isEmpty()) Text("暂无符号", color = ZephyrTheme.palette.onFloatingSubtle, fontSize = 11.sp)
                    outline.forEach { item ->
                        Text("L${item.line}  ${item.name}", color = ZephyrTheme.palette.onFloating, fontSize = 11.sp, maxLines = 1, modifier = Modifier.padding(vertical = 3.dp))
                    }
                    @Suppress("UNUSED_VARIABLE")
                    val keepOpen = onOpenHit
                }
            }
        }
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
                    val mediaFile = remember(preview.path, preview.cacheFile) {
                        preview.cacheFile ?: File(cacheDir, "sftp-preview-${preview.path.hashCode()}.${SshFileKinds.extensionOf(preview.path).ifBlank { "bin" }}").apply {
                            if (preview.bytes.isNotEmpty()) writeBytes(preview.bytes)
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

private fun querySize(context: android.content.Context, uri: Uri): Long {
    val cursor = context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.SIZE), null, null, null)
    return cursor?.use {
        if (it.moveToFirst()) it.getLong(0) else 0L
    } ?: 0L
}

private suspend fun streamDownload(
    port: SftpPort,
    handle: SftpSessionHandle,
    remotePath: String,
    uri: Uri,
    context: android.content.Context,
    label: String,
    push: (SftpTransferOps.Transfer) -> Unit,
    knownSize: Long = 0L,
) {
    val id = "dl-$remotePath-${System.currentTimeMillis()}"
    context.contentResolver.openOutputStream(uri)?.use { output ->
        port.readStream(handle, remotePath, 0L) { offset, bytes, total ->
            output.write(bytes)
            push(
                SftpTransferOps.Transfer(
                    id = id,
                    label = "下载 $label",
                    direction = SftpTransferOps.Direction.DOWNLOAD,
                    path = remotePath,
                    loaded = offset + bytes.size,
                    total = if (total > 0) total else knownSize,
                    detail = SftpOpenPolicy.formatBytes(offset + bytes.size),
                ),
            )
        }
    } ?: error("无法写入本机文件")
    push(
        SftpTransferOps.Transfer(
            id = id,
            label = "下载 $label",
            direction = SftpTransferOps.Direction.DOWNLOAD,
            path = remotePath,
            loaded = knownSize,
            total = knownSize,
            status = SftpTransferOps.Status.DONE,
            detail = "完成",
        ),
    )
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
    destinationConnectionId: String,
    onMessage: (String) -> Unit,
    setBusy: (Boolean) -> Unit,
    setTransfer: (TransferJob?) -> Unit,
    onDone: () -> Unit,
    scope: kotlinx.coroutines.CoroutineScope,
) {
    scope.launch {
        runOp(onMessage, setBusy, setTransfer) {
            val plan = SftpClipboardOps.planPaste(clip, directory, existing, mode)
            if (plan.copies.isEmpty()) error("没有可粘贴的项目")
            if (clip.sameHostAs(destinationConnectionId)) {
                val command = SftpClipboardOps.commandFor(plan, cut = clip.mode == SftpClipboardMode.CUT)
                    ?: error("没有可粘贴的项目")
                port.exec(handle, command).requireOk("粘贴")
            } else {
                val source = port.open(clip.sourceConnectionId)
                try {
                    for ((from, to) in plan.copies) {
                        val chunks = ArrayList<ByteArray>()
                        port.readStream(source, from, 0L) { _, bytes, _ -> chunks += bytes }
                        var index = 0
                        port.writeStream(handle, to) {
                            if (index >= chunks.size) null else chunks[index++]
                        }
                        if (clip.mode == SftpClipboardMode.CUT) {
                            runCatching { port.delete(source, from, recursive = true) }
                        }
                    }
                } finally {
                    runCatching { port.close(source) }
                }
            }
            onMessage("已粘贴 ${plan.copies.size} 项")
            onDone()
        }
    }
}
