package one.zephyr.mobile.security

/**
 * Redaction for the diagnostics log export.
 *
 * SHARED_RESOURCE_RESIDENCY.md 143 requires a canary grep over logs to come up empty, and
 * MobileError.diagnosticText already limits errors to code + requestId. This object covers the
 * remaining free-form strings: host names, usernames, paths and anything shaped like a secret must
 * not reach an exported log.
 */
object DiagnosticsRedaction {

    private const val REDACTED = "[redacted]"

    private val patterns: List<Regex> = listOf(
        // Bearer/credential-looking tokens.
        Regex("(?i)(authorization|bearer|token|credential|password|passphrase|secret|apikey|api_key)\\s*[=:]\\s*\\S+"),
        // user@host and bare host:port.
        Regex("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+"),
        Regex("(?<![A-Za-z0-9])(?:\\d{1,3}\\.){3}\\d{1,3}(?::\\d+)?"),
        // PEM blocks and long base64 runs.
        Regex("-----BEGIN [A-Z ]+-----[\\s\\S]*?-----END [A-Z ]+-----"),
        Regex("(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/])"),
        // Absolute filesystem paths, POSIX and Windows.
        Regex("(?<![A-Za-z0-9])/(?:[A-Za-z0-9._-]+/){1,}[A-Za-z0-9._-]*"),
        Regex("(?i)[A-Z]:\\\\(?:[^\\\\\\s]+\\\\)*[^\\\\\\s]*"),
    )

    fun redact(line: String): String {
        var result = line
        for (pattern in patterns) result = pattern.replace(result, REDACTED)
        return result
    }

    fun redactAll(lines: List<String>): List<String> = lines.map(::redact)

    /**
     * Guard used by tests: a diagnostics bundle must not contain the shared canary or any of the
     * forbidden control-plane keys.
     */
    fun containsForbiddenMaterial(text: String, canaries: Collection<String>): Boolean =
        canaries.any { it.isNotEmpty() && text.contains(it) }
}
