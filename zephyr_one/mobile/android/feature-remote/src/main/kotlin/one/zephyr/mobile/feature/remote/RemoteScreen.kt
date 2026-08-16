@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package one.zephyr.mobile.feature.remote

import one.zephyr.mobile.ui.icon.ZephyrIcons
import one.zephyr.mobile.ui.theme.ZephyrTextStyles

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import one.zephyr.mobile.ui.component.AlertDialog
import one.zephyr.mobile.ui.component.AlertDialogLayout
import one.zephyr.mobile.ui.component.CircularProgressIndicator
import androidx.compose.ui.text.style.TextAlign
import one.zephyr.mobile.ui.component.FilterChip
import one.zephyr.mobile.ui.component.Icon
import one.zephyr.mobile.ui.component.IconButton
import one.zephyr.mobile.ui.component.OutlinedTextField
import one.zephyr.mobile.ui.component.Slider
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.component.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlin.math.roundToInt
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.RdpSoundMode
import one.zephyr.mobile.protocol.rdp.RdpDriveResolution
import one.zephyr.mobile.ui.format.RelativeTime
import one.zephyr.mobile.ui.theme.IslandSpec
import one.zephyr.mobile.ui.theme.ZephyrRadius
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme

/**
 * S22 RDP and S23 VNC.
 *
 * One screen for both protocols. REMOTE_DESKTOP_EXPERIENCE.md 3 gives them the same layout - a
 * full-bleed framebuffer, an auto-hiding status pill and one bottom dock - and SCREEN_CATALOG.md 9
 * and 10 differ only in which dock entries exist, which [RemoteDockItem.forProtocol] already
 * decides. Writing it twice would mean maintaining the viewport, the gestures and the chrome twice.
 *
 * Stateless apart from which panel is open: everything else arrives in [RemoteContent] and leaves as
 * a [RemoteIntent], so a Compose test can drive every state without an engine. The one exception is
 * [controller], which [RemoteSurface] needs directly - see [RemoteIntent] for why.
 *
 * @param remoteTitle the desktop name the far side reported, when it reported one. VNC only.
 */
@Composable
fun RemoteScreen(
    state: PageState<RemoteContent>,
    controller: RemoteSessionController,
    nowMs: Long,
    online: Boolean,
    onIntent: (RemoteIntent) -> Unit,
    modifier: Modifier = Modifier,
    remoteTitle: String? = null,
) {
    PageStateScaffoldHost(state = state, modifier = modifier, onIntent = onIntent) { content ->
        RemoteSession(
            content = content,
            controller = controller,
            nowMs = nowMs,
            online = online,
            remoteTitle = remoteTitle,
            onIntent = onIntent,
        )
    }
}

/**
 * The nine [PageState] branches, with retry wired to a reconnect.
 *
 * Wrapped rather than inlined so the immersive body below never has to know that eight of the nine
 * branches exist: a screen that draws a framebuffer and a screen that says "已失去使用权限" have
 * nothing in common except the route that reaches them.
 */
@Composable
private fun PageStateScaffoldHost(
    state: PageState<RemoteContent>,
    modifier: Modifier,
    onIntent: (RemoteIntent) -> Unit,
    content: @Composable (RemoteContent) -> Unit,
) {
    one.zephyr.mobile.ui.state.PageStateScaffold(
        state = state,
        modifier = modifier,
        onRetry = { onIntent(RemoteIntent.Reconnect) },
        content = content,
    )
}

/** Which bottom panel is open. Local, because it is not a fact about the session. */
private enum class RemotePanel {
    DISPLAY,
    POINTER,
    CLIPBOARD,
    SOUND,
    CHANNELS,
    DRIVE,
    CERTIFICATE,
    QUALITY,
    SHORTCUTS,
    DISCONNECT,
}

@Composable
private fun RemoteSession(
    content: RemoteContent,
    controller: RemoteSessionController,
    nowMs: Long,
    online: Boolean,
    remoteTitle: String?,
    onIntent: (RemoteIntent) -> Unit,
) {
    val chrome = content.surface.chrome
    var panel by remember { mutableStateOf<RemotePanel?>(null) }
    var imeView by remember { mutableStateOf<RemoteImeView?>(null) }
    var ripple by remember { mutableStateOf<RemoteGestureSignal.ClickRipple?>(null) }

    // Demo resetHide: the tools panel closes after five idle seconds.
    LaunchedEffect(chrome.mayAutoHide, content.status.phase, panel) {
        if (!chrome.mayAutoHide || panel != null || !content.status.hasSurface) return@LaunchedEffect
        delay(RemoteChrome.AUTO_HIDE_MS)
        onIntent(RemoteIntent.HideChrome)
    }

    LaunchedEffect(controller) {
        controller.gestureSignals.collect { signal ->
            if (signal is RemoteGestureSignal.ClickRipple) ripple = signal
        }
    }

    // Driven from state rather than toggled blind, so a dock tap and a tap on the surface cannot
    // leave the flag and the real IME disagreeing.
    LaunchedEffect(chrome.keyboardVisible, imeView) {
        imeView?.setKeyboardVisible(chrome.keyboardVisible)
    }

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        RemoteSurface(
            controller = controller,
            modifier = Modifier.fillMaxSize(),
        )

        when {
            !content.engineAvailable -> EngineBlockedOverlay(content.connection.protocol)
            content.status.phase.isProgressing -> PhaseOverlay(content = content, nowMs = nowMs)
            content.transport == one.zephyr.mobile.data.session.SessionTransport.CLOSED -> Unit
            !content.status.hasSurface -> DisconnectedOverlay(content = content, onIntent = onIntent)
            else -> Unit
        }

        // Demo `disc-yes` pops the page. A user-ended session is CLOSED, not a retryable overlay.
        LaunchedEffect(content.transport) {
            if (content.transport == one.zephyr.mobile.data.session.SessionTransport.CLOSED) {
                onIntent(RemoteIntent.Back)
            }
        }

        // Section 8: a live mic or camera stays visible for the whole session, independently of the
        // chrome. Not inside the auto-hiding layer on purpose.
        if (content.captureLabels.isNotEmpty()) {
            CaptureIndicator(
                labels = content.captureLabels,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .statusBarsPadding()
                    .padding(ZephyrSpacing.sm),
            )
        }

        ChromeLayer(
            visible = chrome.statusPillVisible,
            fromTop = true,
            modifier = Modifier
                .align(Alignment.TopStart)
                .statusBarsPadding()
                .padding(start = 10.dp, top = 10.dp),
        ) {
            StatusPill(
                content = content,
                nowMs = nowMs,
                online = online,
                remoteTitle = remoteTitle,
                onIntent = onIntent,
            )
        }

        ChromeLayer(
            visible = chrome.dockVisible,
            fromTop = true,
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = 8.dp, vertical = 8.dp),
        ) {
            ToolsPanel(
                items = content.dock,
                content = content,
                onOpenPanel = { target -> panel = target },
                onIntent = onIntent,
            )
        }

        DraggableToolsOrb(
            stateKey = content.connection.id,
            label = stringResource(R.string.remote_tools),
            onClick = { onIntent(RemoteIntent.ToggleToolsPanel) },
        )

        if (content.surface.pointer.mode == RemotePointerMode.TRACKPAD) {
            Row(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .navigationBarsPadding()
                    .padding(end = 10.dp, bottom = 14.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                TrackpadButton(
                    label = stringResource(R.string.remote_mouse_left),
                    onClick = { onIntent(RemoteIntent.TrackpadClick(RemoteButton.PRIMARY)) },
                )
                TrackpadButton(
                    label = stringResource(R.string.remote_mouse_right),
                    onClick = { onIntent(RemoteIntent.TrackpadClick(RemoteButton.SECONDARY)) },
                )
            }
        }

        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .imePadding()
                .navigationBarsPadding(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            ChromeLayer(visible = chrome.modifierBarVisible, fromTop = false) {
                ModifierBarRow(latches = content.surface.latches, onIntent = onIntent)
            }
        }

        IconButton(
            onClick = { onIntent(RemoteIntent.Back) },
            modifier = Modifier
                .align(Alignment.BottomStart)
                .navigationBarsPadding()
                .padding(start = 10.dp, bottom = 14.dp)
                .size(40.dp)
                .background(Color(0x990C0E12), androidx.compose.foundation.shape.CircleShape),
        ) {
            Icon(
                imageVector = ZephyrIcons.Back,
                contentDescription = stringResource(R.string.remote_back),
                tint = Color(0xFFDBE2EA),
            )
        }

        ripple?.let { mark ->
            ClickRipple(
                mark = mark,
                onFinished = { if (ripple == mark) ripple = null },
            )
        }

        // Zero-sized: it owns the InputConnection and nothing else. Inside the same window as the
        // surface it types into, which is what keeps a CJK commit going to this session.
        AndroidView(
            factory = { context ->
                RemoteImeView(context).also { created ->
                    created.onIntent = onIntent
                    created.onHardwareKey = controller::onHardwareKey
                    imeView = created
                }
            },
            modifier = Modifier.size(1.dp).align(Alignment.TopStart),
            update = { view ->
                view.onIntent = onIntent
                view.onHardwareKey = controller::onHardwareKey
            },
        )

        panel?.let { open ->
            PanelHost(
                panel = open,
                content = content,
                onClose = { panel = null },
                onIntent = onIntent,
            )
        }
    }

    // Blocking prompts, over everything including a panel: section 10 forbids a changed certificate
    // from being dismissed by a toast, and an auth prompt is the only thing that can continue.
    content.certificatePrompt?.let { prompt ->
        CertificateDialog(prompt = prompt, onIntent = onIntent)
    }
    content.authPrompt?.let { prompt ->
        AuthDialog(prompt = prompt, warning = content.securityWarning, onIntent = onIntent)
    }
    content.clipboardPrompt?.let { offer ->
        ClipboardDialog(offer = offer, onIntent = onIntent)
    }
}


