package one.zephyr.mobile.feature.notes

import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.contracts.ConflictResolution
import one.zephyr.mobile.data.EntityCodec
import one.zephyr.mobile.model.ConflictRecord

/** Which of the three revisions a value came from. */
enum class NoteConflictSide { BASE, LOCAL, SERVER }

/** One revision of a note, projected out of a conflict payload. */
data class NoteSideSnapshot(
    val title: String,
    val content: String,
    val groupPath: String,
    val tags: List<String>,
    val linkedConnectionIds: List<String>,
) {
    companion object {
        fun from(payload: JsonObject): NoteSideSnapshot = NoteSideSnapshot(
            title = EntityCodec.text(payload, "title"),
            content = EntityCodec.text(payload, "content"),
            groupPath = EntityCodec.text(payload, "groupPath"),
            tags = EntityCodec.stringList(payload, "tags"),
            linkedConnectionIds = EntityCodec.stringList(payload, "linkedConnectionIds"),
        )

        fun fromJson(payloadJson: String): NoteSideSnapshot = from(EntityCodec.parse(payloadJson))
    }
}

/** A scalar field that differs between revisions. Single-valued fields cannot be text-merged. */
data class NoteFieldConflict(
    val field: String,
    val base: String?,
    val local: String,
    val server: String,
) {
    /** True when only one side moved, so the outcome is unambiguous even without user input. */
    val isOneSided: Boolean
        get() = base != null && (base == local || base == server)
}

/**
 * Everything the S32 compare screen renders.
 *
 * SCREEN_CATALOG.md 13 requires base, local and server to be *shown*, plus three-way merge, keep
 * local, keep server and copy-as-new. [base] is nullable because the frozen conflict row does not
 * persist a base payload today (core-data ConflictRow has localPayloadJson and serverPayloadJson
 * only, and ConflictRepository passes basePayloadJson = null). Rather than fabricate a base, this
 * type reports its absence: [canAutoMerge] is false and the UI says the common ancestor is
 * unavailable, which keeps the remaining three choices honest and correct.
 */
data class NoteConflictView(
    val conflictId: String,
    val noteId: String,
    val displayName: String,
    val base: NoteSideSnapshot?,
    val local: NoteSideSnapshot,
    val server: NoteSideSnapshot,
    val overlappingFields: List<String>,
    val serverRevision: Long,
    val detectedAt: Long,
    /** True when the server side is a tombstone: keep-local is impossible, copy-as-new is the fix. */
    val serverDeleted: Boolean = false,
) {
    /** A three-way merge needs a common ancestor; without one only pick-a-side is truthful. */
    val canAutoMerge: Boolean get() = base != null

    /** Scalar fields that need a pick, excluding content which has its own line merge. */
    fun fieldConflicts(): List<NoteFieldConflict> = buildList {
        addIfDiffering("title", base?.title, local.title, server.title)
        addIfDiffering("groupPath", base?.groupPath, local.groupPath, server.groupPath)
        addIfDiffering(
            field = "tags",
            baseValue = base?.tags?.joinToString(TAG_JOIN),
            localValue = local.tags.joinToString(TAG_JOIN),
            serverValue = server.tags.joinToString(TAG_JOIN),
        )
        addIfDiffering(
            field = "linkedConnectionIds",
            baseValue = base?.linkedConnectionIds?.joinToString(TAG_JOIN),
            localValue = local.linkedConnectionIds.joinToString(TAG_JOIN),
            serverValue = server.linkedConnectionIds.joinToString(TAG_JOIN),
        )
    }

    private fun MutableList<NoteFieldConflict>.addIfDiffering(
        field: String,
        baseValue: String?,
        localValue: String,
        serverValue: String,
    ) {
        if (localValue == serverValue) return
        add(NoteFieldConflict(field = field, base = baseValue, local = localValue, server = serverValue))
    }

    fun snapshotOf(side: NoteConflictSide): NoteSideSnapshot? = when (side) {
        NoteConflictSide.BASE -> base
        NoteConflictSide.LOCAL -> local
        NoteConflictSide.SERVER -> server
    }

    companion object {
        const val TAG_JOIN = "、"

        /**
         * @param basePayloadJson supplied by the caller once a base revision is available. Taken as
         *   a parameter rather than read from [record] so the seam is explicit at the call site.
         */
        fun from(
            record: ConflictRecord,
            basePayloadJson: String? = record.basePayloadJson,
            serverDeleted: Boolean = false,
        ): NoteConflictView = NoteConflictView(
            conflictId = record.conflictId,
            noteId = record.entityId,
            displayName = record.displayName,
            base = basePayloadJson?.let(NoteSideSnapshot::fromJson),
            local = NoteSideSnapshot.fromJson(record.localPayloadJson),
            server = NoteSideSnapshot.fromJson(record.serverPayloadJson),
            overlappingFields = record.overlappingFields,
            serverRevision = record.serverRevision,
            detectedAt = record.detectedAt,
            serverDeleted = serverDeleted,
        )
    }
}

