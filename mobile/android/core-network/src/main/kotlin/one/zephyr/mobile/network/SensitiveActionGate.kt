package one.zephyr.mobile.network

import java.util.concurrent.ConcurrentHashMap
import one.zephyr.mobile.model.SensitiveGrant

/** Actions the main end requires a fresh password or TOTP for. */
enum class SensitiveAction(val wireName: String) {
    DEVICE_REVOKE("device.revoke"),
    TOKEN_REVEAL("token.reveal"),
    TOKEN_ROTATE("token.rotate"),
    TOKEN_DELETE("token.delete"),
    TOKEN_RESET_ALL("token.resetAll"),
    BACKUP_IMPORT("backup.import"),
    ;

    companion object {
        fun fromWire(value: String?): SensitiveAction? = entries.firstOrNull { it.wireName == value }
    }
}

/**
 * Holds one-shot sensitive grants.
 *
 * DEVELOPMENT.md 617 requires these actions to go through the main end's verifySensitiveAccess
 * equivalent, and PRODUCT_REQUIREMENTS.md 12 makes bypassing it for a device delete or a token reset
 * a release blocker. App Lock is explicitly *not* a substitute: biometrics prove who is holding the
 * phone, not that the account password or TOTP is known.
 *
 * Grants are memory-only and single-use. Persisting one would turn a momentary proof into a standing
 * capability that survives an app restart.
 */
class SensitiveActionGate(private val api: MobileApi, private val clock: () -> Long = System::currentTimeMillis) {

    private val grants = ConcurrentHashMap<String, SensitiveGrant>()

    /** Verifies with the main end and stores the grant for a single subsequent call. */
    suspend fun verify(
        action: SensitiveAction,
        secret: String,
        targetIds: List<String>,
    ): ApiResult<SensitiveGrant> {
        val result = api.verifySensitive(action.wireName, secret, targetIds)
        if (result is ApiResult.Success) {
            grants[key(action, targetIds.firstOrNull())] = result.value
        }
        return result
    }

    /**
     * Consumes a grant.
     *
     * Removal happens before the caller uses it, so a failed request cannot be retried on the same
     * proof. The user re-authenticates instead, which is the intent of a one-shot grant.
     */
    fun consume(action: SensitiveAction, targetId: String?): SensitiveGrant? {
        val grant = grants.remove(key(action, targetId)) ?: return null
        if (!grant.isValidAt(clock())) return null
        if (!grant.matches(action.wireName, targetId)) return null
        return grant
    }

    fun peekValid(action: SensitiveAction, targetId: String?): Boolean =
        grants[key(action, targetId)]?.isValidAt(clock()) == true

    /** Called on app lock, unbind and background: a pending proof must not outlive the screen. */
    fun clear() {
        grants.clear()
    }

    private fun key(action: SensitiveAction, targetId: String?): String =
        action.wireName + "::" + (targetId ?: "")
}
