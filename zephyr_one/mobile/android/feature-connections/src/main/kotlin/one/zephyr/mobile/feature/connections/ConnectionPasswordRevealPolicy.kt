package one.zephyr.mobile.feature.connections

/** Fail-closed gate for showing or performing a stored connection-password reveal. */
object ConnectionPasswordRevealPolicy {
    fun allowed(
        localUnlockEnabled: Boolean,
        hasStoredPassword: Boolean,
        canRevealSecret: Boolean,
    ): Boolean = localUnlockEnabled && hasStoredPassword && canRevealSecret
}
