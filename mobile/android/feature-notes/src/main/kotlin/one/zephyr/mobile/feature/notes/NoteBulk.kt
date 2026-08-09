package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.contracts.Capability
import one.zephyr.mobile.model.Note
import one.zephyr.mobile.model.Residency

/** The bulk operations S32 offers over a multi-selection. */
enum class NoteBulkAction {
    TRASH,
    RESTORE,
    MOVE_GROUP,
    ADD_TAG,
    REMOVE_TAG,
    EXPORT,
}

/** Why a selected note was left out of a bulk run. */
enum class BulkSkipReason {
    /** Shared-to-me: a bulk local write would create owned material from someone else's note. */
    SHARED_ONLINE_ONLY,

    /** The row does not carry the capability this action needs. */
    NO_CAPABILITY,

    /** Already in the state the action would produce, so running it would queue a no-op. */
    ALREADY_IN_STATE,
}

data class BulkSkip(val noteId: String, val reason: BulkSkipReason)

/**
 * What a bulk run will actually do.
 *
 * Separating the plan from the execution is what makes the frozen 200 limit and the per-row
 * capability gate testable, and it lets the confirmation dialog state real numbers instead of
 * "确定要批量操作吗".
 */
data class BulkPlan(
    val action: NoteBulkAction,
    val accepted: List<Note>,
    val skipped: List<BulkSkip>,
) {
    val acceptedCount: Int get() = accepted.size
    val skippedCount: Int get() = skipped.size
    val isEmpty: Boolean get() = accepted.isEmpty()
}

/** Outcome of a select-all that ran into the frozen cap. */
data class BulkSelection(val ids: Set<String>, val omittedCount: Int) {
    val isCapped: Boolean get() = omittedCount > 0
}

/**
 * Multi-selection rules for S32.
 *
 * SCREEN_CATALOG.md 13 freezes bulk at 200. The cap is enforced when *building* the selection rather
 * than when submitting it, so the user is told immediately instead of after choosing an action, and
 * a 500-note library cannot produce a 500-row operation batch (SyncContract.MAX_OPS_PER_BATCH is
 * also 200, so exceeding it would split into a batch the server never sees as one unit).
 */
object NoteBulk {

    const val MAX_SELECTION = Note.MAX_BULK

    fun capacityRemaining(selected: Set<String>): Int = (MAX_SELECTION - selected.size).coerceAtLeast(0)

    /** Deselect always succeeds; select is refused at the cap rather than silently dropped. */
    fun toggled(selected: Set<String>, noteId: String): Set<String> = when {
        noteId in selected -> selected - noteId
        selected.size >= MAX_SELECTION -> selected
        else -> selected + noteId
    }

    fun canSelectMore(selected: Set<String>): Boolean = selected.size < MAX_SELECTION

    /** Selects as much of [visible] as the cap allows, reporting what was left out. */
    fun selectAll(visible: List<Note>): BulkSelection {
        val ids = visible.take(MAX_SELECTION).map { it.noteId }.toSet()
        return BulkSelection(ids = ids, omittedCount = (visible.size - ids.size).coerceAtLeast(0))
    }

    fun clear(): BulkSelection = BulkSelection(emptySet(), 0)

    /**
     * Which capability each bulk action needs.
     *
     * Export is a read: it needs VIEW only, because writing a copy the user asked for is a local
     * action on data they can already see.
     */
    fun required(action: NoteBulkAction): Capability = when (action) {
        NoteBulkAction.TRASH -> Capability.DELETE
        NoteBulkAction.RESTORE, NoteBulkAction.MOVE_GROUP, NoteBulkAction.ADD_TAG, NoteBulkAction.REMOVE_TAG ->
            Capability.EDIT
        NoteBulkAction.EXPORT -> Capability.VIEW
    }

    /**
     * Builds the plan.
     *
     * Rows that cannot take part are reported rather than dropped: the dialog says "3 条将跳过", which
     * is the difference between a user understanding the outcome and a user believing 200 notes moved.
     *
     * @param tagValue only used by the tag actions, so an add of a tag a note already carries is
     *   recognised as a no-op instead of queueing an operation with an unchanged field.
     */
    fun plan(
        action: NoteBulkAction,
        selected: Set<String>,
        notes: List<Note>,
        tagValue: String = "",
        targetGroupPath: String? = null,
    ): BulkPlan {
        val accepted = ArrayList<Note>()
        val skipped = ArrayList<BulkSkip>()
        val byId = notes.associateBy { it.noteId }

        for (id in selected) {
            val note = byId[id] ?: continue
            val needed = required(action)
            // Export reads what is already on screen, so residency does not block it; every other
            // bulk action is a local write and shared-to-me rows must never take one.
            if (action != NoteBulkAction.EXPORT && note.residency != Residency.OWNED) {
                skipped.add(BulkSkip(id, BulkSkipReason.SHARED_ONLINE_ONLY))
                continue
            }
            if (!note.capabilities.contains(needed)) {
                skipped.add(BulkSkip(id, BulkSkipReason.NO_CAPABILITY))
                continue
            }
            val redundant = when (action) {
                NoteBulkAction.TRASH -> note.isTrashed
                NoteBulkAction.RESTORE -> !note.isTrashed
                NoteBulkAction.ADD_TAG -> tagValue.isBlank() || tagValue in note.tags
                NoteBulkAction.REMOVE_TAG -> tagValue.isBlank() || tagValue !in note.tags
                NoteBulkAction.MOVE_GROUP -> targetGroupPath != null && note.groupPath == targetGroupPath
                NoteBulkAction.EXPORT -> false
            }
            if (redundant) {
                skipped.add(BulkSkip(id, BulkSkipReason.ALREADY_IN_STATE))
                continue
            }
            accepted.add(note)
        }
        // Stable order so the confirmation list and the execution order agree.
        accepted.sortBy { it.noteId }
        skipped.sortBy { it.noteId }
        return BulkPlan(action = action, accepted = accepted, skipped = skipped)
    }

    /** The edited row for a bulk action, plus the field mask it changes. */
    fun applyTo(
        note: Note,
        action: NoteBulkAction,
        tagValue: String = "",
        targetGroupPath: String = "",
    ): Pair<Note, List<String>>? = when (action) {
        NoteBulkAction.ADD_TAG ->
            note.copy(tags = note.tags + tagValue) to listOf("tags")
        NoteBulkAction.REMOVE_TAG ->
            note.copy(tags = note.tags.filterNot { it == tagValue }) to listOf("tags")
        NoteBulkAction.MOVE_GROUP ->
            note.copy(groupPath = NoteGroups.normalize(targetGroupPath)) to listOf("groupPath")
        // Trash, restore and export are not field edits: they go through the repository's own
        // delete/restore path or produce a file, so there is no mask to compute.
        NoteBulkAction.TRASH, NoteBulkAction.RESTORE, NoteBulkAction.EXPORT -> null
    }
}