// ---- chrome --------------------------------------------------------------------------------------

/**
 * Opacity plus a small offset, per section 12.
 *
 * Never a scale: scaling the chrome would resample nothing, but scaling anything that overlaps the
 * framebuffer invites the same treatment for the surface, and the frozen rule is that chrome never
 * changes the remote coordinate system. Reduce Motion drops the translation and keeps the crossfade.
 */
@Composable
private fun ChromeLayer(
    visible: Boolean,
    fromTop: Boolean,
    modifier: Modifier = Modifier,
    body: @Composable () -> Unit,
) {
    val motion = ZephyrTheme.motion
    val progress by animateFloatAsState(
        targetValue = if (visible) 1f else 0f,
        animationSpec = tween(durationMillis = motion.scale(RemoteChrome.FADE_MS)),
        label = "remoteChromeFade",
    )
    if (progress <= 0.01f) return
    val travel = if (motion.reduceMotion) 0.dp else RemoteChrome.OFFSET_DP.dp * (1f - progress)
    Box(
        modifier = modifier
            .offset(y = if (fromTop) -travel else travel)
            .alpha(progress),
    ) {
        body()
    }
}

/**
 * The only gesture entry point for the tools strip.
 *
 * A short tap toggles the strip. Moving the orb is deliberately gated behind the platform long-press
 * threshold: ordinary desktop gestures that begin near it cannot accidentally relocate it. Once
 * armed, movement tracks the finger 1:1 and clamps to the safe drawing area. A completed drag never
 * falls through to [onClick].
 */
@Composable
private fun DraggableToolsOrb(
    stateKey: String,
    label: String,
    onClick: () -> Unit,
) {
    val density = LocalDensity.current
    val layoutDirection = androidx.compose.ui.platform.LocalLayoutDirection.current
    val haptics = LocalHapticFeedback.current
    val currentOnClick by rememberUpdatedState(onClick)
    val safeDrawing = WindowInsets.safeDrawing
    val orbSizePx = with(density) { 44.dp.toPx() }
    val marginPx = with(density) { 10.dp.toPx() }
    var viewportWidthPx by remember { mutableIntStateOf(0) }
    var viewportHeightPx by remember { mutableIntStateOf(0) }
    var savedX by rememberSaveable(stateKey) { mutableStateOf<Float?>(null) }
    var savedY by rememberSaveable(stateKey) { mutableStateOf<Float?>(null) }
    var dragging by remember { mutableStateOf(false) }

    val bounds = RemoteToolsOrbGeometry.bounds(
        viewportWidthPx = viewportWidthPx,
        viewportHeightPx = viewportHeightPx,
        orbSizePx = orbSizePx,
        marginPx = marginPx,
        insetLeftPx = safeDrawing.getLeft(density, layoutDirection),
        insetTopPx = safeDrawing.getTop(density),
        insetRightPx = safeDrawing.getRight(density, layoutDirection),
        insetBottomPx = safeDrawing.getBottom(density),
    )
    val position = RemoteToolsOrbGeometry.clamp(
        if (savedX == null || savedY == null) {
            RemoteToolsOrbGeometry.initial(bounds)
        } else {
            RemoteToolsOrbPosition(savedX!!, savedY!!)
        },
        bounds,
    )

    // Rotation and system-bar changes can shrink the safe region while the orb sits at an old edge.
    LaunchedEffect(bounds, viewportWidthPx, viewportHeightPx) {
        if (viewportWidthPx <= 0 || viewportHeightPx <= 0) return@LaunchedEffect
        savedX = position.x
        savedY = position.y
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .onSizeChanged { size ->
                viewportWidthPx = size.width
                viewportHeightPx = size.height
            },
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .offset { IntOffset(position.x.roundToInt(), position.y.roundToInt()) }
                .size(44.dp)
                .graphicsLayer {
                    val pressedScale = if (dragging) 1.06f else 1f
                    scaleX = pressedScale
                    scaleY = pressedScale
                }
                .background(Color(0x9E14181E), androidx.compose.foundation.shape.CircleShape)
                .border(1.dp, Color(0x24FFFFFF), androidx.compose.foundation.shape.CircleShape)
                .semantics {
                    contentDescription = label
                    role = Role.Button
                    onClick(label = label) {
                        currentOnClick()
                        true
                    }
                }
                .pointerInput(bounds) {
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        var lastPosition = down.position
                        var lastUptime = down.uptimeMillis
                        var travelPx = 0f
                        var released = false
                        var movedBeforeLongPress = false

                        val endedEarly = withTimeoutOrNull(RemoteToolsOrbGesture.LONG_PRESS_MS) {
                            while (true) {
                                val event = awaitPointerEvent()
                                val change = event.changes.firstOrNull { it.id == down.id }
                                    ?: return@withTimeoutOrNull true
                                lastUptime = change.uptimeMillis
                                val delta = change.position - lastPosition
                                lastPosition = change.position
                                travelPx += delta.getDistance()
                                if (!change.pressed) {
                                    released = true
                                    return@withTimeoutOrNull true
                                }
                                if (travelPx > RemoteToolsOrbGesture.TAP_SLOP_PX) {
                                    movedBeforeLongPress = true
                                    return@withTimeoutOrNull true
                                }
                            }
                        }

                        if (endedEarly != null) {
                            if (released && !movedBeforeLongPress && RemoteToolsOrbGesture.isTap(
                                    elapsedMs = lastUptime - down.uptimeMillis,
                                    travelPx = travelPx,
                                )
                            ) {
                                currentOnClick()
                            }
                            return@awaitEachGesture
                        }

                        dragging = true
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        try {
                            while (true) {
                                val event = awaitPointerEvent()
                                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                if (!change.pressed) break
                                val delta = change.positionChange()
                                lastPosition = change.position
                                val next = RemoteToolsOrbGeometry.move(
                                    position = RemoteToolsOrbPosition(savedX ?: position.x, savedY ?: position.y),
                                    dxPx = delta.x,
                                    dyPx = delta.y,
                                    bounds = bounds,
                                )
                                savedX = next.x
                                savedY = next.y
                                change.consume()
                            }
                        } finally {
                            dragging = false
                        }
                    }
                },
        ) {
            Icon(
                imageVector = ZephyrIcons.GridTools,
                contentDescription = null,
                tint = Color(0xFFE6EBF0),
            )
        }
    }
}

