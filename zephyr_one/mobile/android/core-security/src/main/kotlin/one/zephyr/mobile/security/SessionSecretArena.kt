package one.zephyr.mobile.security

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * Memory-only holder for shared-to-me credential material.
 *
 * SHARED_RESOURCE_RESIDENCY.md 3 forbids these bytes from reaching Room, the SecretStore, the
 * Keystore, files, preferences, logs, crash breadcrumbs, analytics, the clipboard or saved state.
 * This class is the only sanctioned home for them, and everything it holds is keyed by session so
 * a revoke, an expiry, an unbind or an app lock can drop it wholesale.
 *
 * Zeroing is best effort: the JVM may have copied the array during GC. That is why the leases are
 * short lived and single purpose rather than cached.
 */
class SessionSecretArena(
    private val clock: () -> Long = System::currentTimeMillis,
) : LockSensitiveSink {

    private class Lease(
        val sessionId: String,
        val resourceId: String,
        val purpose: String,
        val expiresAt: Long,
        val material: MutableMap<String, ByteArray>,
    )

    private val leases = ConcurrentHashMap<String, Lease>()
    private val purges = AtomicLong(0)

    /** Diagnostics counter; the arena never logs session or resource identifiers. */
    val purgeCount: Long get() = purges.get()

    val activeSessionIds: Set<String> get() = leases.keys.toSet()

    fun open(sessionId: String, resourceId: String, purpose: String, expiresAt: Long) {
        require(expiresAt > clock()) { "refusing to open an already expired shared session" }
        close(sessionId)
        leases[sessionId] = Lease(sessionId, resourceId, purpose, expiresAt, ConcurrentHashMap())
    }

    /**
     * @param value taken by reference and owned by the arena from here on; callers must not keep
     *   their own copy.
     */
    fun put(sessionId: String, field: String, value: ByteArray) {
        val lease = requireLive(sessionId)
        lease.material.put(field, value)?.fill(0)
    }

    /** @return a copy the caller must zero, or null when absent or expired. */
    fun take(sessionId: String, field: String): ByteArray? {
        val lease = leases[sessionId] ?: return null
        if (lease.expiresAt <= clock()) {
            close(sessionId)
            return null
        }
        return lease.material[field]?.copyOf()
    }

    /** Runs [block] with the material and zeroes the copy handed out. */
    fun <T> withField(sessionId: String, field: String, block: (ByteArray) -> T): T? {
        val value = take(sessionId, field) ?: return null
        return try {
            block(value)
        } finally {
            value.fill(0)
        }
    }

    fun isLive(sessionId: String): Boolean {
        val lease = leases[sessionId] ?: return false
        if (lease.expiresAt <= clock()) {
            close(sessionId)
            return false
        }
        return true
    }

    fun close(sessionId: String) {
        leases.remove(sessionId)?.let(::zero)
    }

    /** Owner revoked the ACL: every session for the resource dies immediately. */
    fun closeForResource(resourceId: String) {
        for (entry in leases.entries.toList()) {
            if (entry.value.resourceId == resourceId) close(entry.key)
        }
    }

    /** Called on a timer so an expired lease does not linger until its next use. */
    fun sweepExpired() {
        val now = clock()
        for (entry in leases.entries.toList()) {
            if (entry.value.expiresAt <= now) close(entry.key)
        }
    }

    /** Unbind, server switch, app lock and device revoke all funnel here. */
    fun purgeAll() {
        for (key in leases.keys.toList()) close(key)
        purges.incrementAndGet()
    }

    override fun onLocked() {
        purgeAll()
    }

    private fun requireLive(sessionId: String): Lease {
        val lease = leases[sessionId] ?: throw EnvelopeRejection.Expired
        if (lease.expiresAt <= clock()) {
            close(sessionId)
            throw EnvelopeRejection.Expired
        }
        return lease
    }

    private fun zero(lease: Lease) {
        for (value in lease.material.values) value.fill(0)
        lease.material.clear()
    }
}
