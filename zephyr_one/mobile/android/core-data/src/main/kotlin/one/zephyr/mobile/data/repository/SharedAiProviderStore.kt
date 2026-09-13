package one.zephyr.mobile.data.repository

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * In-memory cache of shared-to-me AI providers (SHARED_RESOURCE_RESIDENCY §3:
 * shared-to-me never touches disk). Holds only selection metadata — the server
 * projection for a bound device strips apiKey and every credential-like field,
 * so there is no secret here to begin with. Requests against these rows are
 * relayed by the server (`resolveForUse`); the key never leaves the owner's
 * server.
 *
 * Cleared wholesale on unbind/rebind by the caller discarding the container.
 */
class SharedAiProviderStore {
    data class SharedProvider(
        val id: String,
        val name: String,
        val type: String,
        val defaultModel: String,
        val models: List<String>,
        val ownerUserId: String,
        val ownerUsername: String,
    )

    private val _providers = MutableStateFlow<List<SharedProvider>>(emptyList())
    val providers: StateFlow<List<SharedProvider>> = _providers.asStateFlow()

    /** Replaces the whole set — the server list is authoritative, this store is
     * a rendering cache, not a merge participant. */
    fun replace(next: List<SharedProvider>) {
        _providers.value = next
    }

    fun byId(id: String): SharedProvider? = _providers.value.firstOrNull { it.id == id }

    fun clear() {
        _providers.value = emptyList()
    }
}
