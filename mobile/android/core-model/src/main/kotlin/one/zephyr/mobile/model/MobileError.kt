package one.zephyr.mobile.model

import one.zephyr.mobile.contracts.ErrorRegistry

/**
 * Structured error decoded from the mobile v1 envelope. Clients branch on [code] only;
 * [message] is display text and must never drive control flow.
 */
data class MobileError(
    val code: String,
    val message: String,
    val retryable: Boolean,
    val requestId: String?,
    val details: Map<String, String> = emptyMap(),
    val httpStatus: Int? = null,
    val retryAfterSeconds: Long? = null,
) {
    val clientAction: String get() = ErrorRegistry.clientAction(code)

    /** True when the registry agrees the code is retryable; unknown codes are never retried. */
    val isRegistryRetryable: Boolean get() = ErrorRegistry.retryable(code)

    val requiresSensitiveVerification: Boolean
        get() = code == "sensitive_verification_required" ||
            code == "sensitive_grant_expired" ||
            code == "sensitive_grant_consumed"

    val requiresRebind: Boolean
        get() = clientAction == "rebind" || code == "token_rotated" || code == "client_revoked"

    val requiresBootstrapRestart: Boolean
        get() = code == "cursor_expired" || code == "cursor_invalid" || code == "bootstrap_expired"

    /** Shared resources vanish rather than degrade; the viewer must close and purge memory. */
    val dismissesSharedResource: Boolean
        get() = code == "shared_grant_revoked" || code == "shared_grant_expired"

    /** Diagnostics copy is requestId + code only: never host, user, path or secret. */
    fun diagnosticText(): String = buildString {
        append("code=").append(code)
        if (httpStatus != null) append(" status=").append(httpStatus)
        if (requestId != null) append(" requestId=").append(requestId)
    }

    companion object {
        fun local(code: String, message: String, retryable: Boolean = false): MobileError =
            MobileError(code = code, message = message, retryable = retryable, requestId = null)

        val offline = local("network_offline", "No network connection", retryable = true)
    }
}

class MobileApiException(val error: MobileError) : Exception(error.code + ": " + error.message)
