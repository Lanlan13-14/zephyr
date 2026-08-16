package one.zephyr.mobile.feature.remote

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import kotlinx.coroutines.flow.Flow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import one.zephyr.mobile.model.RdpChannel

/**
 * Route bindings for S22 and S23.
 *
 * Separate from [RemoteScreen] for the same reason as the session routes: the screen takes values and
 * lambdas, so a Compose test can drive every phase, prompt and panel without an engine, a registry or
 * a native library. These two functions are the only place that knows a ViewModel exists.
 *
 * The two protocols get one function each rather than a shared one with flags. They answer different
 * halves of [RemoteIntent] - RDP has certificates, channels and a drive, VNC has an interactive
 * password and a colour depth - and an exhaustive when in each is what makes that difference visible:
 * adding an intent fails to compile in *both* routes until each has said what it does with it,
 * including saying "not this protocol" out loud.
 */
@Composable
fun RdpRemoteRoute(
    viewModel: RdpViewModel,
    nowMs: Long,
    online: Boolean,
    onBack: () -> Unit,
    onRequestPermission: (RdpChannel) -> Unit,
    onOpenAppSettings: (RdpChannel) -> Unit,
    onPickDriveDirectory: () -> Unit,
    onMessage: suspend (String) -> Unit,
    autoConnect: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    CollectRemoteMessages(viewModel.message, onMessage)
    WriteLocalClipboard(viewModel.localClipboardWrites)

    // Keyed on autoConnect as well as the ViewModel so a workspace restore that arrives false cannot
    // be turned into a dial by a later recomposition (SCREEN_CATALOG.md 7).
    LaunchedEffect(viewModel, autoConnect) {
        if (autoConnect) viewModel.connect()
    }

    RemoteScreen(
        state = state,
        controller = viewModel.controller,
        nowMs = nowMs,
        online = online,
        onIntent = { intent ->
            dispatchRdp(
                viewModel = viewModel,
                intent = intent,
                onBack = onBack,
                onRequestPermission = onRequestPermission,
                onOpenAppSettings = onOpenAppSettings,
                onPickDriveDirectory = onPickDriveDirectory,
            )
        },
        modifier = modifier,
    )
}

/**
 * S23.
 *
 * @param remoteTitle comes from the ViewModel rather than the caller: the desktop name is a fact the
 *   RFB handshake reports, and only after it succeeds.
 */
@Composable
fun VncRemoteRoute(
    viewModel: VncViewModel,
    nowMs: Long,
    online: Boolean,
    onBack: () -> Unit,
    onMessage: suspend (String) -> Unit,
    autoConnect: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val remoteTitle by viewModel.title.collectAsStateWithLifecycle()

    CollectRemoteMessages(viewModel.message, onMessage)
    WriteLocalClipboard(viewModel.localClipboardWrites)

    LaunchedEffect(viewModel, autoConnect) {
        if (autoConnect) viewModel.connect()
    }

    RemoteScreen(
        state = state,
        controller = viewModel.controller,
        nowMs = nowMs,
        online = online,
        onIntent = { intent -> dispatchVnc(viewModel = viewModel, intent = intent, onBack = onBack) },
        modifier = modifier,
        remoteTitle = remoteTitle,
    )
}

// ---- dispatch ------------------------------------------------------------------------------------

/**
 * The single dispatch point for S22.
 *
 * Chrome, viewport, pointer and keyboard go to the controller because they are surface state it
 * already owns and answers without a round trip; session lifecycle, certificates, channels and the
 * clipboard gate go to the ViewModel because each needs the connection, the ACL or the engine. The
 * three that need an Activity - two permission paths and the directory picker - leave as lambdas: a
 * ViewModel cannot start a system prompt, and pretending otherwise is how a permission result ends up
 * with nowhere to land.
 */