/**
 * The four frozen resolutions from SCREEN_CATALOG.md 13.
 *
 * Mapped onto the wire [ConflictResolution] here so the screen never names a wire enum, and so
 * MERGE is correctly reported to the sync layer as MANUAL_MERGE: the merged text is a new local
 * edit that must be pushed at the newest server revision, not a "use server".
 */
enum class NoteMergeChoice {
    MERGE,
    KEEP_LOCAL,
    KEEP_SERVER,
    COPY_AS_NEW,
    ;

    fun toResolution(): ConflictResolution = when (this) {
        MERGE -> ConflictResolution.MANUAL_MERGE
        KEEP_LOCAL -> ConflictResolution.KEEP_LOCAL
        KEEP_SERVER -> ConflictResolution.USE_SERVER
        COPY_AS_NEW -> ConflictResolution.COPY_AS_NEW
    }

    /**
     * Choices that remain valid for this conflict.
     *
     * A server tombstone or an ACL revocation makes keep-local impossible: core-data's
     * ConflictRepository.resolve throws for it, so offering the button would be offering a failure.
     */
    companion object {
        fun available(view: NoteConflictView): List<NoteMergeChoice> = entries.filter { choice ->
            when (choice) {
                MERGE -> view.canAutoMerge && !view.serverDeleted
                KEEP_LOCAL -> !view.serverDeleted
                KEEP_SERVER, COPY_AS_NEW -> true
            }
        }
    }
}

/** One run of the merged document. */
sealed interface MergeSection {
    /** Lines all three revisions agree on, or a change only one side made. */
    data class Agreed(val lines: List<String>) : MergeSection

    /** Both sides changed the same run differently; only the user can choose. */
    data class Conflict(
        val base: List<String>,
        val local: List<String>,
        val server: List<String>,
    ) : MergeSection
}

data class MergeResult(
    val sections: List<MergeSection>,
    /** True when the document was too large to align line by line. */
    val tooLargeToMerge: Boolean = false,
) {
    val conflictCount: Int get() = sections.count { it is MergeSection.Conflict }

    val hasConflict: Boolean get() = conflictCount > 0

    /** The merged document, or null while any conflict is unresolved. */
    fun mergedTextOrNull(): String? {
        if (hasConflict) return null
        return sections.flatMap { section -> (section as MergeSection.Agreed).lines }
            .joinToString(NoteMerge.LINE_SEPARATOR)
    }

    /** The merged document with every remaining conflict taken from one side. */
    fun resolvedText(preferring: NoteConflictSide): String = sections
        .flatMap { section ->
            when (section) {
                is MergeSection.Agreed -> section.lines
                is MergeSection.Conflict -> when (preferring) {
                    NoteConflictSide.BASE -> section.base
                    NoteConflictSide.LOCAL -> section.local
                    NoteConflictSide.SERVER -> section.server
                }
            }
        }
        .joinToString(NoteMerge.LINE_SEPARATOR)
}

/**
 * Line-based three-way merge.
 *
 * diff3 rather than "last writer wins": SCREEN_CATALOG.md 13 requires a real merge, and a note is
 * prose, so two people editing different paragraphs must not lose one of them. The rule is the
 * classical one - a run only conflicts when local and server both moved away from base *and*
 * disagree with each other.
 */
object NoteMerge {

    const val LINE_SEPARATOR = "\n"

    /**
     * Alignment is O(n*m) in memory, so a ceiling exists.
     *
     * Above it the merge reports [MergeResult.tooLargeToMerge] and presents the whole document as a
     * single conflict, which is honest: the user still gets keep-local, keep-server and copy-as-new,
     * and the app does not allocate a 1 GiB table for a 1 MiB note.
     */
    const val MAX_MERGE_LINES = 1_000

