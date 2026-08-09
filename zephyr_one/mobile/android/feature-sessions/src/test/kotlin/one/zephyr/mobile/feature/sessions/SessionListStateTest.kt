package one.zephyr.mobile.feature.sessions

import one.zephyr.mobile.data.session.SessionGroup
import one.zephyr.mobile.data.session.SessionTransport
import one.zephyr.mobile.model.EmptyReason
import one.zephyr.mobile.model.PageState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S20's page state.
 *
 * The point of these assertions is that the screen never recomputes what the registry already
 * decided: the grouped map, the three counts and the online flag all arrive as data, so a wrong
 * badge or a lying confirmation count is a failure here rather than a visual bug on a device.
 */
class SessionListStateTest {

    @Test
    fun loadingUntilThePersistedWorkspaceHasBeenRead() {
        val state = SessionListStates.derive(rows = emptyList(), restoreComplete = false, online = true)

        // Not Empty: an empty registry during restore would render 无会话 for a frame and then flash
        // the restored tabs in, which reads as a bug rather than as a load.
        assertEquals(PageState.InitialLoading, state)
    }

    @Test
    fun anEmptyRegistryAfterRestoreIsEmptyWithNoData() {
        val state = SessionListStates.derive(rows = emptyList(), restoreComplete = true, online = true)

        assertEquals(PageState.Empty(EmptyReason.NO_DATA), state)
    }

    @Test
    fun theGroupedMapComesFromTheRegistryNotFromTheScreen() {
        val rows = listOf(
            SessionFixtures.row(sessionId = "a", transport = SessionTransport.CONNECTED, startedAt = 30L),
            SessionFixtures.row(sessionId = "b", transport = SessionTransport.CONNECTING, startedAt = 20L),
            SessionFixtures.row(sessionId = "c", transport = SessionTransport.DISCONNECTED, startedAt = 10L),
            SessionFixtures.row(sessionId = "d", transport = SessionTransport.CONNECTED, minimised = true),
            SessionFixtures.row(sessionId = "e", transport = SessionTransport.CLOSED, endedAt = 99L),
        )

        val content = contentOf(SessionListStates.derive(rows, restoreComplete = true, online = true))

        // Declaration order of SessionGroup, not insertion order of the rows.
        assertEquals(
            listOf(
                SessionGroup.CONNECTING,
                SessionGroup.CONNECTED,
                SessionGroup.RESUMABLE,
                SessionGroup.MINIMISED,
                SessionGroup.HISTORY,
            ),
            content.groups.keys.toList(),
        )
        assertEquals(5, content.total)
        assertEquals(listOf("b"), content.groups.getValue(SessionGroup.CONNECTING).map { it.sessionId })
        assertEquals(listOf("d"), content.groups.getValue(SessionGroup.MINIMISED).map { it.sessionId })
    }

    @Test
    fun liveCountExcludesHistoryAndDisconnectedRows() {
        val rows = listOf(
            SessionFixtures.row(sessionId = "a", transport = SessionTransport.CONNECTED),
            SessionFixtures.row(sessionId = "b", transport = SessionTransport.CONNECTING),
            SessionFixtures.row(sessionId = "c", transport = SessionTransport.DISCONNECTED),
            SessionFixtures.row(sessionId = "d", transport = SessionTransport.CLOSED),
        )

        val content = contentOf(SessionListStates.derive(rows, restoreComplete = true, online = true))

        // The island badge reads this number: counting a closed tab would advertise sessions that
        // cannot be resumed.
        assertEquals(2, content.liveCount)
    }

    @Test
    fun closableCountExcludesRowsThatAreAlreadyClosed() {
        val rows = listOf(
            SessionFixtures.row(sessionId = "a", transport = SessionTransport.CONNECTED),
            SessionFixtures.row(sessionId = "b", transport = SessionTransport.DISCONNECTED),
            SessionFixtures.row(sessionId = "c", transport = SessionTransport.CLOSED),
        )

        val content = contentOf(SessionListStates.derive(rows, restoreComplete = true, online = true))

        // The bulk-close confirmation states this number, so it must be what a close would affect.
        assertEquals(2, content.closableCount)
    }

    @Test
    fun aRevokedRowIsStillClosableSoTheTabCanBeDismissed() {
        val rows = listOf(
            SessionFixtures.row(
                sessionId = "a",
                transport = SessionTransport.DISCONNECTED,
                revoked = true,
                capabilities = SessionFixtures.viewOnly,
            ),
        )

        val content = contentOf(SessionListStates.derive(rows, restoreComplete = true, online = true))

        assertEquals(1, content.closableCount)
    }

    @Test
    fun unreadCountIgnoresClosedRows() {
        val rows = listOf(
            SessionFixtures.row(sessionId = "a", transport = SessionTransport.CONNECTED, unreadOutput = true),
            SessionFixtures.row(sessionId = "b", transport = SessionTransport.CLOSED, unreadOutput = true),
        )

        val content = contentOf(SessionListStates.derive(rows, restoreComplete = true, online = true))

        assertEquals(1, content.unreadCount)
    }

    @Test
    fun offlineTravelsWithTheContentSoReconnectCanBeDisabledWithAReason() {
        val rows = listOf(SessionFixtures.row(transport = SessionTransport.DISCONNECTED))

        val online = contentOf(SessionListStates.derive(rows, restoreComplete = true, online = true))
        val offline = contentOf(SessionListStates.derive(rows, restoreComplete = true, online = false))

        assertTrue(online.online)
        assertFalse(offline.online)
    }

    @Test
    fun everyGroupHasALabel() {
        // A group that shipped without a header would render as an unlabelled block of rows.
        for (group in SessionGroup.entries) {
            assertTrue(group.name, SessionListStates.labelFor(group).isNotEmpty())
        }
        assertEquals("断线可恢复", SessionListStates.labelFor(SessionGroup.RESUMABLE))
        assertEquals("历史任务", SessionListStates.labelFor(SessionGroup.HISTORY))
    }

    private fun contentOf(state: PageState<SessionListContent>): SessionListContent {
        assertTrue("expected Content but was " + state, state is PageState.Content)
        return (state as PageState.Content).value
    }
}
