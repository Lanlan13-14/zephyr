package one.zephyr.mobile.feature.connections

import one.zephyr.mobile.model.Protocol
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionFiltersTest {

    @Test
    fun `blank query matches everything`() {
        val c = Fixtures.connection()
        assertTrue(ConnectionFilters.matchesQuery(c, ""))
        assertTrue(ConnectionFilters.matchesQuery(c, "   "))
    }

    @Test
    fun `query matches name host remark and tags case insensitively`() {
        val c = Fixtures.connection(
            name = "Prod-Web",
            host = "10.0.0.1",
            remark = "Frankfurt cage",
            tags = listOf("prod", "EU"),
        )
        assertTrue(ConnectionFilters.matchesQuery(c, "prod-web"))
        assertTrue(ConnectionFilters.matchesQuery(c, "PROD-WEB"))
        assertTrue(ConnectionFilters.matchesQuery(c, "10.0.0"))
        assertTrue(ConnectionFilters.matchesQuery(c, "frankfurt"))
        assertTrue(ConnectionFilters.matchesQuery(c, "eu"))
    }

    @Test
    fun `query matches the rendered host colon port`() {
        val c = Fixtures.connection(host = "10.0.0.1", protocol = Protocol.RDP)
        assertTrue(ConnectionFilters.matchesQuery(c, "10.0.0.1:3389"))
    }

    /** Matching the username would surface accounts while the user is typing a hostname. */
    @Test
    fun `query does not match username`() {
        val c = Fixtures.connection(username = "deployer", name = "web", host = "h", remark = "")
        assertFalse(ConnectionFilters.matchesQuery(c, "deployer"))
    }

    @Test
    fun `protocol facet keeps only the selected protocols`() {
        val ssh = Fixtures.connection(id = "a", protocol = Protocol.SSH)
        val rdp = Fixtures.connection(id = "b", protocol = Protocol.RDP)
        val filter = ConnectionFilter(protocols = setOf(Protocol.RDP))
        assertFalse(ConnectionFilters.matches(ssh, filter, emptySet()))
        assertTrue(ConnectionFilters.matches(rdp, filter, emptySet()))
    }

    @Test
    fun `tag facet is or within the facet`() {
        val a = Fixtures.connection(id = "a", tags = listOf("prod"))
        val b = Fixtures.connection(id = "b", tags = listOf("staging"))
        val c = Fixtures.connection(id = "c", tags = listOf("dev"))
        val filter = ConnectionFilter(tags = setOf("prod", "staging"))
        assertTrue(ConnectionFilters.matches(a, filter, emptySet()))
        assertTrue(ConnectionFilters.matches(b, filter, emptySet()))
        assertFalse(ConnectionFilters.matches(c, filter, emptySet()))
    }

    @Test
    fun `ownership facet splits owned from shared`() {
        val owned = Fixtures.connection(id = "a")
        val shared = Fixtures.shared(id = "b")
        val ownedOnly = ConnectionFilter(ownership = OwnershipFacet.OWNED)
        val sharedOnly = ConnectionFilter(ownership = OwnershipFacet.SHARED)
        assertTrue(ConnectionFilters.matches(owned, ownedOnly, emptySet()))
        assertFalse(ConnectionFilters.matches(shared, ownedOnly, emptySet()))
        assertFalse(ConnectionFilters.matches(owned, sharedOnly, emptySet()))
        assertTrue(ConnectionFilters.matches(shared, sharedOnly, emptySet()))
    }

    @Test
    fun `favourites only uses the id set`() {
        val c = Fixtures.connection(id = "fav")
        val filter = ConnectionFilter(favouritesOnly = true)
        assertFalse(ConnectionFilters.matches(c, filter, emptySet()))
        assertTrue(ConnectionFilters.matches(c, filter, setOf("fav")))
    }

    /** A tombstoned row survives in the mirror until retention prunes it, but must not be listed. */
    @Test
    fun `apply hides deleted rows`() {
        val live = Fixtures.connection(id = "a", name = "live")
        val dead = Fixtures.connection(id = "b", name = "dead", deletedAt = 5)
        val result = ConnectionFilters.apply(listOf(live, dead), ConnectionFilter())
        assertEquals(listOf("a"), result.map { it.id })
    }

    @Test
    fun `apply orders favourites first then name case insensitively`() {
        val list = listOf(
            Fixtures.connection(id = "1", name = "beta"),
            Fixtures.connection(id = "2", name = "Alpha"),
            Fixtures.connection(id = "3", name = "gamma"),
        )
        val result = ConnectionFilters.apply(list, ConnectionFilter(), favouriteIds = setOf("3"))
        assertEquals(listOf("3", "2", "1"), result.map { it.id })
    }

    @Test
    fun `recents excludes never connected and sorts newest first`() {
        val list = listOf(
            Fixtures.connection(id = "old", lastConnectedAt = 100),
            Fixtures.connection(id = "never", lastConnectedAt = null),
            Fixtures.connection(id = "new", lastConnectedAt = 900),
        )
        assertEquals(listOf("new", "old"), ConnectionFilters.recents(list).map { it.id })
    }

    @Test
    fun `recents respects the limit`() {
        val list = (1..20).map { Fixtures.connection(id = "c" + it, lastConnectedAt = it.toLong()) }
        assertEquals(ConnectionFilters.MAX_RECENTS, ConnectionFilters.recents(list).size)
        assertEquals(3, ConnectionFilters.recents(list, limit = 3).size)
    }

    @Test
    fun `available tags are distinct sorted and skip deleted rows`() {
        val list = listOf(
            Fixtures.connection(id = "a", tags = listOf("prod", "eu")),
            Fixtures.connection(id = "b", tags = listOf("Prod", "asia")),
            Fixtures.connection(id = "c", tags = listOf("hidden"), deletedAt = 1),
        )
        assertEquals(listOf("asia", "eu", "prod", "Prod"), ConnectionFilters.availableTags(list))
    }

    @Test
    fun `filter reports active and clearing keeps the query`() {
        assertFalse(ConnectionFilter().isActive)
        val filter = ConnectionFilter(query = "web").withProtocolToggled(Protocol.SSH)
        assertTrue(filter.isActive)
        assertEquals(setOf(Protocol.SSH), filter.protocols)
        val toggledOff = filter.withProtocolToggled(Protocol.SSH)
        assertEquals(emptySet<Protocol>(), toggledOff.protocols)
        val cleared = filter.cleared()
        assertEquals("web", cleared.query)
        assertEquals(emptySet<Protocol>(), cleared.protocols)
    }

    @Test
    fun `tag toggle adds then removes`() {
        val once = ConnectionFilter().withTagToggled("prod")
        assertEquals(setOf("prod"), once.tags)
        assertEquals(emptySet<String>(), once.withTagToggled("prod").tags)
    }
}
