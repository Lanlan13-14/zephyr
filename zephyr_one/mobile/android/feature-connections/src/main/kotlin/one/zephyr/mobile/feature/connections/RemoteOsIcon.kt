package one.zephyr.mobile.feature.connections

import one.zephyr.mobile.model.Connection

/**
 * What One writes back after it identifies a remote system.
 *
 * `icon` is an editable field, so the write goes through the normal save path and syncs to the
 * main end. `manual` is the user's own pick and is never overwritten, which is the same rule
 * `server.js` enforces before it probes.
 */
data class RemoteOsIconUpdate(val connection: Connection, val icon: String, val mask: List<String>)

/**
 * Identifying a remote OS and deciding whether that identification may replace the stored icon.
 *
 * The mapping is the main end's `mapOsReleaseToIconKey`, and the decision is its
 * `updateProbedConnectionIcon`: a manual choice stands, an unchanged probed value is not written
 * again, and everything else — including `auto` — takes the detected system.
 */
object RemoteOsIcon {

    /** Same command the main end runs for its probe. */
    const val PROBE_COMMAND = "cat /etc/os-release 2>/dev/null; echo; uname -s"

    /**
     * @return null when the text names nothing One has a glyph for. Guessing `linux` for an
     *   unrecognised banner would stamp the wrong system onto the connection.
     */
    fun iconKeyFromProbe(text: String): String? {
        val probe = text.lowercase()
        val id = Regex("""(?m)^id="?([a-z0-9_.-]+)"?""").find(probe)?.groupValues?.getOrNull(1).orEmpty()
        val pretty = Regex("""(?m)^pretty_name="?([^"\n]+)"?""").find(probe)?.groupValues?.getOrNull(1).orEmpty()
        val haystack = "$id $pretty $probe"
        val key = when {
            haystack.contains(Regex("""windows|\bwin\b""")) -> "windows"
            haystack.contains(Regex("""darwin|macos|osx""")) -> "macos"
            haystack.contains("ubuntu") -> "ubuntu"
            haystack.contains("debian") -> "debian"
            haystack.contains(Regex("""\barch|manjaro""")) -> "arch"
            haystack.contains("alpine") -> "alpine"
            haystack.contains(Regex("""raspberry|raspbian""")) -> "raspberry"
            haystack.contains(Regex("""rhel|redhat|centos|fedora|rocky|alma""")) -> "redhat"
            haystack.contains(Regex("""suse|opensuse|kali|gentoo|linux""")) -> "linux"
            else -> ""
        }
        return key.ifEmpty { null }
    }

    /**
     * @param manual true when the stored icon is the user's own choice. One does not mirror
     *   `iconSource`, so the caller decides this from what it knows about the row.
     */
    fun updateFor(connection: Connection, detected: String?, manual: Boolean): RemoteOsIconUpdate? {
        val icon = detected?.trim()?.lowercase().orEmpty()
        if (icon.isEmpty()) return null
        if (manual && connection.icon.isNotBlank() && connection.icon != "auto") return null
        if (connection.icon == icon) return null
        return RemoteOsIconUpdate(connection.copy(icon = icon), icon, listOf("icon"))
    }
}
