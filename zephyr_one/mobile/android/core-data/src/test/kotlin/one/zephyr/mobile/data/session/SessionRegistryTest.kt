package one.zephyr.mobile.data.session

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.Residency
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionRegistryTest {

    private fun registry(vararg rows: SessionRow): SessionRegistry =
        SessionRegistry().apply { rows.forEach(::register) }

    // ---- registration --------------------------------------------------------------------------

    @Test
    fun registerAddsARow() {
        val registry = registry(SessionFixtures.row())
        assertEquals(1, registry.rows.value.size)
        assertEquals("s-1", registry.rows.value.first().sessionId)
    }

    /**
     * A reconnect must keep the same row.
     *
     * The terminal tab holds the sessionId, so appending a second row with the same id would leave
     * the open surface pointing at a row nothing updates.
     */
    @Test
    fun registerReplacesBySessionId() {
        val registry = registry(SessionFixtures.row(transport = SessionTransport.DISCONNECTED))
        registry.register(SessionFixtures.row(transport = SessionTransport.CONNECTED))

        assertEquals(1, registry.rows.value.size)
        assertEquals(SessionTransport.CONNECTED, registry.rows.value.first().transport)
    }

    @Test
    fun registerPreservesOrderWhenReplacing() {
        val registry = registry(
            SessionFixtures.row(sessionId = "a"),
            SessionFixtures.row(sessionId = "b"),
            SessionFixtures.row(sessionId = "c"),
        )
        registry.register(SessionFixtures.row(sessionId = "b", latencyMs = 99L))

        assertEquals(listOf("a", "b", "c"), registry.rows.value.map { it.sessionId })
        assertEquals(99L, registry.find("b")?.latencyMs)
    }

    // ---- transport -----------------------------------------------------------------------------

    /** A dead transport has no latency, so a stale number must not survive next to the row. */
    @Test
    fun latencyIsDroppedWhenTheTransportStopsBeingLive() {
        val registry = registry(SessionFixtures.row(latencyMs = 42L))
        registry.setTransport("s-1", SessionTransport.DISCONNECTED, nowMs = 5_000L)

        assertNull(registry.find("s-1")?.latencyMs)
    }

    @Test
    fun closingStampsEndedAt() {
        val registry = registry(SessionFixtures.row())
        registry.setTransport("s-1", SessionTransport.CLOSED, nowMs = 7_000L)

        assertEquals(7_000L, registry.find("s-1")?.endedAt)
    }

    @Test
    fun connectingKeepsLatencySlotLive() {
        val registry = registry(SessionFixtures.row(transport = SessionTransport.CONNECTING, latencyMs = 11L))
        registry.setTransport("s-1", SessionTransport.CONNECTED, nowMs = 1L)

        assertEquals(11L, registry.find("s-1")?.latencyMs)
    }

    /** Once a restored tab actually connects it is a real session, not a workspace placeholder. */
    @Test
    fun connectingClearsTheWorkspaceFlag() {
        val registry = SessionRegistry()
        registry.restore(
            listOf(snapshot()),
            capabilitiesFor = { SessionFixtures.useOnly },
        )
        assertTrue(registry.find("s-1")!!.restoredFromWorkspace)

        registry.setTransport("s-1", SessionTransport.CONNECTED, nowMs = 1L)
        assertFalse(registry.find("s-1")!!.restoredFromWorkspace)
    }

    // ---- badges --------------------------------------------------------------------------------

    @Test
    fun backgroundOutputSetsTheBadgeAndForegroundOutputDoesNot() {
        val registry = registry(SessionFixtures.row(sessionId = "bg"), SessionFixtures.row(sessionId = "fg"))
        registry.markOutput("bg", foreground = false)
        registry.markOutput("fg", foreground = true)

        assertTrue(registry.find("bg")!!.unreadOutput)
        assertFalse(registry.find("fg")!!.unreadOutput)
    }

    @Test
    fun markReadClearsBadgeAndUnminimises() {
        val registry = registry(SessionFixtures.row(minimised = true, unreadOutput = true))
        registry.markRead("s-1")

        val row = registry.find("s-1")!!
        assertFalse(row.unreadOutput)
        assertFalse(row.minimised)
    }

    @Test
    fun setMinimisedMovesTheRowWithoutTouchingTheTransport() {
        val registry = registry(SessionFixtures.row())
        registry.setMinimised("s-1", true)

        val row = registry.find("s-1")!!
        assertEquals(SessionGroup.MINIMISED, row.group)
        assertEquals(SessionTransport.CONNECTED, row.transport)
    }

    // ---- revocation ----------------------------------------------------------------------------

    /**
     * The capability set is emptied alongside the flag so any gate consulted later agrees with it.
     * Leaving USE in place would render a reconnect button the server would refuse.
     */
    @Test
    fun revocationStripsCapabilitiesAndKeepsTheRow() {
        val registry = registry(SessionFixtures.row())
        registry.markRevoked("s-1")

        val row = registry.find("s-1")!!
        assertTrue(row.revoked)
        assertEquals(CapabilitySet.none, row.capabilities)
        assertEquals(SessionActions.REASON_REVOKED, row.revokedReason)
        assertEquals(SessionActions.REASON_REVOKED, row.detail)
        assertFalse(row.restorable)
        assertEquals(1, registry.rows.value.size)
    }

    @Test
    fun revocationAcceptsAnExplicitReason() {
        val registry = registry(SessionFixtures.row())
        registry.markRevoked("s-1", reason = "owner deleted the connection")

        assertEquals("owner deleted the connection", registry.find("s-1")?.revokedReason)
    }

    // ---- closing -------------------------------------------------------------------------------

    /** History is kept so the user can still read why a session ended. */
    @Test
    fun closeMovesTheRowToHistoryRatherThanDeletingIt()  {
        val registry = registry(SessionFixtures.row(unreadOutput = true, minimised = true))
        registry.close("s-1", nowMs = 3_000L, detail = "peer closed the channel")

        val row = registry.find("s-1")!!
        assertEquals(SessionGroup.HISTORY, row.group)
        assertEquals(3_000L, row.endedAt)
        assertEquals("peer closed the channel", row.detail)
        assertFalse(row.unreadOutput)
        assertFalse(row.minimised)
        assertNull(row.latencyMs)
    }

    @Test
    fun closeAllReportsWhatItActuallyClosed() {
        val registry = registry(
            SessionFixtures.row(sessionId = "live-1"),
            SessionFixtures.row(sessionId = "live-2", transport = SessionTransport.DISCONNECTED),
            SessionFixtures.row(sessionId = "already", transport = SessionTransport.CLOSED),
        )
        val closed = registry.closeAll(nowMs = 8_000L)

        assertEquals(listOf("live-1", "live-2"), closed)
        assertEquals(3, registry.rows.value.size)
        assertEquals(0, SessionGrouping.liveCount(registry.rows.value))
    }

    @Test
    fun closeAllCanTargetASubset() {
        val registry = registry(
            SessionFixtures.row(sessionId = "a"),
            SessionFixtures.row(sessionId = "b"),
        )
        val closed = registry.closeAll(nowMs = 1L, sessionIds = listOf("b"))

        assertEquals(listOf("b"), closed)
        assertEquals(SessionTransport.CONNECTED, registry.find("a")?.transport)
    }

    @Test
    fun clearHistoryNeverDropsALiveSession() {
        val registry = registry(
            SessionFixtures.row(sessionId = "live"),
            SessionFixtures.row(sessionId = "gone", transport = SessionTransport.CLOSED),
        )
        registry.clearHistory()

        assertEquals(listOf("live"), registry.rows.value.map { it.sessionId })
    }

    @Test
    fun removeAndClearDropRows() {
        val registry = registry(SessionFixtures.row(sessionId = "a"), SessionFixtures.row(sessionId = "b"))
        registry.remove("a")
        assertEquals(listOf("b"), registry.rows.value.map { it.sessionId })

        registry.clear()
        assertEquals(0, registry.rows.value.size)
    }

    // ---- workspace -----------------------------------------------------------------------------

    @Test
    fun snapshotSkipsHistoryAndRevokedRows() {
        val registry = registry(
            SessionFixtures.row(sessionId = "live"),
            SessionFixtures.row(sessionId = "dropped", transport = SessionTransport.DISCONNECTED),
            SessionFixtures.row(sessionId = "closed", transport = SessionTransport.CLOSED),
            SessionFixtures.row(sessionId = "revoked", revoked = true),
        )
        assertEquals(listOf("live", "dropped"), registry.snapshot().map { it.sessionId })
    }

    /**
     * The frozen rule from SCREEN_CATALOG.md 7: a workspace restore neither connects nor replays.
     *
     * Asserted as a property of every restored row rather than of one example, because a single
     * CONNECTED row here would mean the app dials a host on launch.
     */
    @Test
    fun restoreNeverProducesAConnectedRow() {
        val registry = SessionRegistry()
        registry.restore(
            listOf(
                snapshot(sessionId = "a", connectionId = "c-1"),
                snapshot(sessionId = "b", connectionId = "c-2"),
            ),
            capabilitiesFor = { SessionFixtures.useOnly },
        )

        assertEquals(2, registry.rows.value.size)
        for (row in registry.rows.value) {
            assertEquals(SessionTransport.DISCONNECTED, row.transport)
            assertTrue(row.restoredFromWorkspace)
            assertEquals(SessionGroup.RESUMABLE, row.group)
            // Reconnect must be an explicit user action, so it is offered rather than performed.
            assertTrue(SessionActions.gate(row, SessionAction.RECONNECT).isAllowed)
        }
    }

    /**
     * Capabilities are resolved at restore time, never persisted.
     *
     * A grant revoked while the app was dead must come back as a revoked tab, not as a reconnect
     * button the server would refuse.
     */
    @Test
    fun restoreWithNoCapabilitiesProducesARevokedTab() {
        val registry = SessionRegistry()
        registry.restore(listOf(snapshot()), capabilitiesFor = { null })

        val row = registry.find("s-1")!!
        assertTrue(row.revoked)
        assertEquals(CapabilitySet.none, row.capabilities)
        assertEquals(SessionActions.REASON_REVOKED, row.revokedReason)
        assertFalse(row.restorable)
        assertFalse(SessionActions.gate(row, SessionAction.RECONNECT).isAllowed)
    }

    @Test
    fun restoreCarriesResidencyForwards() {
        val registry = SessionRegistry()
        registry.restore(
            listOf(snapshot()),
            capabilitiesFor = { SessionFixtures.useOnly },
            residencyFor = { Residency.SHARED_ONLINE_ONLY },
        )

        assertEquals(Residency.SHARED_ONLINE_ONLY, registry.find("s-1")?.residency)
    }

    @Test
    fun snapshotRoundTripsThroughRestore() {
        val source = registry(SessionFixtures.row(sessionId = "keep", startedAt = 4_000L))
        val target = SessionRegistry()
        target.restore(source.snapshot(), capabilitiesFor = { SessionFixtures.useOnly })

        val row = target.find("keep")!!
        assertEquals("prod-web", row.name)
        assertEquals("10.0.0.5", row.host)
        assertEquals(Protocol.SSH.defaultPort, row.port)
        assertEquals(4_000L, row.startedAt)
    }

    // ---- flows ---------------------------------------------------------------------------------

    @Test
    fun liveCountIgnoresHistory() = runTest {
        val registry = registry(
            SessionFixtures.row(sessionId = "a"),
            SessionFixtures.row(sessionId = "b", transport = SessionTransport.CONNECTING),
            SessionFixtures.row(sessionId = "c", transport = SessionTransport.CLOSED),
        )
        assertEquals(2, registry.liveCount.first())
    }

    @Test
    fun observeEmitsNullOnceTheRowIsGone() = runTest {
        val registry = registry(SessionFixtures.row())
        assertEquals("s-1", registry.observe("s-1").first()?.sessionId)

        registry.remove("s-1")
        assertNull(registry.observe("s-1").first())
    }

    @Test
    fun groupedFlowMatchesTheGroupingHelper() = runTest {
        val registry = registry(
            SessionFixtures.row(sessionId = "a"),
            SessionFixtures.row(sessionId = "b", transport = SessionTransport.CLOSED),
        )
        assertEquals(
            SessionGrouping.grouped(registry.rows.value),
            registry.grouped.first(),
        )
    }

    private fun snapshot(
        sessionId: String = "s-1",
        connectionId: String = "c-1",
    ): SessionSnapshot = SessionSnapshot(
        sessionId = sessionId,
        connectionId = connectionId,
        protocol = Protocol.SSH,
        name = "prod-web",
        host = "10.0.0.5",
        port = 22,
        startedAt = 1_000L,
        endedAt = null,
    )
}
