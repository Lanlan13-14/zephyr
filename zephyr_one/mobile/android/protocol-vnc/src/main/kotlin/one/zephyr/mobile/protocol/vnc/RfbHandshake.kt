package one.zephyr.mobile.protocol.vnc

import java.io.EOFException
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec

/**
 * A negotiated RFB protocol version.
 *
 * The three supported versions differ in ways that are easy to get subtly wrong, so each difference
 * is a named property rather than an inline version comparison scattered through the handshake:
 * 3.3 has the server dictate the security type, 3.7 lets the client choose, and 3.8 adds a
 * SecurityResult for the None type and a reason string on failure.
 */
data class RfbVersion(val major: Int, val minor: Int) : Comparable<RfbVersion> {

    /** The exact 12 bytes sent on the wire, e.g. "RFB 003.008\n". */
    val wire: String get() = "RFB " + pad3(major) + "." + pad3(minor) + "\n"

    fun encode(): ByteArray = wire.toByteArray(Charsets.US_ASCII)

    override fun compareTo(other: RfbVersion): Int = rank.compareTo(other.rank)

    override fun toString(): String = major.toString() + "." + minor

    private val rank: Int get() = major * 1000 + minor

    /** 3.7 replaced the server-dictated u32 security type with a client-chosen list. */
    val clientChoosesSecurity: Boolean get() = this >= V3_7

    /**
     * 3.8 sends SecurityResult even for the None type; 3.3 and 3.7 go straight to ClientInit.
     * Reading a SecurityResult that was never sent would consume the first four bytes of ServerInit
     * and desynchronise the whole session.
     */
    val sendsSecurityResultForNone: Boolean get() = this >= V3_8

    /** Only 3.8 appends a length-prefixed reason after a failed SecurityResult. */
    val securityFailureHasReason: Boolean get() = this >= V3_8

    companion object {
        const val WIRE_LENGTH = 12

        val V3_3 = RfbVersion(3, 3)
        val V3_7 = RfbVersion(3, 7)
        val V3_8 = RfbVersion(3, 8)

        /** ADR-005 gates on exactly these three. */
        val SUPPORTED = listOf(V3_3, V3_7, V3_8)

        /**
         * Strict parse of the 12-byte greeting.
         *
         * Returns null rather than throwing so the handshake reports one stable code; strictness is
         * deliberate because a plain HTTP or SSH server answering on 5900 must be rejected as a bad
         * greeting instead of being coerced into a version number.
         */
        fun parse(bytes: ByteArray): RfbVersion? {
            if (bytes.size != WIRE_LENGTH) return null
            val text = bytes.toString(Charsets.US_ASCII)
            if (!text.startsWith("RFB ") || text[7] != '.' || text[11] != '\n') return null
            val major = text.substring(4, 7).toIntOrNull() ?: return null
            val minor = text.substring(8, 11).toIntOrNull() ?: return null
            return RfbVersion(major, minor)
        }

        /**
         * Picks the highest supported version not above what the server offered.
         *
         * Clamping down rather than echoing is required: Apple Remote Desktop announces 003.889 and
         * expects a client that replies with a version it actually implements. Servers that offer an
         * unsupported minor between 3.3 and 3.7 fall back to 3.3, which every RFB server implements.
         */
        fun negotiate(serverOffer: RfbVersion): RfbVersion? =
            SUPPORTED.filter { it <= serverOffer }.maxOrNull()

        private fun pad3(value: Int): String = value.coerceIn(0, 999).toString().padStart(3, '0')
    }
}

/** RFB security type numbers. */
object RfbSecurityType {
    const val INVALID = 0
    const val NONE = 1
    const val VNC_AUTH = 2
    const val RA2 = 5
    const val RA2NE = 6
    const val TIGHT = 16
    const val ULTRA = 17
    const val TLS = 18
    const val VENCRYPT = 19
    const val SASL = 20
    const val MS_LOGON_II = 113
    const val APPLE_ARD = 30

    fun name(value: Int): String = when (value) {
        INVALID -> "Invalid"
        NONE -> "None"
        VNC_AUTH -> "VncAuth"
        RA2 -> "RA2"
        RA2NE -> "RA2ne"
        TIGHT -> "Tight"
        ULTRA -> "Ultra"
        TLS -> "TLS"
        VENCRYPT -> "VeNCrypt"
        SASL -> "SASL"
        APPLE_ARD -> "AppleARD"
        MS_LOGON_II -> "MsLogonII"
        else -> "Unknown(" + value + ")"
    }
}