/**
 * The top status pill.
 *
 * Carries what section 3 freezes - name, network/quality, input mode - plus the phase and its elapsed
 * time, which section 13 requires to be visible per phase rather than as one spinner.
 */
@Composable
private fun StatusPill(
    content: RemoteContent,
    nowMs: Long,
    online: Boolean,
    remoteTitle: String?,
    onIntent: (RemoteIntent) -> Unit,
) {
    val palette = ZephyrTheme.palette
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .background(Color(0x990C0E12), RoundedCornerShape(16.dp))
            .padding(horizontal = 11.dp, vertical = 6.dp)
            .semantics { liveRegion = LiveRegionMode.Polite }
            .clickable { onIntent(RemoteIntent.Minimise) },
    ) {
        Box(
            modifier = Modifier
                .size(9.dp)
                .background(phaseColour(content.status.phase), androidx.compose.foundation.shape.CircleShape),
        )
        Spacer(modifier = Modifier.width(7.dp))
        Text(
            text = compactStatus(content, nowMs, online, remoteTitle),
            style = ZephyrTheme.typography.monoCaption,
            color = Color(0xFFDBE2EA),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun compactStatus(
    content: RemoteContent,
    nowMs: Long,
    online: Boolean,
    remoteTitle: String?,
): String {
    if (content.status.phase.isProgressing || !content.status.hasSurface) {
        return phaseText(content.status, nowMs)
    }
    val size = if (content.status.remoteWidthPx > 0) {
        content.status.remoteWidthPx.toString() + "×" + content.status.remoteHeightPx
    } else {
        DASH
    }
    val third = if (content.connection.protocol == Protocol.VNC) {
        content.pixelFormatLabel
    } else {
        content.status.fps?.let { it.toString() + "FPS" } ?: content.fpsLabel
    }
    val parts = mutableListOf(
        VncDemoStatus.latencyLabel(content.status.latencyMs),
        size,
        third ?: DASH,
    )
    if (!online) parts += stringResource(R.string.remote_offline)
    if (content.viewOnly) parts += stringResource(R.string.remote_view_only)
    if (content.connection.protocol != Protocol.VNC) remoteTitle?.let { parts += it }
    return parts.joinToString(" · ")
}

/** Demo `#rdp-panel`: a top floating strip of labelled tools. */
@Composable
private fun ToolsPanel(
    items: List<RemoteDockItem>,
    content: RemoteContent,
    onOpenPanel: (RemotePanel) -> Unit,
    onIntent: (RemoteIntent) -> Unit,
) {
    Row(
        modifier = Modifier
            .background(Color(0xC712161C), RoundedCornerShape(18.dp))
            .border(1.dp, Color(0x1AFFFFFF), RoundedCornerShape(18.dp))
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 6.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        for (item in items) {
            ToolButton(
                item = item,
                content = content,
                selected = isDockSelected(item, content),
                onClick = { dispatchDock(item, content, onOpenPanel, onIntent) },
            )
        }
    }
}

@Composable
private fun ToolButton(
    item: RemoteDockItem,
    content: RemoteContent,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val palette = ZephyrTheme.palette
    val tint = when {
        item == RemoteDockItem.DISCONNECT -> Color(0xFFFF7B72)
        selected -> palette.brand.accent
        else -> Color(0xFFC3CCD6)
    }
    val label = toolCaption(item, content)
    Column(
        modifier = Modifier
            .width(56.dp)
            .clickable(onClick = onClick)
            .padding(vertical = 6.dp, horizontal = 4.dp)
            .semantics { contentDescription = label },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Icon(imageVector = dockIcon(item), contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
        Text(
            text = label,
            style = ZephyrTheme.typography.caption,
            color = tint,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun toolCaption(item: RemoteDockItem, content: RemoteContent): String = when (item) {
    RemoteDockItem.POINTER_MODE -> stringResource(
        if (content.surface.pointer.mode == RemotePointerMode.TRACKPAD) {
            R.string.remote_pointer_direct
        } else {
            R.string.remote_pointer_trackpad
        },
    )
    RemoteDockItem.QUALITY -> content.qualityLabel
    RemoteDockItem.RESOLUTION -> content.resolutionLabel
    RemoteDockItem.FPS -> content.fpsLabel
    RemoteDockItem.ZOOM -> content.zoomLabel
    RemoteDockItem.VNC_QUALITY -> content.pixelFormatLabel ?: stringResource(R.string.remote_quality)
    else -> stringResource(dockLabel(item))
}

@Composable
private fun TrackpadButton(label: String, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .height(42.dp)
            .background(Color(0xB812161C), RoundedCornerShape(12.dp))
            .border(1.dp, Color(0x24FFFFFF), RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = label, style = ZephyrTheme.typography.caption, color = Color(0xFFDBE2EA))
    }
}

@Composable
private fun ClickRipple(mark: RemoteGestureSignal.ClickRipple, onFinished: () -> Unit) {
    var started by remember(mark) { mutableStateOf(false) }
    val progress by animateFloatAsState(
        targetValue = if (started) 1f else 0f,
        animationSpec = tween(durationMillis = 320),
        finishedListener = { onFinished() },
        label = "rdpClickRipple",
    )
    LaunchedEffect(mark) { started = true }
    val density = androidx.compose.ui.platform.LocalDensity.current
    Box(
        modifier = Modifier
            .offset(
                x = with(density) { mark.xPx.toDp() } - 17.dp,
                y = with(density) { mark.yPx.toDp() } - 17.dp,
            )
            .size(34.dp)
            .graphicsLayer {
                scaleX = 0.35f + progress * 1.15f
                scaleY = 0.35f + progress * 1.15f
                alpha = 0.95f * (1f - progress)
            }
            .border(
                2.dp,
                if (mark.secondary) Color(0xFFFFD60A) else Color(0xE6FFFFFF),
                androidx.compose.foundation.shape.CircleShape,
            ),
    )
}

/**
 * The one-row modifier bar above the IME.
 *
 * Latched modifiers are shown as selected because section 6 requires the mapping to be visible: an
 * invisible latched Ctrl is indistinguishable from a stuck one, and the next keystroke would be a
 * shortcut the user did not ask for.
 */
@Composable
private fun ModifierBarRow(latches: RemoteModifierLatches, onIntent: (RemoteIntent) -> Unit) {
    val palette = ZephyrTheme.palette
    Row(
        modifier = Modifier
            .padding(horizontal = ZephyrSpacing.sm)
            .background(palette.surfaces.elevated, RoundedCornerShape(ZephyrRadius.md))
            .horizontalScroll(rememberScrollState())
            .padding(ZephyrSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.xs),
    ) {
        for (modifier in RemoteModifierBar.modifiers) {
            val latched = modifier in latches.active
            KeyCap(
                text = modifier.label,
                selected = latched,
                onClick = { onIntent(RemoteIntent.ModifierTap(modifier)) },
            )
        }
        Spacer(modifier = Modifier.width(ZephyrSpacing.xs))
        for (key in RemoteModifierBar.keys) {
            KeyCap(
                text = labelOf(key),
                selected = false,
                onClick = { onIntent(RemoteIntent.Key(key)) },
            )
        }
    }
}

@Composable
private fun KeyCap(text: String, selected: Boolean, onClick: () -> Unit) {
    val palette = ZephyrTheme.palette
    Box(
        modifier = Modifier
            .height(IslandTouchTarget)
            .background(
                if (selected) palette.brand.accent else palette.surfaces.content,
                RoundedCornerShape(ZephyrRadius.sm),
            )
            .clickable(onClick = onClick)
            .padding(horizontal = ZephyrSpacing.md),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            style = ZephyrTheme.typography.mono,
            color = if (selected) palette.onIslandSelection else palette.onBackground,
        )
    }
}

/** Section 8: a persistent indicator while a capture channel is live. */
@Composable
private fun CaptureIndicator(labels: List<String>, modifier: Modifier = Modifier) {
    val palette = ZephyrTheme.palette
    Row(
        modifier = modifier
            .background(palette.status.error, RoundedCornerShape(ZephyrRadius.pill))
            .padding(horizontal = ZephyrSpacing.sm, vertical = ZephyrSpacing.xs)
            .semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = ZephyrIcons.Mic,
            contentDescription = null,
            tint = Color.White,
            modifier = Modifier.size(14.dp),
        )
        Spacer(modifier = Modifier.width(ZephyrSpacing.xs))
        Text(
            text = stringResource(R.string.remote_capture_active, labels.joinToString("、")),
            style = ZephyrTheme.typography.caption,
            color = Color.White,
        )
    }
}

// ---- overlays ------------------------------------------------------------------------------------

/**
 * The engine is not in the build.
 *
 * Stated rather than shown as a connection failure: ADR-004 and ADR-005 leave the native cores
 * pending a licence and packaging decision, and reporting that as "连接失败" would send the user
 * looking for a network problem that does not exist.
 */
@Composable
private fun EngineBlockedOverlay(protocol: Protocol) {
    val message = stringResource(
        if (protocol == Protocol.RDP) R.string.remote_engine_blocked_rdp else R.string.remote_engine_blocked_vnc,
    )

    CentredOverlay {
        Icon(
            imageVector = ZephyrIcons.Lock,
            contentDescription = null,
            tint = ZephyrTheme.palette.status.warning,
        )
        Spacer(modifier = Modifier.height(ZephyrSpacing.sm))
        Text(
            text = message,
            style = ZephyrTextStyles.body,
            color = Color.White,
        )
    }
}

/** A phase that is still making progress, with its elapsed time (section 13). */
@Composable
private fun PhaseOverlay(content: RemoteContent, nowMs: Long) {
    CentredOverlay {
        CircularProgressIndicator(color = ZephyrTheme.palette.brand.accent)
        Spacer(modifier = Modifier.height(ZephyrSpacing.md))
        Text(
            text = phaseText(content.status, nowMs),
            style = ZephyrTextStyles.body,
            color = Color.White,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
        if (content.status.attempt > 0) {
            Text(
                text = stringResource(R.string.remote_attempt, content.status.attempt),
                style = ZephyrTheme.typography.caption,
                color = Color.White,
            )
        }
    }
}

/**
 * Not connected.
 *
 * Offers connect or reconnect on the same surface rather than navigating away, which is the section 12
 * rule that a retry updates in place. The error text is the specific one from the phase machine, so a
 * first-frame timeout does not read like a TCP failure.
 */
@Composable
private fun DisconnectedOverlay(content: RemoteContent, onIntent: (RemoteIntent) -> Unit) {
    val error = content.status.error
    CentredOverlay {
        Icon(
            imageVector = ZephyrIcons.Disconnect,
            contentDescription = null,
            tint = ZephyrTheme.palette.status.offline,
        )
        Spacer(modifier = Modifier.height(ZephyrSpacing.sm))
        Text(
            text = error?.message ?: stringResource(R.string.remote_not_connected),
            style = ZephyrTextStyles.body,
            color = Color.White,
        )
        error?.let { value ->
            Text(
                text = value.diagnosticText(),
                style = ZephyrTheme.typography.monoCaption,
                color = ZephyrTheme.palette.onFloatingMuted,
            )
        }
        Spacer(modifier = Modifier.height(ZephyrSpacing.md))
        TextButton(onClick = { onIntent(RemoteIntent.Connect) }) {
            Text(text = stringResource(R.string.remote_connect))
        }
        if (content.status.attempt > 0 || error != null) {
            TextButton(onClick = { onIntent(RemoteIntent.Reconnect) }) {
                Text(text = stringResource(R.string.remote_reconnect))
            }
        }
    }
}

@Composable
private fun CentredOverlay(body: @Composable () -> Unit) {
    Box(
        modifier = Modifier.fillMaxSize().background(ZephyrTheme.palette.surfaces.scrim),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) { body() }
    }
}


// ---- panels --------------------------------------------------------------------------------------

/**
 * One exhaustive when over [RemotePanel].
 *
 * Exhaustive on purpose: adding a dock entry that opens a panel fails to compile until the panel
 * exists, which is the same structural guarantee the intent hierarchy gives the actions.
 */
@Composable
private fun PanelHost(
    panel: RemotePanel,
    content: RemoteContent,
    onClose: () -> Unit,
    onIntent: (RemoteIntent) -> Unit,
) {
    when (panel) {
        RemotePanel.DISPLAY -> DisplayPanel(content = content, onClose = onClose, onIntent = onIntent)
        RemotePanel.POINTER -> PointerPanel(content = content, onClose = onClose, onIntent = onIntent)
        RemotePanel.CLIPBOARD -> ClipboardPanel(content = content, onClose = onClose, onIntent = onIntent)
        RemotePanel.SOUND -> SoundPanel(content = content, onClose = onClose)
        RemotePanel.CHANNELS -> ChannelsPanel(content = content, onClose = onClose, onIntent = onIntent)
        RemotePanel.DRIVE -> DrivePanel(content = content, onClose = onClose, onIntent = onIntent)
        RemotePanel.CERTIFICATE -> CertificatePanel(content = content, onClose = onClose)
        RemotePanel.QUALITY -> QualityPanel(content = content, onClose = onClose, onIntent = onIntent)
        RemotePanel.SHORTCUTS -> ShortcutsPanel(onClose = onClose, onIntent = onIntent)
        RemotePanel.DISCONNECT -> DisconnectPanel(onClose = onClose, onIntent = onIntent)
    }
}

/**
 * The shared panel container.
 *
 * An AlertDialog rather than a ModalBottomSheet to match the rest of the app, and because the frozen
 * requirement is that the panel follows the system back gesture - which a dialog does for free and a
 * hand-rolled sheet would have to reimplement.
 */
@Composable
private fun RemoteBottomPanel(
    title: String,
    onClose: () -> Unit,
    body: @Composable () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(text = title) },
        text = { Column { body() } },
        confirmButton = {
            TextButton(onClick = onClose) { Text(text = stringResource(R.string.remote_close)) }
        },
    )
}

/** Five viewport modes (section 4). DYNAMIC is RDP only: RFB cannot ask a server to resize. */
@Composable
private fun DisplayPanel(
    content: RemoteContent,
    onClose: () -> Unit,
    onIntent: (RemoteIntent) -> Unit,
) {
    val modes = RemoteViewportMode.entries.filter { mode ->
        mode != RemoteViewportMode.DYNAMIC || content.connection.protocol == Protocol.RDP
    }
    RemoteBottomPanel(title = stringResource(R.string.remote_display), onClose = onClose) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.xs)) {
            for (mode in modes) {
                FilterChip(
                    selected = content.surface.mode == mode,
                    onClick = { onIntent(RemoteIntent.ViewportMode(mode)) },
                    label = { Text(text = stringResource(viewportModeLabel(mode))) },
                )
            }
        }
        Spacer(modifier = Modifier.height(ZephyrSpacing.sm))
        Text(
            text = stringResource(
                R.string.remote_display_actual,
                content.status.remoteWidthPx.toString() + "x" + content.status.remoteHeightPx,
            ),
            style = ZephyrTheme.typography.monoCaption,
        )
        content.status.negotiatedLabel?.let { label ->
            Text(text = label, style = ZephyrTheme.typography.monoCaption)
        }
        Spacer(modifier = Modifier.height(ZephyrSpacing.sm))
        TextButton(onClick = { onIntent(RemoteIntent.FullRepaint) }) {
            Text(text = stringResource(R.string.remote_full_repaint))
        }
    }
}

