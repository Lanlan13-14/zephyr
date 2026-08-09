package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.PageState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The no-store shared note viewer.
 *
 * The rules pinned here all fail silently rather than loudly: a body that leaks into a log, an
 * editor offered on a read-only grant, a save that overwrites a change the user never saw. None of
 * them throw, so nothing but a test catches them.
 */
class SharedNoteViewerStatesTest {

    private fun body(
        revision: Long = 4,
        title: String = "Runbook",
        content: String = "step one",
    ): SharedNoteBody = SharedNoteBody(
        noteId = "n-1",
        title = title,
        content = content,
        revision = revision,
        allowAiRead = false,
        allowAiWrite = false,
    )

    private fun error(
        code: String,
        retryable: Boolean = false,
        status: Int? = null,
    ): MobileError = MobileError(
        code = code,
        message = "m",
        retryable = retryable,
        requestId = "req-1",
        httpStatus = status,
    )

    /**
     * The body must not survive a log line.
     *
     * A data class would print every field, and note bodies reach logs through exactly that route:
     * an exception message, a crash report, a stray debug print. This is why SharedNoteBody is a
     * plain class with an explicit toString.
     */
    @Test
    fun `the body never prints its own content`() {
        val text = body(title = "SECRET-TITLE", content = "SECRET-CONTENT").toString()
        assertFalse("content must not appear in toString", text.contains("SECRET-CONTENT"))
        assertFalse("title must not appear in toString", text.contains("SECRET-TITLE"))
        assertTrue("the note must still be identifiable", text.contains("n-1"))
        assertTrue(text.contains("revision=4"))
    }

    /** No mirror exists, so there is no honest way to render the note offline. */
    @Test
    fun `offline is terminal`() {
        val state = SharedNoteViewerStates.derive(body(), CapabilitySet.implicitShare, online = false)
        assertEquals(PageState.OfflineNoCache, state)
    }

    @Test
    fun `a revoked grant is terminal`() {
        for (code in listOf("shared_grant_revoked", "shared_grant_expired")) {
            val state = SharedNoteViewerStates.derive(
                body = null,
                capabilities = CapabilitySet.implicitShare,
                error = error(code),
            )
            assertEquals(code, PageState.NotFoundOrRevoked, state)
        }
    }

    /**
     * An un-shared note answers 404, indistinguishable from a deleted one -- and the client does not
     * need to tell them apart, because both are terminal for this device.
     */
    @Test
    fun `a 404 reads as revoked rather than as a retryable failure`() {
        val state = SharedNoteViewerStates.derive(
            body = null,
            capabilities = CapabilitySet.implicitShare,
            error = error("not_found", status = 404),
        )
        assertEquals(PageState.NotFoundOrRevoked, state)
    }

    /**
     * A revoked grant must report as revoked, not as a missing capability: the user needs to know
     * the share is gone, not that they lack something they used to have.
     */
    @Test
    fun `revocation outranks a permission problem`() {
        val state = SharedNoteViewerStates.derive(
            body = null,
            capabilities = CapabilitySet.none,
            error = error("shared_grant_revoked"),
        )
        assertEquals(PageState.NotFoundOrRevoked, state)
    }

    @Test
    fun `no view capability is a permission denial`() {
        val state = SharedNoteViewerStates.derive(body(), CapabilitySet.none)
        val denied = state as PageState.PermissionDenied
        assertEquals(Capability.VIEW, denied.missing)
    }

    @Test
    fun `a missing body is loading rather than empty`() {
        val state = SharedNoteViewerStates.derive(null, CapabilitySet.implicitShare)
        assertEquals(PageState.InitialLoading, state)
    }

    /** An unsaved edit lives in the composable only; there is no local draft to be pending. */
    @Test
    fun `content never claims a pending local write`() {
        val content = SharedNoteViewerStates.derive(body(), CapabilitySet.implicitShare) as PageState.Content
        assertFalse(content.pendingSync)
        assertFalse(content.savingLocal)
        assertFalse(content.conflict)
    }

    @Test
    fun `editing requires an explicit edit grant`() {
        assertFalse(SharedNoteViewerStates.canEdit(CapabilitySet.implicitShare))
        assertTrue(SharedNoteViewerStates.canEdit(CapabilitySet(setOf(Capability.EDIT))))
    }

    /**
     * The conflict case has to carry the editor text back.
     *
     * For a shared note there is no local draft, so discarding the text on a 409 loses work the
     * user cannot recover from anywhere.
     */
    @Test
    fun `a revision conflict preserves the editor text`() {
        val outcome = SharedNoteViewerStates.classifySaveFailure(
            error = error(SharedNoteViewerStates.CODE_REVISION_CONFLICT, status = 409),
            editorTitle = "my title",
            editorContent = "my content",
            serverRevision = 9,
        )
        val conflict = outcome as SharedNoteSaveOutcome.Conflict
        assertEquals(9, conflict.serverRevision)
        assertEquals("my title", conflict.localTitle)
        assertEquals("my content", conflict.localContent)
    }

    @Test
    fun `a bare 409 is still a conflict`() {
        val outcome = SharedNoteViewerStates.classifySaveFailure(
            error = error("other", status = 409),
            editorTitle = "t",
            editorContent = "c",
            serverRevision = 2,
        )
        assertTrue(outcome is SharedNoteSaveOutcome.Conflict)
    }

    @Test
    fun `unsupported scope and 403 both mean the grant does not permit writing`() {
        val scope = SharedNoteViewerStates.classifySaveFailure(
            error = error(SharedNoteViewerStates.CODE_UNSUPPORTED_SCOPE),
            editorTitle = "t",
            editorContent = "c",
            serverRevision = 1,
        )
        assertEquals(SharedNoteSaveOutcome.NotPermitted, scope)

        val forbidden = SharedNoteViewerStates.classifySaveFailure(
            error = error("forbidden", status = 403),
            editorTitle = "t",
            editorContent = "c",
            serverRevision = 1,
        )
        assertEquals(SharedNoteSaveOutcome.NotPermitted, forbidden)
    }

    @Test
    fun `a grant that vanished mid-edit closes the viewer`() {
        val outcome = SharedNoteViewerStates.classifySaveFailure(
            error = error("shared_grant_revoked"),
            editorTitle = "t",
            editorContent = "c",
            serverRevision = 1,
        )
        assertEquals(SharedNoteSaveOutcome.Revoked, outcome)
    }

    /**
     * expectedRevision must be the revision the text was READ at.
     *
     * Sending the freshest known revision would make every save succeed, including one that
     * silently overwrites an owner edit the user never saw -- which is the entire failure the
     * revision guard exists to prevent.
     */
    @Test
    fun `expectedRevision is the baseline the edit started from`() {
        val edit = SharedNoteEdit(baselineRevision = 4, title = "t", content = "c")
        assertEquals(4, SharedNoteViewerStates.expectedRevisionFor(edit))
    }

    @Test
    fun `dirty tracking compares against the loaded body`() {
        val loaded = body(title = "T", content = "C")
        assertFalse(SharedNoteEdit(loaded.revision, "T", "C").isDirtyAgainst(loaded))
        assertTrue(SharedNoteEdit(loaded.revision, "T2", "C").isDirtyAgainst(loaded))
        assertTrue(SharedNoteEdit(loaded.revision, "T", "C2").isDirtyAgainst(loaded))
    }
}