/** Stable error codes for the handshake. The UI maps them to text; nothing branches on a message. */
object VncErrors {
    const val BAD_VERSION = "rfb_bad_version"
    const val VERSION_UNSUPPORTED = "rfb_version_unsupported"
    const val CONNECTION_REJECTED = "rfb_connection_rejected"
    const val NO_SUPPORTED_SECURITY = "rfb_no_supported_security"
    const val PASSWORD_REQUIRED = "rfb_password_required"
    const val AUTH_FAILED = "rfb_auth_failed"
    const val TOO_MANY_ATTEMPTS = "rfb_too_many_attempts"
    const val BAD_PIXEL_FORMAT = "rfb_bad_pixel_format"
    const val BAD_FRAMEBUFFER_SIZE = "rfb_bad_framebuffer_size"
    const val TRUNCATED = "rfb_truncated"
    const val CONNECTION_FAILED = "rfb_connection_failed"
    const val CONNECTION_TIMEOUT = "rfb_connection_timeout"
    const val PROTOCOL_ERROR = "rfb_protocol_error"
    const val SESSION_NOT_FOUND = "rfb_session_not_found"
    const val ENGINE_UNAVAILABLE = "vnc_engine_unavailable"
}

sealed interface RfbSecuritySelection {
    data class Selected(val type: Int) : RfbSecuritySelection
    data class Rejected(val code: String, val detail: String) : RfbSecuritySelection
}

/**
 * Chooses one security type from what the server offered.
 *
 * This is the ADR-005 "未知 security type 拒绝" gate and the reason it is a standalone pure function:
 * the failure mode it prevents is a client that meets an unrecognised type, assumes no
 * authentication, and hands the framebuffer to whoever answered the port. Anything outside the two
 * implemented types is refused by name so the error tells the user which mechanism their server
 * wants.
 */
object RfbSecurityNegotiator {

    /** Only these two are implemented. VeNCrypt, RA2, Tight and ARD are explicitly out of scope. */
    val SUPPORTED = setOf(RfbSecurityType.NONE, RfbSecurityType.VNC_AUTH)

    fun select(offered: List<Int>, hasPassword: Boolean): RfbSecuritySelection {
        if (offered.isEmpty()) {
            return RfbSecuritySelection.Rejected(VncErrors.NO_SUPPORTED_SECURITY, "Server offered no security types")
        }

        // Prefer VncAuth when a password is available: if a server offers both, using None would
        // silently drop the authentication the user configured.
        if (RfbSecurityType.VNC_AUTH in offered && hasPassword) {
            return RfbSecuritySelection.Selected(RfbSecurityType.VNC_AUTH)
        }
        if (RfbSecurityType.NONE in offered) {
            return RfbSecuritySelection.Selected(RfbSecurityType.NONE)
        }
        if (RfbSecurityType.VNC_AUTH in offered) {
            return RfbSecuritySelection.Rejected(
                VncErrors.PASSWORD_REQUIRED,
                "The server requires a VNC password",
            )
        }
        return RfbSecuritySelection.Rejected(
            VncErrors.NO_SUPPORTED_SECURITY,
            "Unsupported security types: " + offered.joinToString(", ") { RfbSecurityType.name(it) },
        )
    }
}

/**
 * VNC Authentication (security type 2).
 *
 * DES with the key bits mirrored. The mirroring is not a cipher choice but an accident of the
 * original AT&T implementation that every server now depends on, so it is implemented exactly and
 * pinned by a test vector cross-checked against an independent DES implementation.
 *
 * The scheme is weak by modern standards - 8 significant password bytes, single DES, no channel
 * binding. It is implemented because servers require it, and the transport-level protections stay
 * the caller's responsibility.
 */
object VncAuth {

    const val KEY_BYTES = 8
    const val CHALLENGE_BYTES = 16

    /**
     * Derives the DES key: Latin-1 bytes of the password, padded with zeros or truncated to 8, each
     * byte bit-reversed. Passwords longer than 8 characters silently lose the tail, which is what
     * the servers do too.
     */
    fun mirrorKey(password: CharArray): ByteArray {
        val key = ByteArray(KEY_BYTES)
        for (index in 0 until KEY_BYTES) {
            val raw = if (index < password.size) password[index].code and 0xFF else 0
            key[index] = mirrorByte(raw).toByte()
        }
        return key
    }

