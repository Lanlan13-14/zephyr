package one.zephyr.mobile.data.session

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.model.ActionGate
import one.zephyr.mobile.model.Residency
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionModelsTest {

    // ---- grouping ------------------------------------------------------------------------------

    @Test
    fun eachTransportMapsToItsGroup() {
        assertEquals(
            SessionGroup.CONNECTING,
            SessionFixtures.row(transport = SessionTransport.CONNECTING).group,
        )
        assertEquals(
            SessionGroup.CONNECTED,
            SessionFixtures.row(transport = SessionTransport.CONNECTED).group,
        )
        assertEquals(
            SessionGroup.RESUMABLE,
            SessionFixtures.row(transport = SessionTransport.DISCONNECTED).group,
        )
        assertEquals(
            SessionGroup.HISTORY,
            SessionFixtures.row(transport = SessionTransport.CLOSED).group,
        )
    }

    @Test
    fun minimisedWinsOverDisconnected() {
        val row = SessionFixtures.row(transport = SessionTransport.DISCONNECTED, minimised = true)
        assertEquals(SessionGroup.MINIMISED, row.group)
    }

    /** A closed session is history even if it was minimised when it died. */
    @Test
    fun historyWinsOverMinimised() {
        val row = SessionFixtures.row(transport = SessionTransport.CLOSED, minimised = true)
        assertEquals(SessionGroup.HISTORY, row.group)
    }

    @Test
    fun everyRowLandsInExactlyOneGroup() {
        val rows = buildList {
            for (transport in SessionTransport.entries) {
                for (minimised in listOf(false, true)) {
                    add(
                        SessionFixtures.row(
                            sessionId = transport.name + "-" + minimised,
                            transport = transport,
                            minimised = minimised,
                        ),
                    )
                }
            }
        }
        val grouped = SessionGrouping.grouped(rows)
        assertEquals(rows.size, grouped.values.sumOf { it.size })
    }

    @Test
    fun groupsAreOrderedAsTheSpecListsThem() {
        val rows = listOf(
            SessionFixtures.row(sessionId = "closed", transport = SessionTransport.CLOSED),
            SessionFixtures.row(sessionId = "min", minimised = true),
            SessionFixtures.row(sessionId = "drop", transport = SessionTransport.DISCONNECTED),
            SessionFixtures.row(sessionId = "up", transport = SessionTransport.CONNECTED),
            SessionFixtures.row(sessionId = "dialling", transport = SessionTransport.CONNECTING),
        )
        assertEquals(
            listOf(
                SessionGroup.CONNECTING,
                SessionGroup.CONNECTED,
                SessionGroup.RESUMABLE,
                SessionGroup.MINIMISED,
                SessionGroup.HISTORY,
            ),
            SessionGrouping.grouped(rows).keys.toList(),
        )
    }

    /** Empty groups are absent rather than present-and-empty, so the screen renders no dead header. */
    @Test
    fun emptyGroupsAreOmitted() {
        val grouped = SessionGrouping.grouped(listOf(SessionFixtures.row()))
        assertEquals(listOf(SessionGroup.CONNECTED), grouped.keys.toList())
    }

    @Test
    fun liveRowsSortOldestFirstAndHistoryNewestFirst() {
        val live = listOf(
            SessionFixtures.row(sessionId = "new", startedAt = 3_000L),
            SessionFixtures.row(sessionId = "old", startedAt = 1_000L),
        )
        assertEquals(
            listOf("old", "new"),
            SessionGrouping.grouped(live).getValue(SessionGroup.CONNECTED).map { it.sessionId },
        )

        val history = listOf(
            SessionFixtures.row(sessionId = "early", transport = SessionTransport.CLOSED, endedAt = 2_000L),
            SessionFixtures.row(sessionId = "late", transport = SessionTransport.CLOSED, endedAt = 9_000L),
        )
        assertEquals(
            listOf("late", "early"),
            SessionGrouping.grouped(history).getValue(SessionGroup.HISTORY).map { it.sessionId },
        )
    }

    @Test
    fun countsOnlyConsiderLiveRows() {
        val rows = listOf(
            SessionFixtures.row(sessionId = "a", transport = SessionTransport.CONNECTED, unreadOutput = true),
            SessionFixtures.row(sessionId = "b", transport = SessionTransport.CONNECTING),
            SessionFixtures.row(sessionId = "c", transport = SessionTransport.DISCONNECTED, unreadOutput = true),
            SessionFixtures.row(sessionId = "d", transport = SessionTransport.CLOSED, unreadOutput = true),
        )
        assertEquals(2, SessionGrouping.liveCount(rows))
        assertEquals(1, SessionGrouping.unreadCount(rows))
    }

    @Test
    fun closableRowsExcludeHistory() {
        val rows = listOf(
            SessionFixtures.row(sessionId = "live"),
            SessionFixtures.row(sessionId = "gone", transport = SessionTransport.CLOSED),
        )
        assertEquals(listOf("live"), SessionGrouping.closableRows(rows).map { it.sessionId })
    }

    // ---- restorability -------------------------------------------------------------------------

    @Test
    fun revokedRowIsNotRestorable() {
        assertFalse(SessionFixtures.row(revoked = true).restorable)
    }

    @Test
    fun closedRowIsNotRestorable() {
        assertFalse(SessionFixtures.row(transport = SessionTransport.CLOSED).restorable)
    }

    @Test
    fun liveAndDroppedRowsAreRestorable() {
        assertTrue(SessionFixtures.row().restorable)
        assertTrue(SessionFixtures.row(transport = SessionTransport.DISCONNECTED).restorable)
    }

    @Test
    fun durationUsesEndedAtOnceClosed() {
        val closed = SessionFixtures.row(
            transport = SessionTransport.CLOSED,
            startedAt = 1_000L,
            endedAt = 5_000L,
        )
        assertEquals(4_000L, closed.durationMs(nowMs = 99_000L))
        assertEquals(8_000L, SessionFixtures.row(startedAt = 1_000L).durationMs(nowMs = 9_000L))
    }

    // ---- gates ---------------------------------------------------------------------------------

    /**
     * The frozen rule from SCREEN_CATALOG.md 7: a revoked tab keeps its explanation. Disabled with a
     * reason, never hidden, because a vanished button teaches the user nothing.
     */
    @Test
    fun revokedRowDisablesRestoreWithItsReason() {
        val row = SessionFixtures.row(revoked = true, revokedReason = "owner removed the grant")
        val gate = SessionActions.gate(row, SessionAction.RESTORE)
        assertTrue(gate is ActionGate.Disabled)
        assertEquals("owner removed the grant", (gate as ActionGate.Disabled).reason)
        assertTrue(gate.isVisible)
        assertFalse(gate.isAllowed)
    }

    @Test
    fun revokedRowWithoutExplicitReasonFallsBackToTheFrozenText() {
        val gate = SessionActions.gate(SessionFixtures.row(revoked = true), SessionAction.RECONNECT)
        assertEquals(SessionActions.REASON_REVOKED, (gate as ActionGate.Disabled).reason)
    }

    /** Restoring is a UI move, so it needs no capability at all - only a row that still exists. */
    @Test
    fun restoreNeedsNoCapability() {
        val row = SessionFixtures.row(capabilities = SessionFixtures.viewOnly)
        assertTrue(SessionActions.gate(row, SessionAction.RESTORE).isAllowed)
    }

    @Test
    fun restoreIsHiddenForHistory() {
        val gate = SessionActions.gate(
            SessionFixtures.row(transport = SessionTransport.CLOSED),
            SessionAction.RESTORE,
        )
        assertEquals(ActionGate.Hidden(Capability.USE), gate)
    }

    /** Reconnect opens a transport, so a lost USE grant disables it with a reason. */
    @Test
    fun reconnectRequiresUse() {
        val row = SessionFixtures.row(
            transport = SessionTransport.DISCONNECTED,
            capabilities = SessionFixtures.viewOnly,
        )
        val gate = SessionActions.gate(row, SessionAction.RECONNECT)
        assertEquals(SessionActions.REASON_USE_REVOKED, (gate as ActionGate.Disabled).reason)
    }

    @Test
    fun reconnectIsHiddenWhileTheTransportIsUp() {
        assertEquals(
            ActionGate.Hidden(Capability.USE),
            SessionActions.gate(SessionFixtures.row(transport = SessionTransport.CONNECTED), SessionAction.RECONNECT),
        )
        assertEquals(
            ActionGate.Hidden(Capability.USE),
            SessionActions.gate(SessionFixtures.row(transport = SessionTransport.CONNECTING), SessionAction.RECONNECT),
        )
    }

    @Test
    fun reconnectIsAllowedForADroppedSession() {
        val row = SessionFixtures.row(transport = SessionTransport.DISCONNECTED)
        assertTrue(SessionActions.gate(row, SessionAction.RECONNECT).isAllowed)
    }

    /** A revoked tab must still be dismissable, otherwise it is stuck in the list forever. */
    @Test
    fun closeStaysAllowedOnARevokedRow() {
        val row = SessionFixtures.row(revoked = true, capabilities = one.zephyr.mobile.model.CapabilitySet.none)
        assertTrue(SessionActions.gate(row, SessionAction.CLOSE).isAllowed)
    }

    @Test
    fun closeIsHiddenForHistory() {
        assertEquals(
            ActionGate.Hidden(Capability.USE),
            SessionActions.gate(SessionFixtures.row(transport = SessionTransport.CLOSED), SessionAction.CLOSE),
        )
    }

    @Test
    fun detailsIsAlwaysAvailable() {
        for (transport in SessionTransport.entries) {
            val row = SessionFixtures.row(transport = transport, revoked = true)
            assertTrue(SessionActions.gate(row, SessionAction.DETAILS).isAllowed)
        }
    }

    @Test
    fun visibleActionsDropOnlyHiddenOnes() {
        val closed = SessionFixtures.row(transport = SessionTransport.CLOSED)
        assertEquals(listOf(SessionAction.DETAILS), SessionActions.visibleActions(closed))

        val revoked = SessionFixtures.row(revoked = true)
        assertEquals(
            listOf(SessionAction.RESTORE, SessionAction.RECONNECT, SessionAction.CLOSE, SessionAction.DETAILS),
            SessionActions.visibleActions(revoked),
        )
    }

    // ---- disclosure ----------------------------------------------------------------------------

    @Test
    fun ownedSessionHasNoDisclosure() {
        assertNull(SessionActions.executionDisclosure(SessionFixtures.row()))
    }

    /**
     * SCREEN_CATALOG.md 2.1 bans a vague "安全连接": the row must say whether the credential stayed
     * on the main end or the material reached this device.
     */
    @Test
    fun sharedSessionDisclosesWhereTheMaterialLives() {
        val relay = SessionFixtures.row(
            residency = Residency.SHARED_ONLINE_ONLY,
            execution = SessionExecution.RELAY,
        )
        assertEquals(SessionActions.DISCLOSURE_RELAY, SessionActions.executionDisclosure(relay))

        val direct = SessionFixtures.row(
            residency = Residency.SHARED_ONLINE_ONLY,
            execution = SessionExecution.LOCAL,
        )
        assertEquals(SessionActions.DISCLOSURE_DIRECT, SessionActions.executionDisclosure(direct))
    }

    @Test
    fun theWireReasonIsFrozen() {
        assertEquals("resource_revoked", SessionActions.WIRE_RESOURCE_REVOKED)
    }
}
