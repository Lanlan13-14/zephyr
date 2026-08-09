package one.zephyr.mobile.feature.connections

import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Residency

/**
 * Ownership facet for the S10 list.
 *
 * SCREEN_CATALOG.md 5 lists ownership as a first-class filter, and SHARED_RESOURCE_RESIDENCY.md
 * makes the two sides behave differently offline, so the distinction has to survive into the state
 * rather than being a cosmetic badge.
 */
enum class OwnershipFacet { ALL, OWNED, SHARED }

/**
 * The S10 filter set.
 *
 * Kept as a value type with no Android or coroutine dependency so the whole filter matrix is unit
 * testable: the list screen's correctness is mostly this function, not the composable.
 */
data class ConnectionFilter(
    val query: String = "",
    val protocols: Set<Protocol> = emptySet(),
    val tags: Set<String> = emptySet(),
    val ownership: OwnershipFacet = OwnershipFacet.ALL,
    val favouritesOnly: Boolean = false,
) {
    val isActive: Boolean
        get() = query.isNotBlank() ||
            protocols.isNotEmpty() ||
            tags.isNotEmpty() ||
            ownership != OwnershipFacet.ALL ||
            favouritesOnly

    fun withProtocolToggled(protocol: Protocol): ConnectionFilter =
        copy(protocols = if (protocol in protocols) protocols - protocol else protocols + protocol)

    fun withTagToggled(tag: String): ConnectionFilter =
        copy(tags = if (tag in tags) tags - tag else tags + tag)

    fun cleared(): ConnectionFilter = ConnectionFilter(query = query)
}

/**
 * Pure filtering and ordering for the connection library.
 *
 * Deliberately not a database query: the list combines the owned mirror with shared-to-me rows that
 * exist only in memory (SHARED_RESOURCE_RESIDENCY.md 2), and a SQL WHERE clause could not see the
 * latter. Doing it in Kotlin keeps one ordering rule for both origins.
 */
object ConnectionFilters {

    /**
     * Multi-field match.
     *
     * Remark and tags are included because ZEPHYR_PARITY.md treats them as user-visible identity,
     * but the username is not: matching it would surface accounts while the user types a hostname.
     */
    fun matchesQuery(connection: Connection, rawQuery: String): Boolean {
        val query = rawQuery.trim()
        if (query.isEmpty()) return true
        val needle = query.lowercase()
        if (connection.name.lowercase().contains(needle)) return true
        if (connection.host.lowercase().contains(needle)) return true
        if (connection.remark.lowercase().contains(needle)) return true
        if (connection.tags.any { it.lowercase().contains(needle) }) return true
        // "host:port" is how the card renders the endpoint, so it must also be searchable.
        return connection.displayAddress.lowercase().contains(needle)
    }

    fun matches(connection: Connection, filter: ConnectionFilter, favouriteIds: Set<String>): Boolean {
        if (filter.protocols.isNotEmpty() && connection.protocol !in filter.protocols) return false
        // Tag facets are OR within the facet: selecting two tags widens the result, matching how
        // the chips read to the user.
        if (filter.tags.isNotEmpty() && filter.tags.none { it in connection.tags }) return false
        val ownershipOk = when (filter.ownership) {
            OwnershipFacet.ALL -> true
            OwnershipFacet.OWNED -> connection.residency == Residency.OWNED
            OwnershipFacet.SHARED -> connection.residency == Residency.SHARED_ONLINE_ONLY
        }
        if (!ownershipOk) return false
        if (filter.favouritesOnly && connection.id !in favouriteIds) return false
        return matchesQuery(connection, filter.query)
    }

    /**
     * Deleted rows are dropped here rather than at the query.
     *
     * A tombstoned row still exists in the mirror until retention prunes it, and it may still be
     * the subject of a pending restore, so the repository keeps it while the list hides it.
     */
    fun apply(
        connections: List<Connection>,
        filter: ConnectionFilter,
        favouriteIds: Set<String> = emptySet(),
    ): List<Connection> = connections
        .asSequence()
        .filter { !it.isDeleted }
        .filter { matches(it, filter, favouriteIds) }
        .sortedWith(ordering(favouriteIds))
        .toList()

    /**
     * Ordering: favourites, then name.
     *
     * Name uses a case-insensitive comparison so an upper-case entry does not sort into a separate
     * block from its lower-case neighbours.
     */
    fun ordering(favouriteIds: Set<String>): Comparator<Connection> =
        compareByDescending<Connection> { it.id in favouriteIds }
            .thenBy(String.CASE_INSENSITIVE_ORDER) { it.name }
            .thenBy { it.id }

    /**
     * Recents strip.
     *
     * Never-connected rows are excluded rather than sorted last: "recent" with an entry that was
     * never used would be a lie, and the empty strip is a legitimate state.
     */
    fun recents(connections: List<Connection>, limit: Int = MAX_RECENTS): List<Connection> =
        connections
            .asSequence()
            .filter { !it.isDeleted }
            .filter { it.lastConnectedAt != null }
            .sortedByDescending { it.lastConnectedAt }
            .take(limit)
            .toList()

    /** Tag facet values, sorted, from whatever is actually present. */
    fun availableTags(connections: List<Connection>): List<String> =
        connections
            .asSequence()
            .filter { !it.isDeleted }
            .flatMap { it.tags.asSequence() }
            .distinct()
            .sortedWith(String.CASE_INSENSITIVE_ORDER)
            .toList()

    const val MAX_RECENTS = 8
}
