package one.zephyr.mobile.feature.notes

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import one.zephyr.mobile.protocol.ffmpeg.FfmpegImage
import one.zephyr.mobile.ui.component.*
import one.zephyr.mobile.ui.theme.ZephyrTheme
import java.io.File

/**
 * Full-pane image surface. Decode is ImageDecoder then FFmpeg, never a
 * browser engine. Gestures match the desktop viewer (pinch/pan/rotate/flip).
 */
@Composable
internal fun RawImageViewer(
    file: File,
    name: String,
    modifier: Modifier = Modifier,
    onSibling: (Int) -> Unit = {},
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var decoded by remember(file) { mutableStateOf<FfmpegImage.Result?>(null) }
    var bitmap by remember(file) { mutableStateOf<android.graphics.Bitmap?>(null) }
    var failure by remember(file) { mutableStateOf<String?>(null) }
    var zoom by remember(file) { mutableFloatStateOf(1f) }
    var angle by remember(file) { mutableFloatStateOf(0f) }
    var flipX by remember(file) { mutableFloatStateOf(1f) }
    var flipY by remember(file) { mutableFloatStateOf(1f) }
    var offset by remember(file) { mutableStateOf(Offset.Zero) }
    var viewport by remember { mutableStateOf(IntSize.Zero) }

    LaunchedEffect(file) {
        failure = null
        decoded = null
        bitmap?.recycle()
        bitmap = null
        val result = runCatching {
            withContext(Dispatchers.IO) { FfmpegImage.convert(context, file, name) }
        }
        result.fold(
            onSuccess = { value ->
                decoded = value
                bitmap = withContext(Dispatchers.IO) {
                    BitmapFactory.decodeFile(value.file.absolutePath)
                }
                if (bitmap == null) failure = "图片超过浏览器解码安全限制"
            },
            onFailure = { error -> failure = error.message ?: "浏览器解码图片失败" },
        )
    }
    DisposableEffect(file) {
        onDispose { bitmap?.recycle(); bitmap = null }
    }

    fun reset() { zoom = 1f; angle = 0f; flipX = 1f; flipY = 1f; offset = Offset.Zero }
    fun oneToOne() {
        val image = bitmap ?: return
        if (viewport.width <= 0 || viewport.height <= 0) return
        val fit = minOf(viewport.width.toFloat() / image.width, viewport.height.toFloat() / image.height, 1f)
        if (fit > 0f) zoom = 1f / fit
        offset = Offset.Zero
    }

    Column(modifier.background(ZephyrTheme.palette.surfaces.background)) {
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AssistChip(onClick = { zoom = (zoom * 1.2f).coerceIn(0.05f, 20f) }, label = { Text("＋") })
            AssistChip(onClick = { zoom = (zoom / 1.2f).coerceIn(0.05f, 20f) }, label = { Text("−") })
            AssistChip(onClick = { oneToOne() }, label = { Text("1:1") })
            AssistChip(onClick = { reset() }, label = { Text("重置") })
            AssistChip(onClick = { onSibling(-1) }, label = { Text("上一张") })
            AssistChip(onClick = { onSibling(1) }, label = { Text("下一张") })
            AssistChip(onClick = { angle = (angle - 90f) % 360f }, label = { Text("左旋") })
            AssistChip(onClick = { angle = (angle + 90f) % 360f }, label = { Text("右旋") })
            AssistChip(onClick = { flipX *= -1f }, label = { Text("水平翻转") })
            AssistChip(onClick = { flipY *= -1f }, label = { Text("垂直翻转") })
        }
        Box(
            Modifier.weight(1f).fillMaxWidth().onSizeChanged { viewport = it }
                .pointerInput(file) {
                    detectTransformGestures { _, pan, zoomChange, rotation ->
                        zoom = (zoom * zoomChange).coerceIn(0.05f, 20f)
                        angle = (angle + rotation) % 360f
                        offset += pan
                    }
                }
                .pointerInput(file) {
                    detectTapGestures(onDoubleTap = { oneToOne() })
                },
            contentAlignment = Alignment.Center,
        ) {
            when {
                failure != null -> Text("图片预览失败：$failure", modifier = Modifier.padding(12.dp))
                bitmap == null -> Text("正在用 FFmpeg 解码图片…")
                else -> Image(
                    bitmap = bitmap!!.asImageBitmap(),
                    contentDescription = name,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize().graphicsLayer {
                        scaleX = zoom * flipX
                        scaleY = zoom * flipY
                        rotationZ = angle
                        translationX = offset.x
                        translationY = offset.y
                    },
                )
            }
        }
        val meta = decoded
        if (meta != null) {
            Text(
                "$name · ${meta.width}×${meta.height} · ${String.format("%.1f", file.length() / 1024.0)} KiB · ${meta.engine}",
                modifier = Modifier.padding(8.dp),
                color = ZephyrTheme.palette.onFloatingSubtle,
            )
        }
    }
}