/** Both touch modes plus the 0.5-2.5 sensitivity range from section 5.2. */
@Composable
private fun PointerPanel(
    content: RemoteContent,
    onClose: () -> Unit,
    onIntent: (RemoteIntent) -> Unit,
) {
    RemoteBottomPanel(title = stringResource(R.string.remote_pointer), onClose = onClose) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.xs)) {
            for (mode in RemotePointerMode.entries) {
                FilterChip(
                    selected = content.surface.pointer.mode == mode,
                    onClick = { onIntent(RemoteIntent.PointerMode(mode)) },
                    label = { Text(text = stringResource(pointerModeLabel(mode))) },
                )
            }
        }
        Spacer(modifier = Modifier.height(ZephyrSpacing.sm))
        Text(
            text = stringResource(R.string.remote_sensitivity, content.surface.sensitivity),
            style = ZephyrTheme.typography.caption,
        )
        Slider(
            value = content.surface.sensitivity,
            onValueChange = { value -> onIntent(RemoteIntent.Sensitivity(value)) },
            valueRange = RemotePointerAcceleration.MIN_SENSITIVITY..RemotePointerAcceleration.MAX_SENSITIVITY,
        )
        if (content.surface.pointer.dragLock || content.surface.pointer.hasButtonDown) {
            Text(
                text = stringResource(R.string.remote_button_held),
                style = ZephyrTheme.typography.caption,
                color = ZephyrTheme.palette.status.warning,
            )
            TextButton(onClick = { onIntent(RemoteIntent.ReleasePointer) }) {
                Text(text = stringResource(R.string.remote_release_pointer))
            }
        }
    }
}

