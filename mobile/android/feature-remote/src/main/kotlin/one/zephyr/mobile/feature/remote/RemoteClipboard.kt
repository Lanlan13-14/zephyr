package one.zephyr.mobile.feature.remote

/**
 * How the local clipboard may reach the remote session.
 *
 * Three states rather than a boolean because REMOTE_DESKTOP_EXPERIENCE.md 7 freezes an ask / allow
 * once / always policy. ASK is the default: a remote desktop can read its own clipboard whenever it
 * likes, so a silent bridge would make everything the user ever copied on the phone readable by the
 * far side.
 */
enum class RemoteClipboardPolicy(val label: String) {
    ASK("每次询问"),
    ALLOW_ONCE("本次允许"),
    ALWAYS("总是允许"),
    ;

    val isPersistent: Boolean get() = this == ALWAYS
}

/** What kind of payload is waiting. Size travels with it so the user can refuse a 40 MB image. */
enum class RemoteClipboardKind(val label: String) {
    TEXT("文本"),
    IMAGE("图片"),
    FILES("文件"),
}

data class RemoteClipboardOffer(
    val kind: RemoteClipboardKind,
    val byteCount: Int,
    /** True for remote to local. The two directions are confirmed separately. */
    val fromRemote: Boolean,
    /** Only for text, and only a prefix: the preview is for recognition, not for reading. */
    val preview: String? = null,
) {
    val needsConfirmation: Boolean
        get() = kind != RemoteClipboardKind.TEXT || byteCount > RemoteClipboard.LARGE_TEXT_BYTES
}

sealed interface RemoteClipboardDecision {
    /** Send or accept now. */
    data class Transfer(val offer: RemoteClipboardOffer) : RemoteClipboardDecision

    /** Show a confirmation. [reason] is what the sheet explains. */
    data class Confirm(val offer: RemoteClipboardOffer, val reason: String) : RemoteClipboardDecision

    data class Blocked(val reason: String) : RemoteClipboardDecision
}

/**
 * The clipboard gate.
 *
 * Pure, and separate from any Android clipboard call, because the rules in section 7 are about *when*
 * a transfer may happen: the channel must be enabled on the connection, the ACL must allow it, and
 * remote-to-local never writes the system clipboard without a user action. Making that a function
 * means the ViewModel cannot accidentally implement four fifths of it.
 */
object RemoteClipboard {

    /** Above this, even text is confirmed: a multi-megabyte paste is not what a Ctrl+V meant. */
    const val LARGE_TEXT_BYTES = 64 * 1024

    const val PREVIEW_CHARS = 120

    const val REASON_CHANNEL_OFF = "该连接未启用剪贴板通道"
    const val REASON_NO_CAPABILITY = "共享该连接的所有者未授予剪贴板权限"
    const val REASON_ASK = "远程会话请求访问剪贴板"
    const val REASON_LARGE = "内容较大，确认后再传输"
    const val REASON_REMOTE_WRITE = "远程剪贴板可用，确认后写入本机"

    fun decide(
        offer: RemoteClipboardOffer,
        channelEnabled: Boolean,
        allowedByAcl: Boolean,
        policy: RemoteClipboardPolicy,
    ): RemoteClipboardDecision {
        if (!channelEnabled) return RemoteClipboardDecision.Blocked(REASON_CHANNEL_OFF)
        if (!allowedByAcl) return RemoteClipboardDecision.Blocked(REASON_NO_CAPABILITY)

        // Remote to local is always a user action, whatever the policy says. Section 7 forbids reading
        // or overwriting the system clipboard in the background, and "always allow" was granted for
        // sending, not for letting the far side rewrite what is on the device.
        if (offer.fromRemote) {
            return RemoteClipboardDecision.Confirm(offer, REASON_REMOTE_WRITE)
        }
        if (policy == RemoteClipboardPolicy.ASK) {
            return RemoteClipboardDecision.Confirm(offer, REASON_ASK)
        }
        if (offer.needsConfirmation) {
            return RemoteClipboardDecision.Confirm(offer, REASON_LARGE)
        }
        return RemoteClipboardDecision.Transfer(offer)
    }

    /**
     * A short preview.
     *
     * Truncated at a code-point boundary so a preview cannot split a surrogate pair and render as a
     * replacement glyph. Never logged: section 7 keeps clipboard content out of logs, analytics and
     * the sync feed, so this string exists only to be drawn.
     */
    fun preview(text: String): String {
        if (text.length <= PREVIEW_CHARS) return text
        var end = PREVIEW_CHARS
        if (Character.isHighSurrogate(text[end - 1])) end -= 1
        return text.substring(0, end) + "…"
    }

    fun textOffer(text: String, fromRemote: Boolean): RemoteClipboardOffer = RemoteClipboardOffer(
        kind = RemoteClipboardKind.TEXT,
        byteCount = text.toByteArray(Charsets.UTF_8).size,
        fromRemote = fromRemote,
        preview = preview(text),
    )
}
