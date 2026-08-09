package one.zephyr.mobile.feature.remote

import one.zephyr.mobile.model.RdpChannel

/**
 * Everything the remote chrome can ask for.
 *
 * Scope is deliberate: this covers the dock, the sheets and the prompts, not the gesture stream.
 * Pointer moves arrive tens of times a second and are answered by [RemoteSessionController] with no
 * navigation, theming or string involved, so routing them through a sealed hierarchy would allocate
 * per sample and put the one latency-critical path behind an extra dispatch. [RemoteSurface] holds
 * the controller for that reason; everything a *screen* does is a value in here, which is what makes
 * the exhaustive when in [RemoteRoutes] fail to compile when a new action is added and not wired.
 */
sealed interface RemoteIntent {

    // ---- chrome ----------------------------------------------------------------------------------

    /** A tap that fell on the letterbox, or on the surface while there is nothing to control. */
    data object ToggleChrome : RemoteIntent

    /** The idle timer expired. Separate from [ToggleChrome] so auto-hide can never accidentally show. */
    data object HideChrome : RemoteIntent

    data class SetKeyboardVisible(val visible: Boolean) : RemoteIntent

    data class SetModifierBarVisible(val visible: Boolean) : RemoteIntent

    // ---- keyboard --------------------------------------------------------------------------------

    data class ModifierTap(val modifier: RemoteModifier) : RemoteIntent

    data class Key(val key: RemoteKey) : RemoteIntent

    /** IME commit. Routed as text or as a chord by [RemoteTextPolicy], never guessed here. */
    data class Text(val text: String) : RemoteIntent

    // ---- viewport / pointer ----------------------------------------------------------------------

    data class ViewportMode(val mode: RemoteViewportMode) : RemoteIntent

    data class PointerMode(val mode: RemotePointerMode) : RemoteIntent

    data class Sensitivity(val value: Float) : RemoteIntent

    /** Releases anything the drag lock left held. Section 5.2 requires an explicit way out. */
    data object ReleasePointer : RemoteIntent

    // ---- session ---------------------------------------------------------------------------------

    data object Connect : RemoteIntent

    data object Reconnect : RemoteIntent

    data object Disconnect : RemoteIntent

    data object Minimise : RemoteIntent

    data object Back : RemoteIntent

    /** Asks the engine for the whole framebuffer, e.g. after a colour-depth change. */
    data object FullRepaint : RemoteIntent

    // ---- prompts ---------------------------------------------------------------------------------

    data object AcceptCertificate : RemoteIntent

    data object RejectCertificate : RemoteIntent

    /**
     * A password typed into the auth prompt.
     *
     * A CharArray rather than a String so it can be wiped: a String would sit in the intern pool
     * until the next GC, which is exactly the lifetime SECURITY_MODEL forbids for a secret.
     */
    data class SubmitPassword(val password: CharArray) : RemoteIntent {
        override fun equals(other: Any?): Boolean =
            other is SubmitPassword && password.contentEquals(other.password)

        override fun hashCode(): Int = password.contentHashCode()

        /** Redacted on purpose: an intent log must never contain a password. */
        override fun toString(): String = "SubmitPassword(password=[redacted])"
    }

    data object CancelAuth : RemoteIntent

    /**
     * The user accepted a remote-to-local transfer.
     *
     * Carries no text: the far side's clipboard content is held by the ViewModel for exactly as long
     * as the prompt is up, and the system clipboard is written by the route. Section 7 forbids the
     * remote clipboard from reaching the device clipboard without this action.
     */
    data object AcceptRemoteClipboard : RemoteIntent

    /**
     * The user chose to push the device clipboard to the remote session.
     *
     * The text is read by the screen from the platform clipboard at the moment of the tap rather than
     * observed, so nothing the user copies is mirrored into the session in the background.
     */
    data class SendClipboardToRemote(val text: String) : RemoteIntent

    data object CancelClipboard : RemoteIntent

    // ---- channels (RDP only) ---------------------------------------------------------------------

    /** Re-request a permission the OS may still prompt for. */
    data class RequestChannelPermission(val channel: RdpChannel) : RemoteIntent

    /** Open the system settings page, for a permission that will no longer prompt (section 8). */
    data class OpenAppSettings(val channel: RdpChannel) : RemoteIntent

    /** Pick a directory for the RDPDR share. The picker itself belongs to the host activity. */
    data object PickDriveDirectory : RemoteIntent

    // ---- quality (VNC only) ----------------------------------------------------------------------

    data class ColourDepth(val depth: VncColourDepth) : RemoteIntent
}
