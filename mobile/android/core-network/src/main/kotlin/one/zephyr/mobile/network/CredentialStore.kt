package one.zephyr.mobile.network

import one.zephyr.mobile.model.SecretRef
import one.zephyr.mobile.security.SecretStore

/**
 * Where the three credentials live.
 *
 * ZEPHYR_PARITY.md 32 splits the planes deliberately:
 *  - the SID is a management-plane credential used for bind and account administration only;
 *  - the short-lived access credential carries the data plane;
 *  - the refresh credential is single-use and must never be sent as a bearer token.
 *
 * All three go through the SecretStore so they are sealed by Keystore material and are dropped by
 * an unbind, a device revoke or a wipe along with everything else.
 */
class CredentialStore(private val secretStore: SecretStore) {

    private val accessRef = SecretRef.of(SCOPE, "current", "accessCredential")
    private val refreshRef = SecretRef.of(SCOPE, "current", "refreshCredential")
    private val sidRef = SecretRef.of(SCOPE, "current", "sid")

    @Volatile
    private var accessExpiresAt: Long? = null

    fun accessCredential(): String? = secretStore.getText(accessRef)

    fun refreshCredential(): String? = secretStore.getText(refreshRef)

    fun sid(): String? = secretStore.getText(sidRef)

    fun accessExpiresAt(): Long? = accessExpiresAt

    /** True when the access credential is missing or within the skew window of expiry. */
    fun accessNeedsRefresh(nowMs: Long): Boolean {
        if (secretStore.getText(accessRef) == null) return true
        val expiry = accessExpiresAt ?: return false
        return nowMs >= expiry - EXPIRY_SKEW_MS
    }

    fun storeAccess(credential: String, expiresAt: Long?) {
        secretStore.putText(accessRef, credential)
        accessExpiresAt = expiresAt
    }

    /**
     * The refresh credential rotates on every use, so storing the new one replaces the old one
     * atomically from the caller's point of view: there is never a moment with two valid refreshes.
     */
    fun storeRefresh(credential: String) {
        secretStore.putText(refreshRef, credential)
    }

    fun storeSid(sid: String) {
        secretStore.putText(sidRef, sid)
    }

    /** sid_expired only invalidates the management plane; the data plane keeps working. */
    fun clearSid() {
        secretStore.remove(sidRef)
    }

    fun clearAll() {
        secretStore.remove(accessRef)
        secretStore.remove(refreshRef)
        secretStore.remove(sidRef)
        accessExpiresAt = null
    }

    private companion object {
        const val SCOPE = "credential"

        /** Refresh slightly early so an in-flight request does not race the expiry. */
        const val EXPIRY_SKEW_MS = 60_000L
    }
}
