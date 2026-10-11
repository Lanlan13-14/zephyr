package one.zephyr.mobile.feature.notes

import android.net.Uri
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.delay
import one.zephyr.mobile.ui.component.*
import one.zephyr.mobile.ui.theme.ZephyrTextStyles
import one.zephyr.mobile.ui.theme.ZephyrTheme
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.util.VLCVideoLayout
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * AVPlayerViewController-style surface: the video fills the pane, controls live
 * in a translucent overlay the user toggles by tapping the video. Nothing sits
 * permanently under the surface stealing space from the picture.
 */
@Composable
internal fun RawMediaPlayer(
    file: File,
    audioOnly: Boolean,
    subtitles: List<File>,
    modifier: Modifier = Modifier,
    onMessage: (String) -> Unit,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val engine = remember { VlcEngine.obtain(context) }
    if (engine == null) {
        Box(modifier.background(ZephyrTheme.palette.surfaces.background), contentAlignment = Alignment.Center) {
            Text(
                VlcEngine.failure() ?: "LibVLC 未能加载，无法预览该媒体",
                color = ZephyrTheme.palette.onBackground,
                modifier = Modifier.padding(24.dp),
            )
        }
        return
    }
    val player = remember(engine, file) { MediaPlayer(engine) }
    val events = remember(player) { android.os.Handler(android.os.Looper.getMainLooper()) }
    val disposed = remember(player) { AtomicBoolean(false) }
    var playing by remember(file) { mutableStateOf(false) }
    var started by remember(file) { mutableStateOf(false) }
    var ended by remember(file) { mutableStateOf(false) }
    var failure by remember(file) { mutableStateOf<String?>(null) }
    var position by remember(file) { mutableLongStateOf(0L) }
    var duration by remember(file) { mutableLongStateOf(0L) }
    var speed by remember(file) { mutableFloatStateOf(1f) }
    var volume by remember(file) { mutableFloatStateOf(100f) }
    var muted by remember(file) { mutableStateOf(false) }
    var repeat by remember(file) { mutableStateOf(false) }
    var trackRevision by remember { mutableIntStateOf(0) }
    var seekable by remember(file) { mutableStateOf(false) }
    var opened by remember(file) { mutableStateOf(false) }
    var boundView by remember(file) { mutableStateOf<VLCVideoLayout?>(null) }
    var controlsVisible by remember(file) { mutableStateOf(audioOnly) }
    var sheet by remember { mutableStateOf<Sheet?>(null) }
    val latestMessage by rememberUpdatedState(onMessage)
    val latestRepeat by rememberUpdatedState(repeat)

    DisposableEffect(player) {
        player.setEventListener { event ->
            events.post {
                if (disposed.get() || player.isReleased) return@post
                when (event.type) {
                    MediaPlayer.Event.Playing -> { playing = true; failure = null; seekable = player.isSeekable; trackRevision++ }
                    MediaPlayer.Event.Paused, MediaPlayer.Event.Stopped -> playing = false
                    MediaPlayer.Event.EndReached -> {
                        playing = false; ended = true
                        if (latestRepeat) { player.stop(); player.play(); ended = false }
                    }
                    MediaPlayer.Event.EncounteredError -> {
                        playing = false
                        failure = "客户端无法解码该媒体或文件已损坏"
                        latestMessage(failure!!)
                    }
                    MediaPlayer.Event.ESAdded, MediaPlayer.Event.ESDeleted -> trackRevision++
                }
            }
        }
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP && !disposed.get() && !player.isReleased) {
                player.pause(); playing = false
            }
        }
        lifecycle.addObserver(observer)
        onDispose {
            disposed.set(true)
            lifecycle.removeObserver(observer)
            player.setEventListener(null)
            events.removeCallbacksAndMessages(null)
            if (!player.isReleased) {
                runCatching { player.stop() }
                runCatching { player.detachViews() }
                player.release()
            }
        }
    }
    LaunchedEffect(player, opened) {
        if (!opened) return@LaunchedEffect
        while (!disposed.get() && !player.isReleased) {
            position = player.time.coerceAtLeast(0L)
            duration = player.length.coerceAtLeast(0L)
            seekable = player.isSeekable
            delay(250)
        }
    }
    // Auto-hide the chrome a few seconds after opening, the AVPlayer behavior;
    // any tap brings it back.
    LaunchedEffect(opened, controlsVisible) {
        if (!opened || !controlsVisible) return@LaunchedEffect
        delay(3500)
        controlsVisible = false
    }
    val mountedSubtitles = remember(player) { mutableSetOf<String>() }
    LaunchedEffect(player, started, subtitles) {
        if (!started || disposed.get()) return@LaunchedEffect
        for (subtitle in subtitles) {
            if (disposed.get()) return@LaunchedEffect
            if (!mountedSubtitles.add(subtitle.absolutePath)) continue
            if (!player.addSlave(0, Uri.fromFile(subtitle), true)) {
                mountedSubtitles.remove(subtitle.absolutePath)
                latestMessage("无法挂载字幕 ${subtitle.name}")
            }
        }
        trackRevision++
    }
    val audioTracks = remember(player, trackRevision, opened) {
        if (!opened || disposed.get()) emptyList() else player.audioTracks?.toList().orEmpty()
    }
    val subtitleTracks = remember(player, trackRevision, opened) {
        if (!opened || disposed.get()) emptyList() else player.spuTracks?.toList().orEmpty()
    }

    // Audio has no surface: the media opens when playback is first requested.
    // Video opens inside AndroidView.update, surface-first (#274's contract).
    fun openAudioIfNeeded() {
        if (opened || !audioOnly || disposed.get()) return
        val media = Media(engine, Uri.fromFile(file))
        media.setHWDecoderEnabled(false, false)
        media.addOption(":file-caching=1500")
        player.media = media
        media.release()
        opened = true
    }

    fun togglePlay() {
        if (disposed.get()) return
        if (playing) { player.pause(); playing = false }
        else {
            if (!opened) {
                if (!audioOnly) return
                openAudioIfNeeded()
            }
            if (ended) { player.stop(); ended = false }
            player.play(); started = true
        }
    }

    val overlayAlpha by animateFloatAsState(
        targetValue = if (controlsVisible) 1f else 0f,
        animationSpec = tween(180),
        label = "controls",
    )

    Box(modifier.background(ZephyrTheme.palette.surfaces.background)) {
        if (audioOnly) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(if (playing) "音频正在播放" else "音频", color = ZephyrTheme.palette.onBackground)
            }
        } else {
            AndroidView(
                factory = { viewContext -> VLCVideoLayout(viewContext) },
                update = { view ->
                    if (disposed.get() || boundView === view) return@AndroidView
                    if (boundView != null) {
                        // Rotation: detach only — stop() drops the media.
                        runCatching { player.detachViews() }
                    }
                    // VideoPlayerActivity order: surface first, then the media.
                        player.attachViews(view, null, true, false)
                    if (!opened) {
                        val media = Media(engine, Uri.fromFile(file))
                        media.setHWDecoderEnabled(false, false)
                        media.addOption(":file-caching=1500")
                        player.media = media
                        media.release()
                        opened = true
                        // Surface-first open, then play — startPlayback in
                        // VideoPlayerActivity does the same. Chrome shows for a
                        // moment so the transport is discoverable.
                        player.play()
                        started = true
                        controlsVisible = true
                    }
                    boundView = view
                },
                modifier = Modifier.fillMaxSize(),
            )
            // Tap the surface to toggle the chrome — the picture is never
            // permanently obstructed.
            Box(
                Modifier
                    .matchParentSize()
                    .pointerInput(Unit) {
                        detectTapGestures {
                            // Toggling chrome never changes playback state; the
                            // user taps the transport to play/pause.
                            controlsVisible = !controlsVisible
                        }
                    },
            )
        }

        failure?.let {
            Text(
                it,
                color = ZephyrTheme.palette.status.error,
                style = ZephyrTextStyles.caption,
                modifier = Modifier.align(Alignment.TopCenter).padding(8.dp),
            )
        }

        // Translucent overlay: center transport at mid-height, scrubber at the
        // bottom — the AVPlayerViewController arrangement.
        Column(
            Modifier.matchParentSize().alpha(overlayAlpha).background(Color(0x40000000)),
            verticalArrangement = Arrangement.SpaceBetween,
        ) {
            Spacer(Modifier.weight(1f))
            Row(
                Modifier.fillMaxWidth().padding(bottom = 24.dp),
                horizontalArrangement = Arrangement.spacedBy(36.dp, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RoundIcon(
                    glyph = "−10秒",
                    description = "后退10秒",
                    enabled = seekable,
                    onClick = { if (!disposed.get()) player.setTime((position - 10_000).coerceAtLeast(0L)) },
                )
                Box(
                    Modifier
                        .size(70.dp)
                        .clip(androidx.compose.foundation.shape.CircleShape)
                        .background(Color(0xF2FFFFFF))
                        .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { togglePlay() },
                    contentAlignment = Alignment.Center,
                ) {
                    // Glyph + state label pair so the contract and screen readers
                    // both see 播放/暂停.
                    Text(
                        if (playing) "❚❚ 暂停" else "▶ 播放",
                        color = Color(0xFF14181D),
                        style = ZephyrTextStyles.caption,
                    )
                }
                RoundIcon(
                    glyph = "+10秒",
                    description = "前进10秒",
                    enabled = seekable,
                    onClick = { if (!disposed.get()) player.setTime((position + 10_000).coerceAtMost(duration)) },
                )
            }
            Column(
                Modifier.fillMaxWidth().background(Color(0x33000000)).padding(horizontal = 16.dp, vertical = 10.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(clock(position), color = Color.White, style = ZephyrTextStyles.caption)
                    ScrubBar(
                        fraction = if (duration > 0) position.toFloat() / duration else 0f,
                        enabled = duration > 0L && seekable,
                        onChange = { if (duration > 0 && !disposed.get()) { position = (it * duration).toLong(); player.setTime(position) } },
                        modifier = Modifier.weight(1f),
                    )
                    Text(if (duration > 0) "-${clock(duration - position)}" else clock(duration), color = Color.White, style = ZephyrTextStyles.caption)
                }
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OverlayText("音轨") { sheet = Sheet.Audio }
                    OverlayText("字幕") { sheet = Sheet.Subtitles }
                    OverlayText("${speed}×") { sheet = Sheet.Speed }
                    OverlayText(if (repeat) "循环开" else "循环关") { repeat = !repeat }
                    OverlayText(if (muted || volume == 0f) "取消静音" else "静音") {
                        if (disposed.get()) return@OverlayText
                        muted = !muted
                        volume = if (muted) 0f else 100f
                        player.setVolume(volume.toInt())
                    }
                }
            }
        }

        sheet?.let { current ->
            AlertDialog(
                onDismissRequest = { sheet = null },
                confirmButton = {},
                title = {
                    Text(
                        when (current) { Sheet.Audio -> "音轨"; Sheet.Subtitles -> "字幕"; Sheet.Speed -> "倍速" },
                        style = ZephyrTextStyles.bodyStrong,
                    )
                },
                text = {
                    val options = when (current) {
                        Sheet.Audio -> audioTracks.map { it.name ?: "音轨 ${it.id}" }
                        Sheet.Subtitles -> buildList {
                            add("关闭")
                            subtitleTracks.filter { it.id >= 0 }.forEach { add(it.name ?: "字幕 ${it.id}") }
                        }
                        Sheet.Speed -> listOf("0.5×", "0.75×", "1×", "1.25×", "1.5×", "2×")
                    }
                    Column {
                        options.forEachIndexed { index, label ->
                            Text(
                                label,
                                style = ZephyrTextStyles.body,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {
                                        when (current) {
                                            Sheet.Audio -> if (disposed.get() || !player.setAudioTrack(audioTracks[index].id)) latestMessage("音轨切换失败")
                                            Sheet.Subtitles -> {
                                                val spu = if (index == 0) -1 else subtitleTracks.filter { it.id >= 0 }[index - 1].id
                                                if (disposed.get() || !player.setSpuTrack(spu)) latestMessage("字幕切换失败")
                                            }
                                            Sheet.Speed -> {
                                                speed = when (index) { 0 -> 0.5f; 1 -> 0.75f; 2 -> 1f; 3 -> 1.25f; 4 -> 1.5f; else -> 2f }
                                                if (!disposed.get()) player.rate = speed
                                            }
                                        }
                                        sheet = null
                                    }
                                    .padding(vertical = 12.dp, horizontal = 4.dp),
                            )
                        }
                    }
                },
            )
        }
    }
}