private fun dispatchRdp(
    viewModel: RdpViewModel,
    intent: RemoteIntent,
    onBack: () -> Unit,
    onRequestPermission: (RdpChannel) -> Unit,
    onOpenAppSettings: (RdpChannel) -> Unit,
    onPickDriveDirectory: () -> Unit,
) {
    val controller = viewModel.controller
    when (intent) {
        RemoteIntent.HideChrome -> controller.hideChrome()
        RemoteIntent.ToggleToolsPanel -> controller.toggleToolsPanel()
        RemoteIntent.CycleQuality -> viewModel.cycleQuality()
        RemoteIntent.CycleResolution -> viewModel.cycleResolution()
        RemoteIntent.CycleFps -> viewModel.cycleFps()
        RemoteIntent.FitViewport -> viewModel.fitViewport()
        RemoteIntent.CycleZoom -> viewModel.cycleZoom()
        RemoteIntent.ToggleJoystick -> viewModel.toggleJoystick()
        is RemoteIntent.SendShortcut -> viewModel.sendShortcut(intent.shortcut)
        is RemoteIntent.TrackpadClick -> viewModel.clickTrackpadButton(intent.button)
        is RemoteIntent.SetKeyboardVisible -> controller.setKeyboardVisible(intent.visible)
        is RemoteIntent.SetModifierBarVisible -> controller.setModifierBarVisible(intent.visible)

        is RemoteIntent.ModifierTap -> controller.onModifierTap(intent.modifier)
        is RemoteIntent.Key -> controller.onKey(intent.key)
        is RemoteIntent.Text -> controller.onText(intent.text)

        is RemoteIntent.ViewportMode -> controller.setViewportMode(intent.mode)
        is RemoteIntent.PointerMode -> controller.setPointerMode(intent.mode)
        is RemoteIntent.Sensitivity -> controller.setSensitivity(intent.value)
        RemoteIntent.ReleasePointer -> controller.releasePointer()
        RemoteIntent.FullRepaint -> controller.requestFullRepaint()

        RemoteIntent.Connect -> viewModel.connect()
        RemoteIntent.Reconnect -> viewModel.reconnect()

        // The registry row is closed by disconnect(), so staying on a full-screen framebuffer would
        // be showing a session that no longer exists. Leaving is the honest result; the overlay with
        // Connect and Reconnect is for a session that failed, not for one the user ended.
        RemoteIntent.Disconnect -> {
            viewModel.disconnect()
            onBack()
        }

        // Back leaves the session in the connected group; Minimise moves it to the minimised group
        // first. Two different promises about what the user will find in S20.
        RemoteIntent.Minimise -> {
            viewModel.minimise()
            onBack()
        }
        RemoteIntent.Back -> onBack()

        RemoteIntent.AcceptCertificate -> viewModel.acceptCertificate()
        RemoteIntent.RejectCertificate -> viewModel.rejectCertificate()

        RemoteIntent.AcceptRemoteClipboard -> viewModel.acceptRemoteClipboard()
        is RemoteIntent.SendClipboardToRemote -> viewModel.sendClipboardToRemote(intent.text)
        RemoteIntent.CancelClipboard -> viewModel.cancelClipboard()

        is RemoteIntent.RequestChannelPermission -> onRequestPermission(intent.channel)
        is RemoteIntent.OpenAppSettings -> onOpenAppSettings(intent.channel)
        RemoteIntent.PickDriveDirectory -> onPickDriveDirectory()

        // RDP authenticates inside the connect request, so there is no interactive prompt to answer.
        // The array is still wiped: an unroutable secret is the one that gets forgotten in a heap
        // dump, and SECURITY_MODEL puts the lifetime of the copy on whoever holds it last.
        is RemoteIntent.SubmitPassword -> intent.password.fill('\u0000')
        RemoteIntent.CancelAuth -> Unit

        // VNC only: RFB negotiates a pixel format, RDP negotiates colour depth at connect time and
        // exposes quality through the connection editor instead.
        is RemoteIntent.ColourDepth -> Unit
    }
}

/**
 * The single dispatch point for S23.
 *
 * The RDP-only half is answered rather than defaulted. A VNC page has no certificate to trust, no
 * channels to request and no drive to map - ADR-005 and the S23 catalog both say so - and writing
 * that down here is what stops a future dock entry from quietly appearing on a protocol that cannot
 * honour it.
 */