/**
 * The clipboard bridge.
 *
 * Sending is an explicit button rather than an automatic mirror, and receiving is a confirmation
 * dialog: section 7 forbids reading or overwriting the system clipboard in the background in either
 * direction. The preview is never logged and the full text only exists while the prompt is up.
 */
@Composable
private fun ClipboardPanel(
    content: RemoteContent,
    onClose: () -> Unit,
    onIntent: (RemoteIntent) -> Unit,
) {
    val clipboard = LocalClipboardManager.current
    val enabled = content.connection.rdp.clipboard && content.connection.capabilities.canUse
    RemoteBottomPanel(title = stringResource(R.string.remote_clipboard), onClose = onClose) {
        if (!enabled) {
            Text(
                text = stringResource(R.string.remote_clipboard_disabled),
                style = ZephyrTheme.typography.caption,
                color = ZephyrTheme.palette.status.warning,
            )
            return@RemoteBottomPanel
        }
        Text(
            text = stringResource(R.string.remote_clipboard_hint),
            style = ZephyrTheme.typography.caption,
        )
        Spacer(modifier = Modifier.height(ZephyrSpacing.sm))
        TextButton(
            onClick = {
                val text = clipboard.getText()?.text
                if (!text.isNullOrEmpty()) {
                    onIntent(RemoteIntent.SendClipboardToRemote(text))
                    onClose()
                }
            },
        ) {
            Text(text = stringResource(R.string.remote_clipboard_send))
        }
    }
}

/**
 * Audio routing, read-only here.
 *
 * The mode is a property of the connection (RdpSettings.soundMode), so changing it belongs to S12
 * rather than to a session sheet: a session-local override would be a fourth state the connection
 * editor knows nothing about. Section 8 requires the real route to be shown, which is what this does.
 */
@Composable
private fun SoundPanel(content: RemoteContent, onClose: () -> Unit) {
    RemoteBottomPanel(title = stringResource(R.string.remote_sound), onClose = onClose) {
        Text(
            text = stringResource(soundModeLabel(content.connection.rdp.soundMode)),
            style = ZephyrTextStyles.body,
        )
        Spacer(modifier = Modifier.height(ZephyrSpacing.xs))
        Text(
            text = stringResource(R.string.remote_sound_where),
            style = ZephyrTheme.typography.caption,
            color = ZephyrTheme.palette.onFloatingMuted,
        )
    }
}

/**
 * Per-channel state.
 *
 * A denied channel is a row with an action, never a failed session (section 8). A permanent denial
 * offers Settings instead of a prompt the OS will no longer show.
 */
@Composable
private fun ChannelsPanel(
    content: RemoteContent,
    onClose: () -> Unit,
    onIntent: (RemoteIntent) -> Unit,
) {
    RemoteBottomPanel(title = stringResource(R.string.remote_channels), onClose = onClose) {
        for (row in content.channels) {
            ChannelRowView(row = row, onIntent = onIntent)
        }
        if (content.channels.isEmpty()) {
            Text(
                text = stringResource(R.string.remote_channels_none),
                style = ZephyrTheme.typography.caption,
            )
        }
    }
}

@Composable
private fun ChannelRowView(row: RemoteChannelRow, onIntent: (RemoteIntent) -> Unit) {
    val palette = ZephyrTheme.palette
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = ZephyrSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(text = row.label, style = ZephyrTextStyles.body)
            Text(
                text = row.statusText,
                style = ZephyrTheme.typography.caption,
                color = if (row.enabled) palette.status.success else palette.onFloatingMuted,
            )
        }
        if (row.actionable) {
            when {
                row.reason == RemoteChannels.REASON_FILE_SHARE -> TextButton(
                    onClick = { onIntent(RemoteIntent.PickDriveDirectory) },
                ) {
                    Text(text = stringResource(R.string.remote_pick_directory))
                }

                row.needsSettings -> TextButton(
                    onClick = { onIntent(RemoteIntent.OpenAppSettings(row.channel)) },
                ) {
                    Text(text = stringResource(R.string.remote_open_settings))
                }

                else -> TextButton(
                    onClick = { onIntent(RemoteIntent.RequestChannelPermission(row.channel)) },
                ) {
                    Text(text = stringResource(R.string.remote_grant_permission))
                }
            }
        }
    }
}

/**
 * The RDPDR share.
 *
 * Shows the profile, the grant state and the *final* read-only value, which section 9 requires
 * because the effective value is the strictest of profile, connection ACL and server - not the switch
 * the user last touched. Enforcement itself lives in the provider, not here.
 */
