package one.zephyr.mobile.feature.notes

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
import one.zephyr.mobile.ui.theme.ZephyrTextStyles
import one.zephyr.mobile.ui.theme.ZephyrTheme
import java.io.File

/**
 * Photos.app-style viewer: the picture fills the pane; adjustments live in a
 * translucent pill that floats over the bottom edge instead of a solid bar
 * above the image. Gestures are unchanged (pinch/pan/rotate/flip, double-tap
 * for 1:1).
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
    var chromeVisible by remember(file) { mutableStateOf(true) }

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
        if (fit > 0) zoom = 1f / fit
        offset = Offset.Zero
    }

    Box(
        modifier
            .background(ZephyrTheme.palette.surfaces.background)
            .onSizeChanged { viewport = it }
            .pointerInput(file) {
                detectTransformGestures { _, pan, zoomChange, rotation ->
                    zoom = (zoom * zoomChange).coerceIn(0.05f, 20f)
                    angle = (angle + rotation) % 360f
                    offset += pan
                }
            }
            .pointerInput(file) {
                detectTapGestures(
                    onDoubleTap = { oneToOne() },
                    onTap = { chromeVisible = !chromeVisible },
                )
            },
    ) {
        when {
            failure != null -> Text(
                "图片预览失败：$failure",
                color = ZephyrTheme.palette.onBackground,
                modifier = Modifier.align(Alignment.Center).padding(16.dp),
            )
            bitmap == null -> Text(
                "正在用 FFmpeg 解码图片…",
                color = ZephyrTheme.palette.onFloatingMuted,
                modifier = Modifier.align(Alignment.Center),
            )
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

        // Translucent pill over the picture (Photos.app chrome). Tap the image
        // to toggle; adjustments stay one tap away without a permanent bar.
        val meta = decoded
        if (chromeVisible) {
            Column(
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .background(androidx.compose.ui.graphics.Color(0x40000000))
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(20.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    PillAction("＋") { zoom = (zoom * 1.2f).coerceIn(0.05f, 20f) }
                    PillAction("−") { zoom = (zoom / 1.2f).coerceIn(0.05f, 20f) }
                    PillAction("1:1") { oneToOne() }
                    PillAction("重置") { reset() }
                    PillAction("上一张") { onSibling(-1) }
                    PillAction("下一张") { onSibling(1) }
                    PillAction("左旋") { angle = (angle - 90f) % 360f }
                    PillAction("右旋") { angle = (angle + 90f) % 360f }
                    PillAction("水平翻转") { flipX *= -1f }
                    PillAction("垂直翻转") { flipY *= -1f }
                }
                if (meta != null) {
                    Text(
                        "$name · ${meta.width}×${meta.height} · ${String.format("%.1f", file.length() / 1024.0)} KiB · ${meta.engine}",
                        color = androidx.compose.ui.graphics.Color(0xB3FFFFFF),
                        style = ZephyrTextStyles.caption,
                    )
                }
            }
        }
    }
}

@Composable
private fun PillAction(label: String, onClick: () -> Unit) {
    Text(
        label,
        color = androidx.compose.ui.graphics.Color.White,
        style = ZephyrTextStyles.caption,
        modifier = Modifier
            .clip(androidx.compose.foundation.shape.RoundedCornerShape(8.dp))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClick)
            .padding(horizontal = 4.dp, vertical = 6.dp),
    )
}
