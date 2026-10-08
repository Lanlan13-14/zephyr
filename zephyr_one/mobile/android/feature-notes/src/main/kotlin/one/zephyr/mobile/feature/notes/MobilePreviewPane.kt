package one.zephyr.mobile.feature.notes

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import one.zephyr.mobile.protocol.ssh.SshFileKinds
import one.zephyr.mobile.ui.component.*
import one.zephyr.mobile.ui.theme.ZephyrTheme
import java.io.File
import kotlin.math.roundToInt

/** Unified local / native SSH / authenticated server or Agent HTTP RAW preview. */
@Composable
fun MobilePreviewPane(
    source: PreviewSource,
    onBack: () -> Unit,
    onMessage: (String) -> Unit = {},
    siblings: List<PreviewSource> = emptyList(),
    onSource: (PreviewSource) -> Unit = {},
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val configuration = LocalConfiguration.current
    var revision by remember(source) { mutableIntStateOf(0) }
    var layout by remember { mutableStateOf("full") }
    var layoutMenu by remember { mutableStateOf(false) }
    var x by remember { mutableFloatStateOf(0f) }
    var y by remember { mutableFloatStateOf(0f) }
    var widthAdjust by remember { mutableFloatStateOf(0f) }
    var heightAdjust by remember { mutableFloatStateOf(0f) }
    val image = SshFileKinds.isImage(source.name)
    val files = remember(source, revision) { PreviewFiles(context) }
    var staged by remember(files) { mutableStateOf<File?>(null) }
    var failure by remember(files) { mutableStateOf<String?>(null) }
    var subtitles by remember(files) { mutableStateOf<List<File>>(emptyList()) }
    var subtitlePath by remember { mutableStateOf<String?>(null) }
    var subtitleBusy by remember(files) { mutableStateOf(false) }
    var generationAlive by remember(files) { mutableStateOf(true) }
    val latestMessage by rememberUpdatedState(onMessage)
    DisposableEffect(files) { onDispose { generationAlive = false; files.close() } }
    LaunchedEffect(files) {
        try {
            staged = files.stage(source, if (image) SftpOpenPolicy.IMAGE_PREVIEW_LIMIT else SftpOpenPolicy.MEDIA_CACHE_LIMIT)
            if (!image) {
                val sidecars = when (source) {
                    is PreviewSource.Sftp -> {
                        val directory = source.path.substringBeforeLast('/', ".")
                        source.port.list(source.handle, directory).filter {
                            !it.isDirectory && isSidecarSubtitle(source.name, it.name)
                        }.take(8).map { PreviewSource.Sftp(source.port, source.handle, it.path) }
                    }
                    is PreviewSource.Http -> source.subtitles
                    else -> emptyList()
                }
                for (sidecar in sidecars) {
                    try { subtitles = subtitles + files.stage(sidecar, SUBTITLE_LIMIT) }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (error: Exception) { latestMessage("旁挂字幕读取失败：${error.message}") }
                }
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { if (generationAlive) failure = error.message ?: "预览读取失败" }
    }
    fun mountSubtitle(candidate: PreviewSource) {
        if (!isSubtitle(candidate.name)) { onMessage("仅支持 .vtt/.srt/.ass/.ssa/.sub 字幕"); return }
        subtitleBusy = true
        scope.launch {
            try {
                val file = files.stage(candidate, SUBTITLE_LIMIT)
                if (generationAlive) { subtitles = subtitles + file; latestMessage("已挂载字幕：${candidate.name}") }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (generationAlive) latestMessage("字幕挂载失败：${error.message}") }
            finally { if (generationAlive) subtitleBusy = false }
        }
    }
    val subtitlePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) mountSubtitle(PreviewSource.Local(uri, previewDisplayName(context, uri)))
    }
    fun openSibling(delta: Int) {
        val images = siblings.filter { SshFileKinds.isImage(it.name) }
        if (images.isEmpty()) { onMessage("当前来源没有其他图片"); return }
        val index = images.indexOfFirst { it.displayPath == source.displayPath }.coerceAtLeast(0)
        onSource(images[(index + delta + images.size) % images.size])
    }
    BackHandler { onBack() }
    Dialog(onDismissRequest = onBack, properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = false)) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val widthFraction = when (layout) { "half" -> 0.5f; "left-quarter", "right-quarter" -> 0.25f; else -> 1f }
            val availableWidth = maxWidth
            val availableHeight = maxHeight
            // Narrow phones retain usable touch targets; quarter/half layouts still select an edge.
            val width = (availableWidth * widthFraction + widthAdjust.dp).coerceIn(280.dp.coerceAtMost(availableWidth), availableWidth)
            val height = (availableHeight + heightAdjust.dp).coerceIn(260.dp.coerceAtMost(availableHeight), availableHeight)
            Column(
                Modifier.align(if (layout == "right-quarter") Alignment.TopEnd else Alignment.TopStart)
                    .offset { IntOffset(x.roundToInt(), y.roundToInt()) }.width(width).height(height)
                    .background(ZephyrTheme.palette.surfaces.background),
            ) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Box {
                        TextButton(onClick = { layoutMenu = true }) { Text("布局") }
                        DropdownMenu(expanded = layoutMenu, onDismissRequest = { layoutMenu = false }) {
                            listOf("full" to "全屏", "half" to "半屏", "left-quarter" to "左侧四分之一", "right-quarter" to "右侧四分之一").forEach { (key, title) ->
                                DropdownMenuItem({ Text(title) }, { layout = key; x = 0f; y = 0f; widthAdjust = 0f; heightAdjust = 0f; layoutMenu = false })
                            }
                            DropdownMenuItem({ Text("关闭窗口") }, onBack)
                        }
                    }
                    Text(source.name, modifier = Modifier.weight(1f).pointerInput(configuration.screenWidthDp, configuration.screenHeightDp) {
                        detectDragGestures { change, drag ->
                            change.consume()
                            x = (x + drag.x).coerceIn(-size.width.toFloat() + 60f, size.width.toFloat() - 60f)
                            y = (y + drag.y).coerceIn(0f, configuration.screenHeightDp * density - 100f)
                        }
                    })
                    TextButton(onClick = onBack) { Text("关闭") }
                }
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
                    TextButton(onClick = { revision++ }) { Text("刷新") }
                    if (!image) {
                        TextButton(onClick = { subtitlePicker.launch(arrayOf("*/*")) }, enabled = !subtitleBusy) { Text("本地字幕") }
                        TextButton(onClick = { subtitlePath = "" }, enabled = !subtitleBusy) { Text("路径字幕") }
                    }
                    Text("${source.displayPath} · ${if (image) "图片" else "客户端 RAW 解码"}", modifier = Modifier.padding(12.dp))
                }
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    when {
                        failure != null -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("预览失败：$failure", modifier = Modifier.padding(12.dp))
                            TextButton(onClick = { revision++ }) { Text("重试") }
                        }
                        staged == null -> Text("正在读取预览文件…")
                        image -> key(files) { RawImageViewer(staged!!, source.name, Modifier.fillMaxSize(), ::openSibling) }
                        else -> key(files) { RawMediaPlayer(staged!!, SshFileKinds.isAudio(source.name), subtitles, Modifier.fillMaxSize(), onMessage) }
                    }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("↙ 调整大小", modifier = Modifier.padding(12.dp).pointerInput(availableWidth, availableHeight) {
                        detectDragGestures { change, drag -> change.consume(); widthAdjust -= drag.x / density; heightAdjust += drag.y / density }
                    })
                    Text("调整大小 ↘", modifier = Modifier.padding(12.dp).pointerInput(availableWidth, availableHeight) {
                        detectDragGestures { change, drag -> change.consume(); widthAdjust += drag.x / density; heightAdjust += drag.y / density }
                    })
                }
            }
        }
    }
    subtitlePath?.let { draft ->
        AlertDialog(
            onDismissRequest = { subtitlePath = null },
            title = { Text(if (source is PreviewSource.Sftp) "当前 SSH 路径字幕" else "HTTPS 路径字幕") },
            text = { OutlinedTextField(draft, onValueChange = { subtitlePath = it }, label = { Text("字幕文件路径 / 同源 HTTPS 地址") }) },
            confirmButton = { TextButton(onClick = {
                runCatching {
                    val candidate = when (source) {
                        is PreviewSource.Sftp -> PreviewSource.Sftp(source.port, source.handle,
                            if (draft.startsWith('/')) draft else RemotePath.join(source.path.substringBeforeLast('/', "."), draft))
                        is PreviewSource.Http -> RawPreviewReady(draft, draft).source(source.url, source.headers)
                        // Local files have no session origin. The document picker is the only
                        // subtitle input; an arbitrary URL must not be fetched into the decoder.
                        else -> error("本地预览请使用「本地字幕」选择文件")
                    }
                    mountSubtitle(candidate)
                    subtitlePath = null
                }.onFailure { onMessage(it.message ?: "无效字幕路径") }
            }, enabled = draft.isNotBlank()) { Text("挂载") } },
            dismissButton = { TextButton(onClick = { subtitlePath = null }) { Text("取消") } },
        )
    }
}

internal const val SUBTITLE_LIMIT = 4L * 1024 * 1024
internal fun isSubtitle(name: String): Boolean = name.substringAfterLast('.').lowercase() in setOf("vtt", "srt", "ass", "ssa", "sub")

/**
 * Desktop `preview/media/media-service.js` `isExternalSubtitleFor`: the subtitle basename is the
 * media basename, or the media basename plus a language suffix (`clip.en.srt`). Manual mounts still
 * accept MicroDVD `.sub`; automatic sidecars do not, because that extension is also a binary stream.
 */
internal fun isSidecarSubtitle(mediaName: String, subtitleName: String): Boolean {
    val ext = subtitleName.substringAfterLast('.', "").lowercase()
    if (ext !in setOf("vtt", "srt", "ass", "ssa")) return false
    val mediaBase = mediaName.substringBeforeLast('.').lowercase()
    val subtitleBase = subtitleName.substringBeforeLast('.').lowercase()
    return subtitleBase == mediaBase || subtitleBase.startsWith("$mediaBase.")
}
internal fun previewDisplayName(context: android.content.Context, uri: android.net.Uri): String =
    context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
    } ?: uri.lastPathSegment ?: "media"
