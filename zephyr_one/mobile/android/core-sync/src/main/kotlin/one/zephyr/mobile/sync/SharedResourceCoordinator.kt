package one.zephyr.mobile.sync

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import one.zephyr.mobile.data.repository.SharedResourceStore
import one.zephyr.mobile.data.repository.SharedResourceSummary
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.network.SharedResource
import one.zephyr.mobile.network.SharedResourceClient

/**
 * The shared-to-me reads the coordinator needs, as a port.
 *
 * An interface rather than the concrete [SharedResourceClient] for the same reason
 * [SyncTransport] exists: the client is a final class wrapping a final MobileApiClient, so a JVM
 * test could not substitute a fake and would have to stand up a real HTTP stack to assert a
 * residency rule. Narrowed to two methods because those are the two the coordinator calls -- a
 * port that mirrored the whole client would drag session opening into a type that has no business
 * with it.
 */
interface SharedResourceFetcher {

    suspend fun list(): ApiResult<List<SharedResource>>

    suspend fun detail(resourceType: String, resourceId: String): ApiResult<SharedResource>
}

/** [SharedResourceFetcher] over the real client. Thin by design; it adds no behaviour. */
class ApiSharedResourceFetcher(private val client: SharedResourceClient) : SharedResourceFetcher {

    override suspend fun list(): ApiResult<List<SharedResource>> = client.list()

    override suspend fun detail(resourceType: String, resourceId: String): ApiResult<SharedResource> =
        client.detail(resourceType, resourceId)
}

/**
 * The seam between the shared-to-me API and the in-memory store.
 *
 * This class exists because there was nothing joining the two. `SharedResourceClient` was
 * constructed in AccountContainer and never called; `SharedResourceStore.replace()` had no caller
 * anywhere in the tree. So the store was permanently empty, `ConnectionListViewModel` merged an
 * empty shared list into every render, and the three implemented endpoints were unreachable from the
 * device. That is the same failure shape as `driveProfileProvider = { null }`: every part present and
 * tested, nothing wired, and no error at runtime to say so.
 *
 * Deliberately NOT a repository. The repositories in core-data all mean "read the mirror, queue a
 * write", and a shared resource has neither a mirror nor a write queue. Naming this one too would
 * invite the next reader to give it a DAO.
 */
class SharedResourceCoordinator(
    private val client: SharedResourceFetcher,
    private val store: SharedResourceStore,
    private val clock: () -> Long = System::currentTimeMillis,
) {

    private val lastError = MutableStateFlow<MobileError?>(null)
    private val loaded = MutableStateFlow(false)

    /** The rows currently held in memory. Empty until [refresh] succeeds at least once. */
    val resources: StateFlow<List<SharedResourceSummary>> = store.resources

    /** The last fetch failure, or null. Drives the terminal/retryable branch in the list state. */
    val error: StateFlow<MobileError?> = lastError.asStateFlow()

    /**
     * False until the first fetch resolves.
     *
     * Distinct from "fetched and empty": the first says nothing is known yet, the second says the
     * owner shared nothing. The list state renders a spinner for one and an explanation for the
     * other, so collapsing them would show "nobody shared anything" while the request was still in
     * flight.
     */
    val hasLoaded: StateFlow<Boolean> = loaded.asStateFlow()

    /**
     * Re-fetches the whole list.
     *
     * A full replace rather than a merge, and that is the residency rule rather than a simplification:
     * a row the server no longer returns has had its grant withdrawn, so it must leave this device on
     * the same round. Merging would keep it visible, and a revoked resource surviving in the list is
     * exactly what SHARED_RESOURCE_RESIDENCY.md 3 forbids.
     */
    suspend fun refresh(): ApiResult<List<SharedResourceSummary>> {
        val result = client.list()
        return when (result) {
            is ApiResult.Success -> {
                val now = clock()
                val rows = result.value.map(::toSummary)
                store.replace(rows, now)
                /* Expiry is applied on the same pass. A grant whose window closed while the response
                 * was in flight must not be shown as live, and the server is not obliged to have
                 * filtered it: expiresAt is a deadline, not a delete. */
                store.purgeExpired(now)
                lastError.value = null
                loaded.value = true
                ApiResult.Success(store.resources.value, result.requestId)
            }
            is ApiResult.Failure -> {
                /* A vanished grant clears the list rather than leaving the previous one on screen.
                 * Any other failure keeps what is already held: a transient 503 is not evidence that
                 * the user lost access, and wiping the list would make a flaky network look like a
                 * revocation. */
                if (result.error.dismissesSharedResource) {
                    store.clear()
                }
                lastError.value = result.error
                loaded.value = true
                result
            }
        }
    }

    /**
     * Re-reads one resource.
     *
     * On a 404 or a revocation the row is dropped from the store immediately, before the caller has
     * a chance to render it again. The detail response is the first place the client learns a grant
     * is gone, and leaving the list row behind would offer an action that cannot succeed.
     */
    suspend fun refreshOne(resourceType: String, resourceId: String): ApiResult<SharedResourceSummary> {
        val result = client.detail(resourceType, resourceId)
        return when (result) {
            is ApiResult.Success -> {
                val summary = toSummary(result.value)
                val merged = store.resources.value
                    .filterNot { it.resourceType == resourceType && it.resourceId == resourceId }
                    .plus(summary)
                store.replace(merged, clock())
                ApiResult.Success(summary, result.requestId)
            }
            is ApiResult.Failure -> {
                if (result.error.dismissesSharedResource || result.error.httpStatus == 404) {
                    store.remove(resourceType, resourceId)
                }
                result
            }
        }
    }

    /**
     * Drops everything held in memory.
     *
     * Called on unbind, server switch, app lock and device revoke. Also resets [hasLoaded], so the
     * next screen shows a spinner rather than "nobody has shared anything with you" -- which would
     * be a false statement about the new account rather than a stale one about the old.
     */
    fun clear() {
        store.clear()
        lastError.value = null
        loaded.value = false
    }

    private companion object {

        /**
         * Maps the network row onto the store row.
         *
         * `ownerDisplayName` becomes `ownerLabel`: the wire name is the frozen schema property and
         * the store name is what the disclosure line renders. The endpoint fields the detail response
         * may carry (host, port, username) are deliberately dropped here rather than carried through
         * -- SHARED_RESOURCE_RESIDENCY.md 2 forbids storing the endpoint of a shared resource, and a
         * field that never enters the store cannot be rendered by accident.
         */
        fun toSummary(resource: SharedResource): SharedResourceSummary = SharedResourceSummary(
            resourceType = resource.resourceType,
            resourceId = resource.resourceId,
            displayName = resource.displayName,
            ownerLabel = resource.ownerDisplayName,
            capabilities = resource.capabilities,
            usePolicy = resource.usePolicy,
            grantExpiresAt = resource.expiresAt,
            protocol = resource.protocol,
        )
    }
}
