package one.zephyr.mobile.feature.remote

import one.zephyr.mobile.data.session.SessionTransport
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.protocol.rdp.RdpCertificateReview
import one.zephyr.mobile.protocol.rdp.RdpDriveResolution

/**
 * A certificate the user must decide about.
 *
 * [changed] is carried separately from the review because the two cases are not equal:
 * REMOTE_DESKTOP_EXPERIENCE.md 10 requires a changed certificate to block by default, so the UI needs
 * to know which decision it is presenting before it chooses a default action.
 */
data class RemoteCertificatePrompt(
    val review: RdpCertificateReview,
    val changed: Boolean,
    val previousFingerprint: String?,
)

/**
 * The server wants a password.
 *
 * Separate from an error so the UI re-prompts instead of showing a dead end (ADR-005 "认证失败").
 */
data class RemoteAuthPrompt(val reason: String, val attemptsExhausted: Boolean)

/**
 * Everything S22 and S23 render around the framebuffer.
 *
 * One type for both protocols with the protocol-specific parts nullable, rather than two types: the
 * frozen spec gives them the same surface, the same viewport modes, the same two touch modes and the
 * same chrome, and the differences are exactly the four nullable fields below. Splitting the type
 * would mean writing the shared screen twice.
 */
data class RemoteContent(
    val connection: Connection,
    val surface: RemoteSurfaceState,
    val status: RemoteSessionStatus,
    val transport: SessionTransport,
    val dock: List<RemoteDockItem>,
    /** False while ADR-004 (RDP) or ADR-005 (VNC) keeps the engine out of the build. */
    val engineAvailable: Boolean,
    /** True when the grant allows observing but not controlling; input is dropped at the controller. */
    val viewOnly: Boolean,
    val executionDisclosure: String?,
    /** Non-null when the transport itself is weak, e.g. a plain VNC password (section 10). */
    val securityWarning: String?,
    val certificatePrompt: RemoteCertificatePrompt?,
    val authPrompt: RemoteAuthPrompt?,
    val clipboardPrompt: RemoteClipboardOffer?,
    // ---- RDP only ----
    val channels: List<RemoteChannelRow> = emptyList(),
    val drive: RdpDriveResolution? = null,
    /** Android permissions to request now, because the remote actually opened those channels. */
    val pendingPermissions: List<String> = emptyList(),
    /** Mic/camera that are live. Section 8 requires these to stay visible for the whole session. */
    val captureLabels: List<String> = emptyList(),
    // ---- VNC only ----
    val securityLabel: String? = null,
    val pixelFormatLabel: String? = null,
) {
    val canInteract: Boolean get() = status.hasSurface && !viewOnly

    /** Blocking prompts. The surface stays visible underneath, but input must not reach it. */
    val hasBlockingPrompt: Boolean get() = certificatePrompt != null || authPrompt != null
}

/** Disclosure strings shared by both remote screens, matching the session list word for word. */
object RemoteDisclosure {
    const val RELAY = "主端 relay：凭据保留在主端"
    const val DIRECT = "本次原生直连：加密连接材料仅驻留会话内存"
    const val VIEW_ONLY = "只读观察：该授权不包含控制权限，输入不会发送"
    const val VNC_PASSWORD = "VNC 密码认证为弱加密，不等同于 TLS；请仅在受信网络使用"
}
