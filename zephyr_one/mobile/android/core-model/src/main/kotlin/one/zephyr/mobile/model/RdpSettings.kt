package one.zephyr.mobile.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * RDP enumerations and defaults frozen by ZEPHYR_PARITY.md 5.2. These values are product
 * contract, not renderer hints: the native engine reports the value it actually negotiated.
 */
enum class RdpSoundMode(val wireName: String) {
    LOCAL("local"), REMOTE("remote"), OFF("off");
    companion object {
        val default = LOCAL
        fun fromWire(value: String?) = entries.firstOrNull { it.wireName == value } ?: default
    }
}

enum class RdpResolution(val wireName: String) {
    AUTO("auto"), P1080("1080p"), K2("2K"), K4("4K"), K8("8K");
    companion object {
        val default = P1080
        fun fromWire(value: String?) = entries.firstOrNull { it.wireName == value } ?: default
    }
}

enum class RdpQuality(val wireName: String) {
    BALANCED("balanced"), PERFORMANCE("performance"), QUALITY("quality");
    companion object {
        val default = BALANCED
        fun fromWire(value: String?) = entries.firstOrNull { it.wireName == value } ?: default
    }
}

enum class RdpFps(val value: Int) {
    F30(30), F45(45), F60(60), F120(120), F144(144);
    companion object {
        val default = F30
        fun fromValue(value: Int?) = entries.firstOrNull { it.value == value } ?: default
    }
}

/** direct maps a finger to the remote pointer; relative drives it like a trackpad. */
enum class RdpTouchMode(val wireName: String) {
    DIRECT("direct"), RELATIVE("relative");
    companion object {
        val default = DIRECT
        fun fromWire(value: String?) = entries.firstOrNull { it.wireName == value } ?: default
    }
}

/** Where a connection wants device files exposed. The grant itself is never portable. */
enum class FileSyncDirectoryIntent(val wireName: String) {
    OFF("off"), ASK("ask"), LOCAL_SHARE("local_share"), SERVER_BRIDGE("server_bridge");
    companion object {
        val default = OFF
        fun fromWire(value: String?) = entries.firstOrNull { it.wireName == value } ?: default
    }
}

@Serializable
data class RdpSettings(
    @SerialName("rdpSoundMode") val soundMode: RdpSoundMode = RdpSoundMode.default,
    @SerialName("rdpClipboard") val clipboard: Boolean = true,
    @SerialName("rdpMicrophone") val microphone: Boolean = false,
    @SerialName("rdpCamera") val camera: Boolean = false,
    @SerialName("rdpStorage") val storage: Boolean = false,
    @SerialName("rdpLocation") val location: Boolean = false,
    @SerialName("rdpResolution") val resolution: RdpResolution = RdpResolution.default,
    @SerialName("rdpQuality") val quality: RdpQuality = RdpQuality.default,
    @SerialName("rdpFps") val fps: RdpFps = RdpFps.default,
    @SerialName("rdpTouchMode") val touchMode: RdpTouchMode = RdpTouchMode.default,
    @SerialName("rdpTouchSensitivity") val touchSensitivity: Float = DEFAULT_SENSITIVITY,
    @SerialName("rdpDomain") val domain: String = "",
) {
    init {
        require(touchSensitivity in MIN_SENSITIVITY..MAX_SENSITIVITY) {
            "rdpTouchSensitivity must be within " + MIN_SENSITIVITY + ".." + MAX_SENSITIVITY
        }
    }

    /** Channels the session may request. A denied permission closes one channel, not the session. */
    val requestedChannels: Set<RdpChannel>
        get() = buildSet {
            if (soundMode != RdpSoundMode.OFF) add(RdpChannel.AUDIO)
            if (clipboard) add(RdpChannel.CLIPBOARD)
            if (microphone) add(RdpChannel.MICROPHONE)
            if (camera) add(RdpChannel.CAMERA)
            if (storage) add(RdpChannel.DRIVE)
            if (location) add(RdpChannel.LOCATION)
        }

    companion object {
        const val MIN_SENSITIVITY = 0.5f
        const val MAX_SENSITIVITY = 3.0f
        const val DEFAULT_SENSITIVITY = 1.5f

        fun clampSensitivity(value: Float): Float =
            value.coerceIn(MIN_SENSITIVITY, MAX_SENSITIVITY)
    }
}

enum class RdpChannel { AUDIO, CLIPBOARD, MICROPHONE, CAMERA, DRIVE, LOCATION }
