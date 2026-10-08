package one.zephyr.mobile.feature.notes

import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay
import one.zephyr.mobile.ui.component.*
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.util.VLCVideoLayout
import java.io.File

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
    val main = remember { Handler(Looper.getMainLooper()) }
    val engine = remember(file) { LibVLC(context, arrayListOf("--no-video-title-show", "--network-caching=1200")) }
    val player = remember(engine) { MediaPlayer(engine) }
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
    var audioMenu by remember { mutableStateOf(false) }
    var subtitleMenu by remember { mutableStateOf(false) }
    var disposed by remember(player) { mutableStateOf(false) }
    val latestMessage by rememberUpdatedState(onMessage)
    val latestRepeat by rememberUpdatedState(repeat)

    DisposableEffect(player) {
        player.setEventListener { event ->
            main.post {
                if (!disposed) when (event.type) {
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
        val media = Media(engine, Uri.fromFile(file))
        // A failing hardware codec can fall back to libavcodec on the device.
        media.setHWDecoderEnabled(true, false)
        player.media = media
        media.release()
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) { player.pause(); playing = false }
        }
        lifecycle.addObserver(observer)
        onDispose {
            disposed = true
            lifecycle.removeObserver(observer)
            player.setEventListener(null)
            player.stop()
            player.detachViews()
            player.release()
            engine.release()
        }
    }
    LaunchedEffect(player) {
        while (true) {
            position = player.time.coerceAtLeast(0L)
            duration = player.length.coerceAtLeast(0L)
            delay(250)
        }
    }
    // External VTT/SRT/ASS/SSA/MicroDVD .sub are decoded natively, including ASS styling.
    // LibVLC only accepts slaves after the media is started, and a later mount must not
    // add the tracks that are already attached.
    val mountedSubtitles = remember(player) { mutableSetOf<String>() }
    LaunchedEffect(player, started, subtitles) {
        if (!started) return@LaunchedEffect
        for (file in subtitles) {
            if (!mountedSubtitles.add(file.absolutePath)) continue
            if (!player.addSlave(Media.Slave.Type.Subtitle, Uri.fromFile(file), true)) {
                mountedSubtitles.remove(file.absolutePath)
                latestMessage("无法挂载字幕 ${file.name}")
            }
        }
        trackRevision++
    }
    val audioTracks = remember(player, trackRevision) { player.audioTracks?.toList().orEmpty() }
    val subtitleTracks = remember(player, trackRevision) { player.spuTracks?.toList().orEmpty() }

    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        if (audioOnly) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text(if (playing) "音频正在播放" else "音频 · 点击播放 / 暂停")
            }
        } else {
            AndroidView(
                factory = { VLCVideoLayout(it).also { view -> player.attachViews(view, null, true, false) } },
                modifier = Modifier.weight(1f).fillMaxWidth(),
            )
        }
        failure?.let { Text(it, modifier = Modifier.padding(8.dp)) }
        Row(Modifier.horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = {
                if (playing) { player.pause(); playing = false }
                else {
                    if (ended) { player.stop(); ended = false }
                    player.play(); started = true
                }
            }) { Text(if (playing) "暂停" else "播放") }
            TextButton(onClick = { player.setTime((position - 10_000).coerceAtLeast(0L)) }, enabled = player.isSeekable) { Text("−10秒") }
            TextButton(onClick = { player.setTime((position + 10_000).coerceAtMost(duration)) }, enabled = player.isSeekable) { Text("+10秒") }
            TextButton(onClick = { repeat = !repeat }) { Text(if (repeat) "循环：开" else "循环：关") }
            TextButton(onClick = {
                speed = when (speed) { 0.5f -> 0.75f; 0.75f -> 1f; 1f -> 1.25f; 1.25f -> 1.5f; 1.5f -> 2f; else -> 0.5f }
                player.rate = speed
            }) { Text("${speed}×") }
            Box {
                TextButton(onClick = { audioMenu = true }) { Text("音轨") }
                DropdownMenu(expanded = audioMenu, onDismissRequest = { audioMenu = false }) {
                    audioTracks.forEach { track ->
                        DropdownMenuItem({ Text(track.name ?: "音轨 ${track.id}") }, {
                            if (!player.setAudioTrack(track.id)) latestMessage("音轨切换失败")
                            audioMenu = false
                        })
                    }
                }
            }
            Box {
                TextButton(onClick = { subtitleMenu = true }) { Text("字幕") }
                DropdownMenu(expanded = subtitleMenu, onDismissRequest = { subtitleMenu = false }) {
                    DropdownMenuItem({ Text("关闭字幕") }, { player.setSpuTrack(-1); subtitleMenu = false })
                    subtitleTracks.filter { it.id >= 0 }.forEach { track ->
                        DropdownMenuItem({ Text(track.name ?: "字幕 ${track.id}") }, {
                            if (!player.setSpuTrack(track.id)) latestMessage("字幕切换失败")
                            subtitleMenu = false
                        })
                    }
                }
            }
        }
        Row(Modifier.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(clock(position))
            androidx.compose.material3.Slider(
                value = if (duration > 0) position.toFloat() / duration else 0f,
                onValueChange = { if (duration > 0) { position = (it * duration).toLong(); player.setTime(position) } },
                enabled = duration > 0L && player.isSeekable,
                modifier = Modifier.weight(1f),
            )
            Text(clock(duration))
        }
        Row(Modifier.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { volume = if (volume == 0f) 100f else 0f; player.setVolume(volume.toInt()) }) {
                Text(if (volume == 0f) "取消静音" else "静音")
            }
            androidx.compose.material3.Slider(value = volume, onValueChange = { volume = it; player.setVolume(it.toInt()) }, valueRange = 0f..100f, modifier = Modifier.weight(1f))
            Text("${volume.toInt()}%")
        }
    }
}

private fun clock(milliseconds: Long): String {
    val seconds = milliseconds / 1000
    return if (seconds >= 3600) "%d:%02d:%02d".format(seconds / 3600, seconds / 60 % 60, seconds % 60)
    else "%d:%02d".format(seconds / 60, seconds % 60)
}
