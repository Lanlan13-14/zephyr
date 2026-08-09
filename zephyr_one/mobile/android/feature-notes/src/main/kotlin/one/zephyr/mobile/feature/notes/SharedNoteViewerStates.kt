package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.PageState

/**
 * A shared note body, held in memory for the life of one viewer and never written down.
 *
 * Deliberately NOT a [one.zephyr.mobile.model.Note]: that type is what the Room mirror stores, and
 * having a shared body in the same shape is what makes an accidental `dao.upsert(note)` compile.
 * A separate type means there is no DAO, no entity and no serializer that accepts this, so the
 * residency rule from SHARED_RESOURCE_RESIDENCY.md 3 is enforced by the type system rather than by
 * remembering to avoid a call.
 *
 * Not `@Serializable` for the same reason: a serializer is the shortest path to a disk write, a
 * SavedStateHandle round-trip or a log line.
 */
class SharedNoteBody(
    val noteId: String,
    val title: String,
    val content: String,
    val revision: Long,
    /** Whether the owner permits AI to read this note. Not a local preference. */
    val allowAiRead: Boolean,
    val allowAiWrite: Boolean,
) {
    /**
     * Redacted on purpose.
     *
     * The default `toString` of a data class prints every field, and note bodies reach logs through
     * exactly that route -- an exception message, a crash report, a debug print. This one names the
     * note and says nothing about its content.
     */
    override fun toString(): String = "SharedNoteBody(noteId=" + noteId + ", revision=" + revision + ")"
}

/**
 * One edit in progress against a shared note.
 *
 * The baseline revision is captured when the body is read, not when the save is sent: the whole
 * point of `expectedRevision` is to describe the text the user actually edited, so that a change
 * made by the owner in between is a conflict rather than a silent overwrite.
 */
data class SharedNoteEdit(
    val baselineRevision: Long,
    val title: String,
    val content: String,
) {
    fun isDirtyAgainst(body: SharedNoteBody): Boolean =
        title != body.title || content != body.content
}

/** What a save attempt did. */
sealed interface SharedNoteSaveOutcome {
    data class Saved(val revision: Long) : SharedNoteSaveOutcome

    /**
     * The owner changed the note under the editor.
     *
     * Carries the editor text so the screen can offer it back. Discarding it and re-reading would
     * throw away work the user had not saved anywhere else -- and for a shared note there is no
     * local draft to recover it from.
     */
    data class Conflict(val serverRevision: Long, val localTitle: String, val localContent: String) :
        SharedNoteSaveOutcome

    /** The grant does not carry EDIT. Refused before the request, and again by the server. */
    data object NotPermitted : SharedNoteSaveOutcome

    /** The grant vanished mid-edit. The viewer must close and drop the body. */
    data object Revoked : SharedNoteSaveOutcome

    data class Failed(val error: MobileError) : SharedNoteSaveOutcome
}

/**
 * The no-store shared note viewer state.
 *
 * Every branch below is a state the user can actually reach, and the ordering is the specification:
 * a revoked grant outranks a permission problem, which outranks a transport error, because the
 * strongest true statement is the one worth showing.
 */
object SharedNoteViewerStates {

    /** The wire operation names. `read` is always allowed; `update` needs EDIT. */
    const val OPERATION_READ = "read"
    const val OPERATION_UPDATE = "update"

    /** The server's answer when a shared user without EDIT attempts a write. */
    const val CODE_REVISION_REQUIRED = "revision_required"
    const val CODE_REVISION_CONFLICT = "note_revision_conflict"
    const val CODE_UNSUPPORTED_SCOPE = "unsupported_scope"

    fun derive(
        body: SharedNoteBody?,
        capabilities: CapabilitySet,
        loaded: Boolean = true,
        online: Boolean = true,
        error: MobileError? = null,
    ): PageState<SharedNoteBody> {
        /* Offline is terminal and comes first: the body was never written to this device, so there
         * is no cached copy to show and no honest way to render the note at all. */
        if (!online) return PageState.OfflineNoCache

        if (error != null) {
            if (error.dismissesSharedResource) return PageState.NotFoundOrRevoked
            /* A shared note the owner un-shared answers 404 on the next read, which the client
             * cannot distinguish from a deleted note -- and does not need to: both mean the same
             * thing to this device, and both are terminal. */
            if (error.httpStatus == 404) return PageState.NotFoundOrRevoked
            if (error.code == CODE_UNSUPPORTED_SCOPE) {
                return PageState.PermissionDenied(Capability.VIEW, error.message)
            }
            return if (error.retryable || error.isRegistryRetryable) {
                PageState.RetryableError(error)
            } else {
                PageState.FatalIncompatible(error)
            }
        }

        /* VIEW is checked after the error branches so a revoked grant still reports as revoked
         * rather than as a permission problem: the user needs to know the share is gone, not that
         * they lack a capability they used to have. */
        if (!capabilities.canView) {
            return PageState.PermissionDenied(Capability.VIEW, null)
        }

        if (!loaded || body == null) return PageState.InitialLoading

        /* No pendingSync flag. A shared note has no local write queue: an unsaved edit lives in the
         * composable's own state and is lost when the viewer closes, which is the correct behaviour
         * for a body that may not be persisted. */
        return PageState.Content(body)
    }

    /**
     * Whether the editor may be offered at all.
     *
     * Gated on EDIT, which sharing never implies. A viewer that offered editing on a view-only
     * grant would let the user type a change the server then refuses, losing the work.
     */
    fun canEdit(capabilities: CapabilitySet): Boolean = capabilities.canEdit

    /**
     * Classify a save failure.
     *
     * The revision conflict is the case worth getting right: the server answers 409 with
     * `note_revision_conflict`, and the editor text has to survive that answer or the user loses
     * everything they typed.
     */
    fun classifySaveFailure(
        error: MobileError,
        editorTitle: String,
        editorContent: String,
        serverRevision: Long,
    ): SharedNoteSaveOutcome = when {
        error.dismissesSharedResource || error.httpStatus == 404 -> SharedNoteSaveOutcome.Revoked
        error.code == CODE_REVISION_CONFLICT || error.httpStatus == 409 ->
            SharedNoteSaveOutcome.Conflict(serverRevision, editorTitle, editorContent)
        /* `unsupported_scope` is also what the server returns for an unknown operation, but the
         * client only ever sends read and update, so on a save it can only mean the grant does not
         * permit writing. */
        error.code == CODE_UNSUPPORTED_SCOPE -> SharedNoteSaveOutcome.NotPermitted
        error.httpStatus == 403 -> SharedNoteSaveOutcome.NotPermitted
        else -> SharedNoteSaveOutcome.Failed(error)
    }

    /**
     * The expectedRevision to send with an update.
     *
     * Always the revision the body was read at. Sending the freshest known revision instead would
     * defeat the guard entirely: it would make every save succeed, including one that overwrites a
     * change the user never saw.
     */
    fun expectedRevisionFor(edit: SharedNoteEdit): Long = edit.baselineRevision
}
