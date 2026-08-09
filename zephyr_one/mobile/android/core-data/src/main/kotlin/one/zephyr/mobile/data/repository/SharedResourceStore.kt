package one.zephyr.mobile.data.repository

import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.model.SharedUsePolicy

/** One shared-to-me resource, as fetched online. Never persisted. */
data class SharedResourceSummary(
    val resourceType: String,
    val resourceId: String,
    val displayName: String,
    val ownerLabel: String,
    val capabilities: CapabilitySet,
    val usePolicy: SharedUsePolicy,
    val grantExpiresAt: Long?,
    val protocol: String?,
) {
    val residency: Residency get() = Residency.SHARED_ONLINE_ONLY
}

/**
 * In-memory-only store for shared-to-me resources.
 *
 * This class exists to make the residency rule structural. SHARED_RESOURCE_RESIDENCY.md 3 forbids
 * shared data from reaching Room, the SecretStore, FTS, preferences, files, logs or backups, so
 * there is no DAO for it anywhere in core-data and this store holds nothing across process death.
 *
 * [clear] is called on unbind, server switch, app lock and device revoke (section 130).
 */
class SharedResourceStore {

    private val summaries = MutableStateFlow<List<SharedResourceSummary>>(emptyList())
    private val fetchedAt = ConcurrentHashMap<String, Long>()

    val resources: StateFlow<List<SharedResourceSummary>> = summaries

    fun replace(list: List<SharedResourceSummary>, nowMs: Long) {
        summaries.value = list
        fetchedAt.clear()
        for (item in list) fetchedAt[key(item.resourceType, item.resourceId)] = nowMs
    }

    fun find(resourceType: String, resourceId: String): SharedResourceSummary? =
        summaries.value.firstOrNull { it.resourceType == resourceType && it.resourceId == resourceId }

    /**
     * Drops resources whose grant has expired.
     *
     * Shared resources vanish rather than degrade: there is no stale copy to fall back on, which is
     * the whole point of having no local mirror for them.
     */
    fun purgeExpired(nowMs: Long) {
        summaries.value = summaries.value.filter { item ->
            item.grantExpiresAt == null || item.grantExpiresAt > nowMs
        }
    }

    fun remove(resourceType: String, resourceId: String) {
        summaries.value = summaries.value.filterNot {
            it.resourceType == resourceType && it.resourceId == resourceId
        }
        fetchedAt.remove(key(resourceType, resourceId))
    }

    /** Called on unbind, server switch, app lock and revoke. */
    fun clear() {
        summaries.value = emptyList()
        fetchedAt.clear()
    }

    /**
     * Shared listings are always re-fetched rather than served from a cache that outlives the
     * screen, so this only reports staleness for a spinner decision.
     */
    fun isStale(resourceType: String, resourceId: String, nowMs: Long, maxAgeMs: Long): Boolean {
        val at = fetchedAt[key(resourceType, resourceId)] ?: return true
        return nowMs - at > maxAgeMs
    }

    private fun key(resourceType: String, resourceId: String): String = resourceType + "/" + resourceId
}
