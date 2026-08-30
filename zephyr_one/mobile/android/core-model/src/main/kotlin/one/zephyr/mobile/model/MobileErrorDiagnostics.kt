package one.zephyr.mobile.model

private const val MAX_LOCAL_DIAGNOSTIC_CHARS = 180

/**
 * Safe client-authored detail for a local protocol failure.
 *
 * Remote error messages and HTTP parser exceptions may contain server-controlled values. They stay
 * redacted to code/status/requestId. Call sites that validate a frozen local contract opt in by
 * setting [localDiagnostic] to a constant or a bounded validator message.
 */
fun MobileError.persistedDiagnosticText(): String = buildString {
    val localDetail = details[LOCAL_DIAGNOSTIC_DETAIL]
        ?.lineSequence()
        ?.firstOrNull()
        ?.take(MAX_LOCAL_DIAGNOSTIC_CHARS)
        ?.takeIf { it.isNotBlank() }
    if (localDetail != null) {
        append(localDetail)
        append(" · ")
    }
    append(diagnosticText())
}

fun MobileError.withLocalDiagnostic(localDiagnostic: String): MobileError = copy(
    details = details + (LOCAL_DIAGNOSTIC_DETAIL to localDiagnostic),
)

private const val LOCAL_DIAGNOSTIC_DETAIL = "clientLocalDiagnostic"