    fun splitLines(text: String): List<String> =
        if (text.isEmpty()) emptyList() else text.split(LINE_SEPARATOR).map { it.removeSuffix("\r") }

    fun merge(baseText: String, localText: String, serverText: String): MergeResult {
        val base = splitLines(baseText)
        val local = splitLines(localText)
        val server = splitLines(serverText)

        if (base.size > MAX_MERGE_LINES || local.size > MAX_MERGE_LINES || server.size > MAX_MERGE_LINES) {
            return MergeResult(
                sections = listOf(MergeSection.Conflict(base = base, local = local, server = server)),
                tooLargeToMerge = true,
            )
        }
        if (local == server) return MergeResult(listOf(MergeSection.Agreed(local)))
        if (base == local) return MergeResult(listOf(MergeSection.Agreed(server)))
        if (base == server) return MergeResult(listOf(MergeSection.Agreed(local)))

        val localMatches = matchedPairs(base, local)
        val serverMatches = matchedPairs(base, server)
        // A base line is an anchor only when *both* sides kept it: anchoring on a line one side
        // deleted would splice the other side's edit into the wrong place.
        val anchors = localMatches.keys.intersect(serverMatches.keys).sorted()

        val sections = ArrayList<MergeSection>()
        val pending = ArrayList<String>()
        var baseCursor = 0
        var localCursor = 0
        var serverCursor = 0

        for (anchor in anchors) {
            val localAnchor = localMatches.getValue(anchor)
            val serverAnchor = serverMatches.getValue(anchor)
            val baseRun = base.subList(baseCursor, anchor).toList()
            val localRun = local.subList(localCursor, localAnchor).toList()
            val serverRun = server.subList(serverCursor, serverAnchor).toList()

            when {
                localRun == serverRun -> pending.addAll(localRun)
                localRun == baseRun -> pending.addAll(serverRun)
                serverRun == baseRun -> pending.addAll(localRun)
                else -> {
                    if (pending.isNotEmpty()) {
                        sections.add(MergeSection.Agreed(pending.toList()))
                        pending.clear()
                    }
                    sections.add(MergeSection.Conflict(base = baseRun, local = localRun, server = serverRun))
                }
            }
            pending.add(base[anchor])
            baseCursor = anchor + 1
            localCursor = localAnchor + 1
            serverCursor = serverAnchor + 1
        }

        val baseTail = base.subList(baseCursor, base.size).toList()
        val localTail = local.subList(localCursor, local.size).toList()
        val serverTail = server.subList(serverCursor, server.size).toList()
        when {
            localTail == serverTail -> pending.addAll(localTail)
            localTail == baseTail -> pending.addAll(serverTail)
            serverTail == baseTail -> pending.addAll(localTail)
            else -> {
                if (pending.isNotEmpty()) {
                    sections.add(MergeSection.Agreed(pending.toList()))
                    pending.clear()
                }
                sections.add(MergeSection.Conflict(base = baseTail, local = localTail, server = serverTail))
            }
        }
        if (pending.isNotEmpty()) sections.add(MergeSection.Agreed(pending.toList()))

        return MergeResult(sections)
    }

    /**
     * Longest common subsequence, as a base-index to other-index map.
     *
     * LCS rather than a hash-based anchor scan because a note legitimately repeats lines (blank
     * lines, list markers), and a repeated line is not a reliable unique anchor.
     */
    internal fun matchedPairs(base: List<String>, other: List<String>): Map<Int, Int> {
        val rows = base.size
        val columns = other.size
        if (rows == 0 || columns == 0) return emptyMap()

        val table = Array(rows + 1) { IntArray(columns + 1) }
        for (row in rows - 1 downTo 0) {
            for (column in columns - 1 downTo 0) {
                table[row][column] = if (base[row] == other[column]) {
                    table[row + 1][column + 1] + 1
                } else {
                    maxOf(table[row + 1][column], table[row][column + 1])
                }
            }
        }

        val pairs = LinkedHashMap<Int, Int>()
        var row = 0
        var column = 0
        while (row < rows && column < columns) {
            when {
                base[row] == other[column] -> {
                    pairs[row] = column
                    row++
                    column++
                }
                table[row + 1][column] >= table[row][column + 1] -> row++
                else -> column++
            }
        }
        return pairs
    }
}