    /** Encrypts the 16-byte challenge as two independent ECB blocks. */
    fun response(password: CharArray, challenge: ByteArray): ByteArray {
        require(challenge.size == CHALLENGE_BYTES) {
            "challenge must be " + CHALLENGE_BYTES + " bytes but was " + challenge.size
        }
        val key = mirrorKey(password)
        try {
            val cipher = Cipher.getInstance("DES/ECB/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "DES"))
            return cipher.doFinal(challenge)
        } finally {
            // SecretKeySpec copies the key, so wiping the local array leaves no second copy of
            // material derived from the user's password on the heap.
            key.fill(0)
        }
    }

    internal fun mirrorByte(value: Int): Int {
        var input = value and 0xFF
        var mirrored = 0
        for (bit in 0 until 8) {
            mirrored = (mirrored shl 1) or (input and 1)
            input = input shr 1
        }
        return mirrored
    }
}

/**
 * The byte transport the handshake runs over.
 *
 * Narrow on purpose: the handshake is the part of RFB that must be reviewable and testable without a
 * socket, and ADR-005 keeps the framebuffer core behind a licence audit. A fake channel over a byte
 * queue exercises every branch below.
 */
interface RfbByteChannel {
    /** Reads exactly [count] bytes, or throws [EOFException] if the peer closed first. */
    suspend fun readFully(count: Int): ByteArray

    suspend fun write(bytes: ByteArray)
}

/** Everything ServerInit reported, after validation. */
data class RfbSessionInfo(
    val version: RfbVersion,
    val securityType: Int,
    val width: Int,
    val height: Int,
    val pixelFormat: RfbPixelFormat,
    val desktopName: String,
)

sealed interface RfbHandshakeOutcome {
    data class Ready(val session: RfbSessionInfo) : RfbHandshakeOutcome

    /** [code] is one of [VncErrors]; [detail] carries any server-supplied reason for display. */
    data class Rejected(val code: String, val detail: String) : RfbHandshakeOutcome
}

/**
 * Drives RFB from the version greeting through ServerInit.
 *
 * Written as real logic rather than a stub even though ADR-005 blocks the framebuffer core: the
 * handshake is pure byte protocol, it is where the security decisions live, and it is the piece a
 * later core swap must not silently reimplement. Everything after ServerInit - encodings, rectangle
 * decoding, incremental updates - stays behind [VncEngine].
 */
object RfbHandshake {

    /**
     * Upper bound on any server-supplied string.
     *
     * ServerInit's name length and the failure reason length are both u32 read straight off an
     * untrusted socket; without a cap a hostile or confused server allocates 4 GiB on a phone.
     */
    const val MAX_STRING_BYTES = 4096

    suspend fun perform(
        channel: RfbByteChannel,
        password: CharArray? = null,
        /** False asks the server to disconnect other viewers, per the ClientInit shared flag. */
        shareDesktop: Boolean = true,
    ): RfbHandshakeOutcome = try {
        runHandshake(channel, password, shareDesktop)
    } catch (truncated: EOFException) {
        RfbHandshakeOutcome.Rejected(
            VncErrors.TRUNCATED,
            "The server closed the connection during the handshake",
        )
    } catch (malformed: IllegalArgumentException) {
        // Only RfbPixelFormat.decode and the challenge length check throw this, and both mean the
        // server sent a structurally impossible value.
        RfbHandshakeOutcome.Rejected(
            VncErrors.BAD_PIXEL_FORMAT,
            malformed.message ?: "Malformed pixel format",
        )
    }