private enum class Sheet { Audio, Subtitles, Speed }

@Composable
private fun OverlayText(label: String, onClick: () -> Unit) {
    Text(
        label,
        color = Color.White,
        style = ZephyrTextStyles.caption,
        modifier = Modifier
            .clip(androidx.compose.foundation.shape.RoundedCornerShape(8.dp))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 4.dp),
    )
}

@Composable
private fun RoundIcon(glyph: String, description: String, enabled: Boolean, onClick: () -> Unit) {
    Text(
        glyph,
        color = if (enabled) Color.White else Color(0x80FFFFFF),
        style = ZephyrTextStyles.caption,
        modifier = Modifier
            .size(48.dp)
            .clip(androidx.compose.foundation.shape.CircleShape)
            .background(Color(0x33000000))
            .clickable(
                enabled = enabled,
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            )
            .wrapContentSize(Alignment.Center),
    )
}

@Composable
private fun ScrubBar(fraction: Float, enabled: Boolean, onChange: (Float) -> Unit, modifier: Modifier = Modifier) {
    // ScrubBar is the video Slider: draggable progress rail (the desktop
    // viewer's Slider control, on the overlay's bottom bar).
    Box(
        modifier
            .fillMaxWidth()
            .height(30.dp)
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                detectHorizontalDragGestures { change, _ ->
                    change.consume()
                    onChange((change.position.x / size.width).coerceIn(0f, 1f))
                }
            },
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(Modifier.fillMaxWidth().height(4.dp).clip(androidx.compose.foundation.shape.RoundedCornerShape(2.dp)).background(Color(0x59FFFFFF)))
        Box(
            Modifier
                .fillMaxWidth(fraction.coerceIn(0f, 1f))
                .height(4.dp)
                .clip(androidx.compose.foundation.shape.RoundedCornerShape(2.dp))
                .background(ZephyrTheme.palette.brand.accent),
        )
    }
}

private fun clock(milliseconds: Long): String {
    val seconds = milliseconds / 1000
    return if (seconds >= 3600) "%d:%02d:%02d".format(seconds / 3600, seconds / 60 % 60, seconds % 60)
    else "%d:%02d".format(seconds / 60 % 60, seconds % 60)
}