private fun dispatchVnc(viewModel: VncViewModel, intent: RemoteIntent, onBack: () -> Unit) {
    val controller = viewModel.controller
    when (intent) {
        RemoteIntent.HideChrome -> controller.hideChrome()
        RemoteIntent.ToggleToolsPanel -> controller.toggleToolsPanel()
        RemoteIntent.FitViewport -> controller.fitToWindow()
        RemoteIntent.CycleZoom -> controller.cycleZoom(one.zephyr.mobile.protocol.rdp.RdpDisplayPolicy.ZOOM_FACTORS)
        RemoteIntent.ToggleJoystick -> controller.toggleDragMode()
        RemoteIntent.CycleQuality -> viewModel.cycleQuality()
        RemoteIntent.CycleResolution,
        RemoteIntent.CycleFps,
        is RemoteIntent.SendShortcut,
        -> Unit
        is RemoteIntent.TrackpadClick -> controller.clickMouseButton(intent.button)
        is RemoteIntent.SetKeyboardVisible -> controller.setKeyboardVisible(intent.visible)
        is RemoteIntent.SetModifierBarVisible -> controller.setModifierBarVisible(intent.visible)

        is RemoteIntent.ModifierTap -> controller.onModifierTap(intent.modifier)
        is RemoteIntent.Key -> controller.onKey(intent.key)
        is RemoteIntent.Text -> controller.onText(intent.text)

        is RemoteIntent.ViewportMode -> controller.setViewportMode(intent.mode)
        is RemoteIntent.PointerMode -> controller.setPointerMode(intent.mode)
        is RemoteIntent.Sensitivity -> controller.setSensitivity(intent.value)
        RemoteIntent.ReleasePointer -> controller.releasePointer()
        RemoteIntent.FullRepaint -> controller.requestFullRepaint()

        RemoteIntent.Connect -> viewModel.connect()
        RemoteIntent.Reconnect -> viewModel.reconnect()
        RemoteIntent.Disconnect -> {
            viewModel.disconnect()
            onBack()
        }
        RemoteIntent.Minimise -> {
            viewModel.minimise()
            onBack()
        }
        RemoteIntent.Back -> onBack()

        is RemoteIntent.SubmitPassword -> viewModel.submitPassword(intent.password)
        RemoteIntent.CancelAuth -> viewModel.cancelAuth()

        RemoteIntent.AcceptRemoteClipboard -> viewModel.acceptRemoteClipboard()
        is RemoteIntent.SendClipboardToRemote -> viewModel.sendClipboardToRemote(intent.text)
        RemoteIntent.CancelClipboard -> viewModel.cancelClipboard()

        is RemoteIntent.ColourDepth -> viewModel.setColourDepth(intent.depth)

        // RFB has no certificate: the security type is chosen during the handshake and an unknown one
        // is refused there. A VNC page that offered to trust a certificate would be describing a
        // transport it is not using.
        RemoteIntent.AcceptCertificate -> Unit
        RemoteIntent.RejectCertificate -> Unit

        // No RDPDR and no device redirection in RFB, so the dock never shows these entries and the
        // intents never arrive. Answered rather than defaulted so that stays true by compilation.
        is RemoteIntent.RequestChannelPermission -> Unit
        is RemoteIntent.OpenAppSettings -> Unit
        RemoteIntent.PickDriveDirectory -> Unit
    }
}

// ---- side effects --------------------------------------------------------------------------------

/**
 * Bridges the one-shot message flow to the host's snackbar.
 *
 * Keyed on the flow so a recomposition does not resubscribe and replay the same message twice.
 */
@Composable
private fun CollectRemoteMessages(messages: Flow<String>, onMessage: suspend (String) -> Unit) {
    LaunchedEffect(messages) { messages.collect { onMessage(it) } }
}

/**
 * The only place the remote clipboard reaches the device clipboard.
 *
 * REMOTE_DESKTOP_EXPERIENCE.md 7 forbids a background write, so this flow only ever emits after the
 * user confirmed the offer in [ClipboardDialog] - the ViewModel holds the text until then and drops it
 * on cancel. Putting the write here rather than in the ViewModel keeps the platform clipboard out of
 * a class that unit tests instantiate.
 */
@Composable
private fun WriteLocalClipboard(writes: Flow<String>) {
    val clipboard = LocalClipboardManager.current
    LaunchedEffect(writes, clipboard) {
        writes.collect { text -> clipboard.setText(AnnotatedString(text)) }
    }
}