@Composable
private fun DrivePanel(
    content: RemoteContent,
    onClose: () -> Unit,
    onIntent: (RemoteIntent) -> Unit,
) {
    RemoteBottomPanel(title = stringResource(R.string.remote_drive), onClose = onClose) {
        when (val drive = content.drive) {
            is RdpDriveResolution.Mapped -> {
                Text(
                    text = stringResource(R.string.remote_drive_share, drive.mapping.shareName),
                    style = ZephyrTextStyles.body,
                )
                Text(
                    text = stringResource(R.string.remote_drive_profile, drive.mapping.profileId),
                    style = ZephyrTheme.typography.monoCaption,
                )
                Text(
                    text = stringResource(
                        if (drive.mapping.readOnly) {
                            R.string.remote_drive_read_only
                        } else {
                            R.string.remote_drive_read_write
                        },
                    ),
                    style = ZephyrTheme.typography.caption,
                    color = ZephyrTheme.palette.status.success,
                )
            }

            is RdpDriveResolution.Unavailable -> {
                Text(
                    text = stringResource(R.string.remote_drive_unavailable, drive.detail),
                    style = ZephyrTextStyles.body,
                    color = ZephyrTheme.palette.status.warning,
                )
                Text(text = drive.code, style = ZephyrTheme.typography.monoCaption)
                TextButton(onClick = { onIntent(RemoteIntent.PickDriveDirectory) }) {
                    Text(text = stringResource(R.string.remote_pick_directory))
                }
            }

            RdpDriveResolution.NeedsUserChoice -> {
                Text(
                    text = stringResource(R.string.remote_drive_needs_choice),
                    style = ZephyrTextStyles.body,
                )
                TextButton(onClick = { onIntent(RemoteIntent.PickDriveDirectory) }) {
                    Text(text = stringResource(R.string.remote_pick_directory))
                }
            }

            null -> Text(
                text = stringResource(R.string.remote_drive_off),
                style = ZephyrTheme.typography.caption,
            )
        }
    }
}

/**
 * The certificate, as a page rather than a toast (section 10).
 *
 * With no pending review it reports the transport as the handshake actually described it, and says
 * nothing at all when the session is not up: claiming a certificate was verified before there is a
 * connection would be the exact overstatement section 10 forbids.
 */
@Composable
private fun CertificatePanel(content: RemoteContent, onClose: () -> Unit) {
    RemoteBottomPanel(title = stringResource(R.string.remote_certificate), onClose = onClose) {
        val prompt = content.certificatePrompt
        if (prompt != null) {
            CertificateFacts(prompt = prompt)
            return@RemoteBottomPanel
        }
        content.securityLabel?.let { label ->
            Text(text = label, style = ZephyrTheme.typography.monoCaption)
        }
        Text(
            text = stringResource(
                if (content.status.hasSurface) {
                    R.string.remote_certificate_accepted
                } else {
                    R.string.remote_certificate_unknown
                },
            ),
            style = ZephyrTheme.typography.caption,
        )
    }
}

/** S23 画质/颜色. Two real choices; the label follows what the server applied, not the request. */
@Composable
private fun QualityPanel(
    content: RemoteContent,
    onClose: () -> Unit,
    onIntent: (RemoteIntent) -> Unit,
) {
    RemoteBottomPanel(title = stringResource(R.string.remote_quality), onClose = onClose) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.xs)) {
            for (depth in VncColourDepth.entries) {
                FilterChip(
                    selected = content.pixelFormatLabel == depth.label,
                    onClick = { onIntent(RemoteIntent.ColourDepth(depth)) },
                    label = { Text(text = depth.label) },
                )
            }
        }
        Spacer(modifier = Modifier.height(ZephyrSpacing.sm))
        Text(
            text = stringResource(R.string.remote_quality_hint),
            style = ZephyrTheme.typography.caption,
        )
    }
}

@Composable
private fun ShortcutsPanel(onClose: () -> Unit, onIntent: (RemoteIntent) -> Unit) {
    one.zephyr.mobile.ui.component.ActionSheet(
        visible = true,
        onDismiss = onClose,
        groups = listOf(
            one.zephyr.mobile.ui.component.ActionSheetGroup(
                title = stringResource(R.string.remote_shortcuts),
                items = RdpShortcut.sheetItems.map { shortcut ->
                    one.zephyr.mobile.ui.component.ActionSheetItem(
                        label = shortcut.label,
                        onClick = {
                            onClose()
                            onIntent(RemoteIntent.SendShortcut(shortcut))
                        },
                    )
                },
            ),
            one.zephyr.mobile.ui.component.ActionSheetGroup(
                items = listOf(
                    one.zephyr.mobile.ui.component.ActionSheetItem(
                        label = stringResource(R.string.remote_cancel),
                        cancel = true,
                        onClick = onClose,
                    ),
                ),
            ),
        ),
    )
}

/** Section 13: closing does not restore remote process state, so the sheet says so. */
@Composable
private fun DisconnectPanel(onClose: () -> Unit, onIntent: (RemoteIntent) -> Unit) {
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(text = stringResource(R.string.remote_disconnect_title)) },
        text = { Text(text = stringResource(R.string.remote_disconnect_body)) },
        confirmButton = {
            TextButton(
                onClick = {
                    onClose()
                    onIntent(RemoteIntent.Disconnect)
                },
            ) {
                Text(
                    text = stringResource(R.string.remote_disconnect),
                    color = ZephyrTheme.palette.status.error,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onClose) { Text(text = stringResource(R.string.remote_cancel)) }
        },
    )
}


// ---- prompts -------------------------------------------------------------------------------------

/**
 * The certificate facts, section 10.
 *
 * Subject, issuer, validity and SHA-256 together, because a fingerprint on its own is not a decision
 * a person can make: the frozen requirement is that the user sees who the certificate claims to be
 * *and* what it hashes to. Shown identically on first contact and on a change, so the only thing that
 * differs between the two is which action is the default.
 */
