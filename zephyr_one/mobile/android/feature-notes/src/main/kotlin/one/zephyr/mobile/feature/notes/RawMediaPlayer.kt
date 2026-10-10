package one.zephyr.mobile.feature.notes

import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay
import one.zephyr.mobile.ui.component.*
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.util.VLCVideoLayout
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/** LibVLC includes native demuxers and software codecs; MediaCodec is only an optional fast path. */
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
    // Process-lived engine (see VlcEngine). Null means the native library did
    // not load; LibVLC.loadLibraries would have killed the process instead.
    val engine = remember { VlcEngine.obtain(context) }
    if (engine == null) {
        Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Text(VlcEngine.failure() ?: "LibVLC 未能加载，无法预览该媒体", modifier = Modifier.padding(16.dp))
        }
        return
    }
    val player = remember(engine, file) { MediaPlayer(engine) }
    // Dedicated handler so teardown can drop OUR posts without wiping the
    // MediaPlayer's own main-thread queue (it posts updateVideoSurfaces on Vout).
    val events = remember(player) { Handler(Looper.getMainLooper()) }
    val disposed = remember(player) { AtomicBoolean(false) }
    var playing by remember(file) { mutableStateOf(false) }
    var started by remember(file) { mutableStateOf(false) }
    var ended by remember(file) { mutableStateOf(false) }
    var failure by remember(file) { mutableStateOf<String?>(null) }
    var position by remember(file) { mutableLongStateOf(0L) }
    var duration by remember(file) { mutableLongStateOf(0L) }
    var speed by remember(file) { mutableFloatStateOf(1f) }
    var volume by remember(file) { mutableFloatStateOf(100f) }
    var repeat by remember(file) { mutableStateOf(false) }
    var trackRevision by remember { mutableIntStateOf(0) }
    var seekable by remember(file) { mutableStateOf(false) }
    // Native media open waits until the video surface is attached. libvlc
    // demuxes inside setMedia; doing that before attachViews (the moment this
    // composable replaces "正在读取预览文件") SIGSEGVs the vout.
    var opened by remember(file) { mutableStateOf(false) }
    var boundView by remember(file) { mutableStateOf<VLCVideoLayout?>(null) }
    var audioMenu by remember { mutableStateOf(false) }
    var subtitleMenu by remember { mutableStateOf(false) }
    val latestMessage by rememberUpdatedState(onMessage)
    val latestRepeat by rememberUpdatedState(repeat)

    DisposableEffect(player) {
        player.setEventListener { event ->
            events.post {
                if (disposed.get() || player.isReleased) return@post
                when (event.type) {
                    MediaPlayer.Event.Playing -> { playing = true; failure = null; trackRevision++ }
                    MediaPlayer.Event.Paused, MediaPlayer.Event.Stopped -> playing = false
                    MediaPlayer.Event.EndReached -> {
                        playing = false; ended = true
                        if (latestRepeat) { player.stop(); player.play(); ended = false }
                    }
                    MediaPlayer.Event.EncounteredError -> {
                        playing = false
                        failure = "客户端无法解码该媒体或文件已损坏（LibVLC）"
                        latestMessage(failure!!)
                    }
                    MediaPlayer.Event.ESAdded, MediaPlayer.Event.ESDeleted -> trackRevision++
                }
            }
        }
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP && !disposed.get() && !player.isReleased) {
                player.pause()
                playing = false
            }
        }
        lifecycle.addObserver(observer)
        onDispose {
            disposed.set(true)
            lifecycle.removeObserver(observer)
            // Null the listener first: VLCObject.release also clears it, but only
            // after dropping the native ref, and a callback already on the queue
            // must not touch the player. Do not clear the main looper — libvlc
            // posts its own surface update there.
            player.setEventListener(null)
            events.removeCallbacksAndMessages(null)
            if (!player.isReleased) {
                // stop() before the view goes: detachViews() disables the video
                // track (mVoutCount → 0) and then onSurfacesDestroyed tries to
                // disable it again against a window that is already INIT. The
                // next play() then calls native code on that dead vout and the
                // process dies (SIGSEGV). stop() resets mVoutCount first.
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
    // External VTT/SRT/ASS/SSA/MicroDVD .sub are decoded natively, including ASS styling.
    // LibVLC only accepts slaves after the media is started, and a later mount must not
    // add the tracks that are already attached.
    val mountedSubtitles = remember(player) { mutableSetOf<String>() }
    LaunchedEffect(player, started, subtitles) {
        if (!started || disposed.get()) return@LaunchedEffect
        for (subtitle in subtitles) {
            if (disposed.get()) return@LaunchedEffect
            if (!mountedSubtitles.add(subtitle.absolutePath)) continue
            // libvlc_media_slave_type_subtitle is the first enum value, so its ABI value is 0.
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

    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        if (audioOnly) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text(if (playing) "音频正在播放" else "音频 · 点击播放 / 暂停")
            }
        } else {
            AndroidView(
                factory = { viewContext -> VLCVideoLayout(viewContext) },
                update = { view ->
                    if (disposed.get() || boundView === view) return@AndroidView
                    if (boundView != null) {
                        // New view (rotation). Detach only — stop() drops the
                        // media, and a second setMedia is another native open.
                        runCatching { player.detachViews() }
                    }
                    // VideoPlayerActivity.startPlayback: attach the surface, then
                    // load the media. setMedia before the vout exists crashes.
                    player.attachViews(view, null, true, false)
                    if (!opened) {
                        val media = Media(engine, Uri.fromFile(file))
                        // :no-hw-dec. MediaCodec setup SIGSEGVs on open on a lot of
                        // devices; libavcodec inside libvlc is the RAW path.
                        media.setHWDecoderEnabled(false, false)
                        media.addOption(":file-caching=1500")
                        player.media = media
                        media.release()
                        opened = true
                    }
                    boundView = view
                },
                // Do not detachViews() here. VideoHelper.detachViews() calls
                // setVideoTrackEnabled(false) while the surface is still up, and
                // Compose recreates this view on rotation and parent relayout.
                // The player DisposableEffect below stops first, then detaches,
                // then releases — that is the only order libvlc 3.6 survives.
                modifier = Modifier.weight(1f).fillMaxWidth(),
            )
        }
        failure?.let { Text(it, modifier = Modifier.padding(8.dp)) }
        Row(Modifier.horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = {
                if (disposed.get()) return@TextButton
                if (playing) { player.pause(); playing = false }
                else {
                    if (audioOnly && !opened) {
                        val media = Media(engine, Uri.fromFile(file))
                        media.setHWDecoderEnabled(false, false)
                        media.addOption(":file-caching=1500")
                        player.media = media
                        media.release()
                        opened = true
                    }
                    if (!opened) return@TextButton
                    if (ended) { player.stop(); ended = false }
                    player.play(); started = true
                }
            }) { Text(if (playing) "暂停" else "播放") }
            TextButton(onClick = { if (!disposed.get()) player.setTime((position - 10_000).coerceAtLeast(0L)) }, enabled = seekable) { Text("−10秒") }
            TextButton(onClick = { if (!disposed.get()) player.setTime((position + 10_000).coerceAtMost(duration)) }, enabled = seekable) { Text("+10秒") }
            TextButton(onClick = { repeat = !repeat }) { Text(if (repeat) "循环：开" else "循环：关") }
            TextButton(onClick = {
                speed = when (speed) { 0.5f -> 0.75f; 0.75f -> 1f; 1f -> 1.25f; 1.25f -> 1.5f; 1.5f -> 2f; else -> 0.5f }
                if (!disposed.get()) player.rate = speed
            }) { Text("${speed}×") }
            Box {
                TextButton(onClick = { audioMenu = true }) { Text("音轨") }
                DropdownMenu(expanded = audioMenu, onDismissRequest = { audioMenu = false }) {
                    audioTracks.forEach { track ->
                        DropdownMenuItem({ Text(track.name ?: "音轨 ${track.id}") }, {
                            if (disposed.get() || !player.setAudioTrack(track.id)) latestMessage("音轨切换失败")
                            audioMenu = false
                        })
                    }
                }
            }
            Box {
                TextButton(onClick = { subtitleMenu = true }) { Text("字幕") }
                DropdownMenu(expanded = subtitleMenu, onDismissRequest = { subtitleMenu = false }) {
                    DropdownMenuItem({ Text("关闭字幕") }, { if (!disposed.get()) player.setSpuTrack(-1); subtitleMenu = false })
                    subtitleTracks.filter { it.id >= 0 }.forEach { track ->
                        DropdownMenuItem({ Text(track.name ?: "字幕 ${track.id}") }, {
                            if (disposed.get() || !player.setSpuTrack(track.id)) latestMessage("字幕切换失败")
                            subtitleMenu = false
                        })
                    }
                }
            }
        }
        Row(Modifier.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(clock(position))
            Slider(
                fraction = if (duration > 0) position.toFloat() / duration else 0f,
                enabled = duration > 0L && seekable,
                onChange = { if (duration > 0 && !disposed.get()) { position = (it * duration).toLong(); player.setTime(position) } },
                modifier = Modifier.weight(1f),
            )
            Text(clock(duration))
        }
        Row(Modifier.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = {
                if (disposed.get()) return@TextButton
                volume = if (volume == 0f) 100f else 0f
                player.setVolume(volume.toInt())
            }) {
                Text(if (volume == 0f) "取消静音" else "静音")
            }
            Slider(
                fraction = volume / 100f,
                enabled = true,
                onChange = { volume = it * 100f; if (!disposed.get()) player.setVolume(volume.toInt()) },
                modifier = Modifier.weight(1f),
            )
            Text("${volume.toInt()}%")
        }
    }
}

@Composable
private fun Slider(fraction: Float, enabled: Boolean, onChange: (Float) -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier.fillMaxWidth().height(32.dp).pointerInput(enabled) {
            if (!enabled) return@pointerInput
            detectHorizontalDragGestures { change, _ ->
                change.consume()
                onChange((change.position.x / size.width).coerceIn(0f, 1f))
            }
        },
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(Modifier.fillMaxWidth().height(4.dp).background(Color.Gray.copy(alpha = 0.4f)))
        Box(Modifier.fillMaxWidth(fraction.coerceIn(0f, 1f)).height(4.dp).background(Color.White))
    }
}

private fun clock(milliseconds: Long): String {
    val seconds = milliseconds / 1000
    return if (seconds >= 3600) "%d:%02d:%02d".format(seconds / 3600, seconds / 60 % 60, seconds % 60)
    else "%d:%02d".format(seconds / 60, seconds % 60)
}