    private suspend fun runHandshake(
        channel: RfbByteChannel,
        password: CharArray?,
        shareDesktop: Boolean,
    ): RfbHandshakeOutcome {
        val offered = RfbVersion.parse(channel.readFully(RfbVersion.WIRE_LENGTH))
            ?: return RfbHandshakeOutcome.Rejected(
                VncErrors.BAD_VERSION,
                "Not an RFB server: the greeting was not a version string",
            )
        val agreed = RfbVersion.negotiate(offered)
            ?: return RfbHandshakeOutcome.Rejected(
                VncErrors.VERSION_UNSUPPORTED,
                "Server speaks RFB " + offered + "; 3.3 is the minimum",
            )
        channel.write(agreed.encode())

        val types = readOfferedSecurityTypes(channel, agreed)
        if (types is SecurityOffer.ServerRejected) {
            return RfbHandshakeOutcome.Rejected(VncErrors.CONNECTION_REJECTED, types.reason)
        }
        val offeredTypes = (types as SecurityOffer.Types).values

        val hasPassword = password != null && password.isNotEmpty()
        val chosen = when (val selection = RfbSecurityNegotiator.select(offeredTypes, hasPassword)) {
            is RfbSecuritySelection.Rejected ->
                return RfbHandshakeOutcome.Rejected(selection.code, selection.detail)
            is RfbSecuritySelection.Selected -> selection.type
        }

        // 3.3 has no echo step: the server already dictated the type.
        if (agreed.clientChoosesSecurity) {
            channel.write(byteArrayOf(chosen.toByte()))
        }

        if (chosen == RfbSecurityType.VNC_AUTH) {
            val challenge = channel.readFully(VncAuth.CHALLENGE_BYTES)
            channel.write(VncAuth.response(password!!, challenge))
        }

        val expectsResult = chosen == RfbSecurityType.VNC_AUTH || agreed.sendsSecurityResultForNone
        if (expectsResult) {
            val result = readU32(channel)
            if (result != SECURITY_RESULT_OK) {
                val reason = if (agreed.securityFailureHasReason) readString(channel) else ""
                return RfbHandshakeOutcome.Rejected(
                    if (result == SECURITY_RESULT_TOO_MANY) VncErrors.TOO_MANY_ATTEMPTS else VncErrors.AUTH_FAILED,
                    reason.ifBlank { defaultFailureText(result) },
                )
            }
        }

        channel.write(byteArrayOf(if (shareDesktop) 1 else 0))

        val header = channel.readFully(SERVER_INIT_HEADER_BYTES)
        val width = RfbPixelFormat.readU16(header, 0)
        val height = RfbPixelFormat.readU16(header, 2)
        if (width == 0 || height == 0) {
            return RfbHandshakeOutcome.Rejected(
                VncErrors.BAD_FRAMEBUFFER_SIZE,
                "Server reported a " + width + "x" + height + " framebuffer",
            )
        }
        val pixelFormat = RfbPixelFormat.decode(header, 4)
        val nameLength = readU32At(header, 20)
        if (nameLength > MAX_STRING_BYTES) {
            return RfbHandshakeOutcome.Rejected(
                VncErrors.PROTOCOL_ERROR,
                "Desktop name is too large: " + nameLength + " bytes",
            )
        }
        val name = if (nameLength <= 0) {
            ""
        } else {
            channel.readFully(nameLength).toString(Charsets.UTF_8)
        }

        return RfbHandshakeOutcome.Ready(
            RfbSessionInfo(
                version = agreed,
                securityType = chosen,
                width = width,
                height = height,
                pixelFormat = pixelFormat,
                desktopName = name,
            ),
        )
    }

    private sealed interface SecurityOffer {
        data class Types(val values: List<Int>) : SecurityOffer
        data class ServerRejected(val reason: String) : SecurityOffer
    }

    private suspend fun readOfferedSecurityTypes(channel: RfbByteChannel, version: RfbVersion): SecurityOffer =
        if (version.clientChoosesSecurity) {
            val count = channel.readFully(1)[0].toInt() and 0xFF
            // A zero count is the 3.7+ way of refusing the connection outright, e.g. an IP block.
            if (count == 0) SecurityOffer.ServerRejected(readString(channel))
            else SecurityOffer.Types(channel.readFully(count).map { it.toInt() and 0xFF })
        } else {
            val single = readU32(channel)
            if (single == RfbSecurityType.INVALID) SecurityOffer.ServerRejected(readString(channel))
            else SecurityOffer.Types(listOf(single))
        }

    /** A u32 length followed by that many bytes. Capped, and decoded leniently for display only. */
    private suspend fun readString(channel: RfbByteChannel): String {
        val length = readU32(channel)
        if (length <= 0) return ""
        return channel.readFully(minOf(length, MAX_STRING_BYTES)).toString(Charsets.UTF_8)
    }

    private suspend fun readU32(channel: RfbByteChannel): Int = readU32At(channel.readFully(4), 0)

    /**
     * Reads a big-endian u32 as a saturating Int.
     *
     * Every u32 in this handshake is a length or a small enum, so clamping a value above 2^31 to
     * Int.MAX_VALUE is safe and keeps the caller from having to handle a negative "length".
     */
    private fun readU32At(bytes: ByteArray, offset: Int): Int {
        val high = ((bytes[offset].toInt() and 0xFF) shl 8) or (bytes[offset + 1].toInt() and 0xFF)
        val low = ((bytes[offset + 2].toInt() and 0xFF) shl 8) or (bytes[offset + 3].toInt() and 0xFF)
        val value = (high.toLong() shl 16) or low.toLong()
        return if (value > Int.MAX_VALUE) Int.MAX_VALUE else value.toInt()
    }

    private fun defaultFailureText(result: Int): String = when (result) {
        SECURITY_RESULT_TOO_MANY -> "Too many failed authentication attempts"
        else -> "The server rejected the credentials"
    }

    /** u16 width + u16 height + 16-byte pixel format + u32 name length. */
    private const val SERVER_INIT_HEADER_BYTES = 24
    private const val SECURITY_RESULT_OK = 0
    private const val SECURITY_RESULT_TOO_MANY = 2
}