@Composable
private fun CertificateFacts(prompt: RemoteCertificatePrompt) {
    val review = prompt.review
    val palette = ZephyrTheme.palette
    Column(modifier = Modifier.fillMaxWidth()) {
        Text(
            text = stringResource(R.string.remote_cert_subject, review.subject),
            style = ZephyrTextStyles.body,
        )
        Text(
            text = stringResource(R.string.remote_cert_issuer, review.issuer),
            style = ZephyrTheme.typography.caption,
            color = palette.onFloatingMuted,
        )
        Text(
            text = stringResource(
                R.string.remote_cert_validity,
                RelativeTime.absolute(review.notBefore),
                RelativeTime.absolute(review.notAfter),
            ),
            style = ZephyrTheme.typography.caption,
            color = palette.onFloatingMuted,
        )
        Spacer(modifier = Modifier.height(ZephyrSpacing.sm))

        // Bordered rather than inline: the fingerprint is the one string the user is expected to
        // compare against something else, so it gets a boundary instead of being a line of prose.
        Text(
            text = AlertDialogLayout.wrapFingerprint(review.sha256Fingerprint),
            style = ZephyrTheme.typography.mono,
            textAlign = TextAlign.Start,
            modifier = Modifier
                .fillMaxWidth()
                .border(1.dp, palette.surfaces.outline, RoundedCornerShape(ZephyrRadius.sm))
                .padding(ZephyrSpacing.sm),
        )
        prompt.previousFingerprint?.let { previous ->
            Spacer(modifier = Modifier.height(ZephyrSpacing.xs))
            Text(
                text = stringResource(R.string.remote_cert_previous_label),
                style = ZephyrTheme.typography.caption,
                color = palette.status.warning,
            )
            Text(
                text = AlertDialogLayout.wrapFingerprint(previous),
                style = ZephyrTheme.typography.monoCaption,
                textAlign = TextAlign.Start,
                color = palette.status.warning,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/**
 * First contact, or a changed certificate.
 *
 * Dismissal rejects. Section 10 requires a changed certificate to block by default, and a dialog that
 * accepted on an outside tap would be exactly the toast-style dismissal the frozen text rules out.
 * The two cases differ only in wording and in which button is emphasised - the facts are the same.
 */
@Composable
private fun CertificateDialog(prompt: RemoteCertificatePrompt, onIntent: (RemoteIntent) -> Unit) {
    val changed = prompt.changed
    AlertDialog(
        onDismissRequest = { onIntent(RemoteIntent.RejectCertificate) },
        title = {
            Text(
                text = stringResource(
                    if (changed) R.string.remote_cert_changed_title else R.string.remote_cert_first_title,
                ),
            )
        },
        text = {
            Column {
                Text(
                    text = stringResource(
                        if (changed) R.string.remote_cert_changed_body else R.string.remote_cert_first_body,
                    ),
                    style = ZephyrTextStyles.body,
                    color = if (changed) ZephyrTheme.palette.status.error else ZephyrTheme.palette.onBackground,
                )
                Spacer(modifier = Modifier.height(ZephyrSpacing.sm))
                CertificateFacts(prompt = prompt)
            }
        },
        // Reject is the confirm slot when the certificate changed, so the emphasised action is the
        // safe one and accepting is the deliberate reach.
        confirmButton = {
            if (changed) {
                TextButton(onClick = { onIntent(RemoteIntent.RejectCertificate) }) {
                    Text(
                        text = stringResource(R.string.remote_cert_reject),
                        color = ZephyrTheme.palette.status.error,
                    )
                }
            } else {
                TextButton(onClick = { onIntent(RemoteIntent.AcceptCertificate) }) {
                    Text(text = stringResource(R.string.remote_cert_trust))
                }
            }
        },
        dismissButton = {
            if (changed) {
                TextButton(onClick = { onIntent(RemoteIntent.AcceptCertificate) }) {
                    Text(
                        text = stringResource(R.string.remote_cert_trust_changed),
                        color = ZephyrTheme.palette.onFloatingMuted,
                    )
                }
            } else {
                TextButton(onClick = { onIntent(RemoteIntent.RejectCertificate) }) {
                    Text(text = stringResource(R.string.remote_cert_reject))
                }
            }
        },
    )
}

/**
 * The VNC password prompt.
 *
 * Re-prompts rather than failing, per ADR-005: a wrong password is not a dead end until the server
 * says the attempts are gone, and only then does the dialog stop offering a field. The value leaves as
 * a CharArray so [RemoteIntent.SubmitPassword] can wipe it - the String the text field needs is the
 * shortest-lived copy the platform allows, since Compose has no CharArray-backed field.
 */
@Composable
private fun AuthDialog(
    prompt: RemoteAuthPrompt,
    warning: String?,
    onIntent: (RemoteIntent) -> Unit,
) {
    var password by remember { mutableStateOf("") }
    val exhausted = prompt.attemptsExhausted
    AlertDialog(
        onDismissRequest = {
            password = ""
            onIntent(RemoteIntent.CancelAuth)
        },
        title = { Text(text = stringResource(R.string.remote_auth_title)) },
        text = {
            Column {
                Text(text = prompt.reason, style = ZephyrTextStyles.body)

                // Section 10: a VNC password is not TLS, and the pill says so for the whole session.
                // Repeated here because this is the moment the user decides to type it.
                warning?.let { value ->
                    Spacer(modifier = Modifier.height(ZephyrSpacing.xs))
                    Text(
                        text = value,
                        style = ZephyrTheme.typography.caption,
                        color = ZephyrTheme.palette.status.warning,
                    )
                }
                if (exhausted) {
                    Spacer(modifier = Modifier.height(ZephyrSpacing.sm))
                    Text(
                        text = stringResource(R.string.remote_auth_exhausted),
                        style = ZephyrTextStyles.body,
                        color = ZephyrTheme.palette.status.error,
                    )
                } else {
                    Spacer(modifier = Modifier.height(ZephyrSpacing.sm))
                    OutlinedTextField(
                        value = password,
                        onValueChange = { entered -> password = entered },
                        label = { Text(text = stringResource(R.string.remote_auth_password)) },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        },
        confirmButton = {
            if (exhausted) {
                TextButton(onClick = { onIntent(RemoteIntent.Reconnect) }) {
                    Text(text = stringResource(R.string.remote_reconnect))
                }
            } else {
                TextButton(
                    enabled = password.isNotEmpty(),
                    onClick = {
                        val submitted = password.toCharArray()
                        password = ""
                        onIntent(RemoteIntent.SubmitPassword(submitted))
                    },
                ) {
                    Text(text = stringResource(R.string.remote_auth_submit))
                }
            }
        },
        dismissButton = {
            TextButton(
                onClick = {
                    password = ""
                    onIntent(RemoteIntent.CancelAuth)
                },
            ) {
                Text(text = stringResource(R.string.remote_cancel))
            }
        },
    )
}

/**
 * A clipboard transfer waiting on the user, section 7.
 *
 * States the direction, the kind and the size, because an image or a file offer is a transfer the user
 * should be able to refuse on size alone. Remote to local is the common case and is the only path that
 * may write the device clipboard; the local to remote branch re-reads the live clipboard at the moment
 * of the tap rather than trusting the preview, so a confirmed paste is never the truncated one.
 */
@Composable
private fun ClipboardDialog(offer: RemoteClipboardOffer, onIntent: (RemoteIntent) -> Unit) {
    val clipboard = LocalClipboardManager.current
    AlertDialog(
        onDismissRequest = { onIntent(RemoteIntent.CancelClipboard) },
        title = {
            Text(
                text = stringResource(
                    if (offer.fromRemote) {
                        R.string.remote_clipboard_from_remote
                    } else {
                        R.string.remote_clipboard_to_remote
                    },
                ),
            )
        },
        text = {
            Column {
                Text(
                    text = stringResource(
                        R.string.remote_clipboard_kind,
                        offer.kind.label,
                        offer.byteCount,
                    ),
                    style = ZephyrTheme.typography.caption,
                )
                offer.preview?.let { preview ->
                    Spacer(modifier = Modifier.height(ZephyrSpacing.sm))
                    Text(
                        text = preview,
                        style = ZephyrTheme.typography.mono,
                        maxLines = 4,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    if (offer.fromRemote) {
                        onIntent(RemoteIntent.AcceptRemoteClipboard)
                    } else {
                        val text = clipboard.getText()?.text
                        if (text.isNullOrEmpty()) {
                            onIntent(RemoteIntent.CancelClipboard)
                        } else {
                            onIntent(RemoteIntent.SendClipboardToRemote(text))
                        }
                    }
                },
            ) {
                Text(text = stringResource(R.string.remote_clipboard_allow))
            }
        },
        dismissButton = {
            TextButton(onClick = { onIntent(RemoteIntent.CancelClipboard) }) {
                Text(text = stringResource(R.string.remote_cancel))
            }
        },
    )
}


// ---- helpers -------------------------------------------------------------------------------------

/** The frozen 48dp floor from ISLAND_GEOMETRY, reused so the dock cannot drift below it. */
private val IslandTouchTarget = IslandSpec.minTouchTarget

/** For a number the engine has not reported. Section 11: absent is not zero. */
private const val DASH = "-"

/**
 * Phase plus how long it has been in it (section 13).
 *
 * The elapsed time is what makes a stalled phase legible: "建立连接" alone cannot be told apart from
 * "建立连接 18 秒", and the second one is a timeout the user can act on.
 */
@Composable
private fun phaseText(status: RemoteSessionStatus, nowMs: Long): String {
    val seconds = (status.elapsedMs(nowMs) / 1_000L).toInt()
    if (seconds <= 0) return status.phase.label
    return stringResource(R.string.remote_phase_elapsed, status.phase.label, seconds)
}

@Composable
private fun phaseColour(phase: RemotePhase): Color {
    val palette = ZephyrTheme.palette
    return when (phase) {
        RemotePhase.CONNECTED -> palette.status.success
        RemotePhase.DEGRADED, RemotePhase.RECONNECTING -> palette.status.warning
        RemotePhase.DISCONNECTED -> palette.status.offline
        RemotePhase.RESOLVING,
        RemotePhase.CONNECTING,
        RemotePhase.SECURING,
        RemotePhase.AUTHENTICATING,
        RemotePhase.NEGOTIATING,
        RemotePhase.FIRST_FRAME,
        -> palette.onFloatingMuted
    }
}

private fun dockLabel(item: RemoteDockItem): Int = when (item) {
    RemoteDockItem.KEYBOARD -> R.string.remote_keyboard
    RemoteDockItem.POINTER_MODE -> R.string.remote_pointer
    RemoteDockItem.CLIPBOARD -> R.string.remote_clipboard
    RemoteDockItem.DRIVE -> R.string.remote_drive
    RemoteDockItem.QUALITY -> R.string.remote_quality
    RemoteDockItem.RESOLUTION -> R.string.remote_display
    RemoteDockItem.FPS -> R.string.remote_fps
    RemoteDockItem.FIT -> R.string.remote_fit
    RemoteDockItem.ZOOM -> R.string.remote_zoom
    RemoteDockItem.SHORTCUTS -> R.string.remote_shortcuts
    RemoteDockItem.JOYSTICK -> R.string.remote_joystick
    RemoteDockItem.CAD -> R.string.remote_cad
    RemoteDockItem.VNC_QUALITY -> R.string.remote_quality
    RemoteDockItem.RECONNECT -> R.string.remote_reconnect
    RemoteDockItem.DISCONNECT -> R.string.remote_disconnect
}

private fun dockIcon(item: RemoteDockItem): ImageVector = when (item) {
    RemoteDockItem.KEYBOARD -> ZephyrIcons.Keyboard
    RemoteDockItem.POINTER_MODE -> ZephyrIcons.Pointer
    RemoteDockItem.CLIPBOARD -> ZephyrIcons.Clipboard
    RemoteDockItem.DRIVE -> ZephyrIcons.File
    RemoteDockItem.QUALITY, RemoteDockItem.VNC_QUALITY, RemoteDockItem.SHORTCUTS -> ZephyrIcons.Bolt
    RemoteDockItem.RESOLUTION -> ZephyrIcons.Monitor
    RemoteDockItem.FPS -> ZephyrIcons.Stats
    RemoteDockItem.FIT -> ZephyrIcons.Fit
    RemoteDockItem.ZOOM -> ZephyrIcons.Zoom
    RemoteDockItem.JOYSTICK -> ZephyrIcons.Joystick
    RemoteDockItem.CAD -> ZephyrIcons.Security
    RemoteDockItem.RECONNECT -> ZephyrIcons.Reconnect
    RemoteDockItem.DISCONNECT -> ZephyrIcons.Disconnect
}

/**
 * Which dock entries read as on.
 *
 * Only the ones that describe a live state, per section 12: the keyboard and the modifier bar are
 * either up or not, the pointer is in one of two modes, a drive is either mapped or not and a pending
 * certificate is a thing the user has to come back to. Everything else opens a panel and is momentary,
 * so showing it as selected would claim a state that does not exist.
 */
private fun isDockSelected(item: RemoteDockItem, content: RemoteContent): Boolean = when (item) {
    RemoteDockItem.KEYBOARD -> content.surface.chrome.keyboardVisible
    RemoteDockItem.POINTER_MODE -> content.surface.pointer.mode == RemotePointerMode.TRACKPAD
    RemoteDockItem.JOYSTICK -> content.surface.dragMode == RemoteDragMode.VIEWPORT
    RemoteDockItem.DRIVE -> content.drive is RdpDriveResolution.Mapped
    else -> false
}

/**
 * What a dock tap does.
 *
 * Two toggles go straight out as intents because they are session state the controller owns; the rest
 * open a local panel, which is why this takes [onOpenPanel] rather than routing panel visibility
 * through the ViewModel. Disconnect opens a confirmation instead of acting: section 12 requires the
 * sheet, and a single tap that killed the session would make the dock hostile.
 */
private fun dispatchDock(
    item: RemoteDockItem,
    content: RemoteContent,
    onOpenPanel: (RemotePanel) -> Unit,
    onIntent: (RemoteIntent) -> Unit,
) {
    when (item) {
        RemoteDockItem.KEYBOARD ->
            onIntent(RemoteIntent.SetKeyboardVisible(!content.surface.chrome.keyboardVisible))
        RemoteDockItem.POINTER_MODE -> {
            val next = if (content.surface.pointer.mode == RemotePointerMode.DIRECT) {
                RemotePointerMode.TRACKPAD
            } else {
                RemotePointerMode.DIRECT
            }
            onIntent(RemoteIntent.PointerMode(next))
        }
        RemoteDockItem.QUALITY -> onIntent(RemoteIntent.CycleQuality)
        RemoteDockItem.RESOLUTION -> onIntent(RemoteIntent.CycleResolution)
        RemoteDockItem.FPS -> onIntent(RemoteIntent.CycleFps)
        RemoteDockItem.FIT -> onIntent(RemoteIntent.FitViewport)
        RemoteDockItem.ZOOM -> onIntent(RemoteIntent.CycleZoom)
        RemoteDockItem.CLIPBOARD -> onOpenPanel(RemotePanel.CLIPBOARD)
        RemoteDockItem.DRIVE -> onOpenPanel(RemotePanel.DRIVE)
        RemoteDockItem.SHORTCUTS -> onOpenPanel(RemotePanel.SHORTCUTS)
        RemoteDockItem.JOYSTICK -> onIntent(RemoteIntent.ToggleJoystick)
        RemoteDockItem.CAD -> onIntent(RemoteIntent.SendShortcut(RdpShortcut.CAD))
        RemoteDockItem.RECONNECT -> onIntent(RemoteIntent.Reconnect)
        RemoteDockItem.DISCONNECT -> onOpenPanel(RemotePanel.DISCONNECT)
        RemoteDockItem.VNC_QUALITY -> onIntent(RemoteIntent.CycleQuality)
    }
}

private fun pointerModeLabel(mode: RemotePointerMode): Int = when (mode) {
    RemotePointerMode.DIRECT -> R.string.remote_pointer_direct
    RemotePointerMode.TRACKPAD -> R.string.remote_pointer_trackpad
}

private fun viewportModeLabel(mode: RemoteViewportMode): Int = when (mode) {
    RemoteViewportMode.FIT -> R.string.remote_viewport_fit
    RemoteViewportMode.FILL_WIDTH -> R.string.remote_viewport_fill_width
    RemoteViewportMode.ONE_TO_ONE -> R.string.remote_viewport_one_to_one
    RemoteViewportMode.CUSTOM -> R.string.remote_viewport_custom
    RemoteViewportMode.DYNAMIC -> R.string.remote_viewport_dynamic
}

private fun soundModeLabel(mode: RdpSoundMode): Int = when (mode) {
    RdpSoundMode.LOCAL -> R.string.remote_sound_local
    RdpSoundMode.REMOTE -> R.string.remote_sound_remote
    RdpSoundMode.OFF -> R.string.remote_sound_off
}
