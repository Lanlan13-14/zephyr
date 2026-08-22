// GENERATED FILE - DO NOT EDIT.
// Source: mobile/contracts. Regenerate with `node mobile/tools/generate.mjs`.

package one.zephyr.mobile.contracts

/** Stable mobile v1 error code. Clients branch on `code`, never on `message`. */
data class MobileErrorSpec(
    val code: String,
    val httpStatus: Int,
    val retryable: Boolean,
    val clientAction: String,
)

object ErrorRegistry {
    const val VERSION: Int = 1

    val errors: List<MobileErrorSpec> = listOf(
        MobileErrorSpec("account_locked", 429, true, "wait_then_retry"),
        MobileErrorSpec("account_suspended", 403, false, "contact_admin"),
        MobileErrorSpec("account_unavailable", 403, false, "contact_admin"),
        MobileErrorSpec("app_session_expired", 401, false, "sign_in"),
        MobileErrorSpec("blob_hash_mismatch", 422, true, "restart_blob"),
        MobileErrorSpec("blob_missing_chunk", 409, true, "resume_blob"),
        MobileErrorSpec("bootstrap_expired", 410, false, "restart_bootstrap"),
        MobileErrorSpec("captcha_required", 403, false, "open_auth_session"),
        MobileErrorSpec("client_disabled", 403, false, "enable_on_server"),
        MobileErrorSpec("client_not_found", 404, false, "bind_device"),
        MobileErrorSpec("client_owned_by_other", 409, false, "regenerate_device_id"),
        MobileErrorSpec("client_revoked", 403, false, "rebind"),
        MobileErrorSpec("cursor_expired", 410, false, "restart_bootstrap"),
        MobileErrorSpec("cursor_invalid", 409, false, "restart_bootstrap"),
        MobileErrorSpec("dependency_missing", 409, true, "retry_after_dependency"),
        MobileErrorSpec("device_proof_invalid", 401, false, "refresh_or_rebind"),
        MobileErrorSpec("enrollment_consumed", 409, false, "restart_enrollment"),
        MobileErrorSpec("enrollment_denied", 403, false, "restart_enrollment"),
        MobileErrorSpec("enrollment_expired", 410, false, "restart_enrollment"),
        MobileErrorSpec("enrollment_not_approved", 403, true, "wait_then_retry"),
        MobileErrorSpec("enrollment_secret_invalid", 403, false, "restart_enrollment"),
        MobileErrorSpec("duplicate_operation", 200, false, "accept_original_result"),
        MobileErrorSpec("forbidden_dependency_jumpConnection", 403, false, "repair_route"),
        MobileErrorSpec("forbidden_dependency_jumpHost", 403, false, "repair_route"),
        MobileErrorSpec("forbidden_dependency_proxy", 403, false, "repair_route"),
        MobileErrorSpec("forbidden_dependency_sshKey", 403, false, "repair_route"),
        MobileErrorSpec("forbidden_resource_delete", 403, false, "show_permission"),
        MobileErrorSpec("forbidden_resource_edit", 403, false, "show_permission"),
        MobileErrorSpec("forbidden_resource_revealSecret", 403, false, "show_permission"),
        MobileErrorSpec("forbidden_resource_use", 403, false, "show_permission"),
        MobileErrorSpec("internal_error", 500, true, "backoff_then_report"),
        MobileErrorSpec("invalid_credentials", 401, false, "correct_credentials"),
        MobileErrorSpec("invalid_dependency", 400, false, "repair_route"),
        MobileErrorSpec("invalid_request", 400, false, "fix_input"),
        MobileErrorSpec("login_guard_blocked", 403, false, "show_server_policy"),
        MobileErrorSpec("metadata_too_large", 413, false, "split_payload"),
        MobileErrorSpec("must_change_password", 403, false, "open_system_browser"),
        MobileErrorSpec("note_revision_conflict", 409, false, "open_conflict"),
        MobileErrorSpec("payload_too_large", 413, false, "split_payload"),
        MobileErrorSpec("rate_limited", 429, true, "respect_retry_after"),
        MobileErrorSpec("refresh_replayed", 401, false, "rebind"),
        MobileErrorSpec("registry_mismatch", 409, false, "upgrade_or_refresh_registry"),
        MobileErrorSpec("resource_not_found_or_inaccessible", 404, false, "remove_or_refresh"),
        MobileErrorSpec("revision_conflict", 409, false, "open_conflict"),
        MobileErrorSpec("revision_required", 400, false, "refresh_entity"),
        MobileErrorSpec("sensitive_grant_consumed", 409, false, "verify_sensitive_action"),
        MobileErrorSpec("sensitive_grant_expired", 403, false, "verify_sensitive_action"),
        MobileErrorSpec("sensitive_verification_failed", 403, false, "retry_sensitive_action"),
        MobileErrorSpec("sensitive_verification_required", 403, false, "verify_sensitive_action"),
        MobileErrorSpec("server_unavailable", 503, true, "backoff"),
        MobileErrorSpec("shared_content_export_forbidden", 403, false, "disableExport"),
        MobileErrorSpec("shared_direct_forbidden", 403, false, "offerRelay"),
        MobileErrorSpec("shared_grant_expired", 410, false, "dismissShared"),
        MobileErrorSpec("shared_grant_revoked", 410, false, "dismissShared"),
        MobileErrorSpec("shared_online_required", 503, true, "retry"),
        MobileErrorSpec("shared_relay_unavailable", 503, true, "retryRelayOnly"),
        MobileErrorSpec("shared_residency_violation", 409, false, "abortSyncAndPurgeShared"),
        MobileErrorSpec("shared_session_consumed", 409, false, "mintFreshSessionEnvelope"),
        MobileErrorSpec("shared_session_expired", 410, false, "reopenSharedSession"),
        MobileErrorSpec("sync_conflict", 409, false, "open_conflict"),
        MobileErrorSpec("token_missing", 403, false, "rebind"),
        MobileErrorSpec("token_not_found", 404, false, "select_valid_token"),
        MobileErrorSpec("token_required", 400, false, "create_token_on_server"),
        MobileErrorSpec("token_rotated", 401, false, "rebind"),
        MobileErrorSpec("totp_invalid", 401, false, "retry_totp"),
        MobileErrorSpec("totp_required", 401, false, "enter_totp"),
        MobileErrorSpec("totp_temp_exhausted", 401, false, "restart_sign_in"),
        MobileErrorSpec("unknown_entity_type", 400, false, "upgrade_or_drop_operation"),
        MobileErrorSpec("unsupported_protocol_version", 400, false, "upgrade_app"),
        MobileErrorSpec("unsupported_scope", 400, false, "drop_operation_and_report"),
        MobileErrorSpec("workspace_revision_conflict", 409, false, "open_conflict"),
    )

    val byCode: Map<String, MobileErrorSpec> = errors.associateBy { it.code }

    fun retryable(code: String): Boolean = byCode[code]?.retryable ?: false

    fun clientAction(code: String): String = byCode[code]?.clientAction ?: "report_unknown_error"

    /** Codes that invalidate the local cursor and force a fresh bootstrap. */
    val bootstrapResetCodes: List<String> = errors
        .filter { it.clientAction == "restart_bootstrap" }
        .map { it.code }

    /** Codes that mean the binding must be re-established before syncing again. */
    val rebindCodes: List<String> = errors
        .filter { it.clientAction == "rebind" || it.clientAction == "refresh_or_rebind" }
        .map { it.code }
}
