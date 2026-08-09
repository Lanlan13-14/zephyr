package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.model.Note

/** One row of the group column on a tablet, already flattened for a LazyColumn. */
data class NoteGroupNode(
    val path: String,
    val name: String,
    val depth: Int,
    /** Notes filed directly in this group. */
    val directCount: Int,
    /** Notes in this group and everything beneath it, which is what a collapsed row must show. */
    val totalCount: Int,
)

/**
 * Group paths for the S32 group column.
 *
 * Zephyr stores the group as a single delimited string rather than a tree, so One derives the tree.
 * Doing that here rather than in the composable is what makes the tablet column testable and stops
 * two screens deriving slightly different trees from the same rows.
 */
object NoteGroups {

    const val SEPARATOR = '/'

    /** Notes with no group. Rendered as its own row so they are reachable, never hidden. */
    const val UNGROUPED = ""

    /**
     * Collapses separators and trims each segment.
     *
     * A leading or trailing separator is an input artefact; keeping it would create an empty
     * segment that renders as a nameless group row.
     */
    fun normalize(raw: String): String = raw
        .split(SEPARATOR)
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .joinToString(SEPARATOR.toString())

    fun nameOf(path: String): String = path.substringAfterLast(SEPARATOR, path)

    fun parentOf(path: String): String {
        val cut = path.lastIndexOf(SEPARATOR)
        return if (cut <= 0) UNGROUPED else path.substring(0, cut)
    }

    /** Every ancestor of a path including itself, root first. Used to expand to a selection. */
    fun ancestorsOf(path: String): List<String> {
        val normalized = normalize(path)
        if (normalized.isEmpty()) return emptyList()
        val result = ArrayList<String>()
        var current = ""
        for (segment in normalized.split(SEPARATOR)) {
            current = if (current.isEmpty()) segment else current + SEPARATOR + segment
            result.add(current)
        }
        return result
    }

    fun isDescendantOf(path: String, ancestor: String): Boolean {
        if (ancestor.isEmpty()) return true
        val normalized = normalize(path)
        return normalized == ancestor || normalized.startsWith(ancestor + SEPARATOR)
    }

    /**
     * The flattened tree, in display order.
     *
     * Intermediate groups are synthesised: a note filed at "运维/线上/数据库" must not make the
     * "运维" row disappear just because no note sits directly in it.
     */
    fun tree(notes: List<Note>): List<NoteGroupNode> {
        val direct = LinkedHashMap<String, Int>()
        for (note in notes) {
            val path = normalize(note.groupPath)
            direct[path] = (direct[path] ?: 0) + 1
        }

        val allPaths = sortedSetOf<String>()
        for (path in direct.keys) {
            if (path.isEmpty()) continue
            allPaths.addAll(ancestorsOf(path))
        }

        val nodes = allPaths.map { path ->
            NoteGroupNode(
                path = path,
                name = nameOf(path),
                depth = path.count { it == SEPARATOR },
                directCount = direct[path] ?: 0,
                totalCount = direct.entries.sumOf { (candidate, count) ->
                    if (isDescendantOf(candidate, path)) count else 0
                },
            )
        }

        val ungrouped = direct[UNGROUPED] ?: 0
        if (ungrouped == 0) return nodes
        // Ungrouped sits last: it is a fallback bucket, not the first thing a user is looking for.
        return nodes + NoteGroupNode(
            path = UNGROUPED,
            name = UNGROUPED,
            depth = 0,
            directCount = ungrouped,
            totalCount = ungrouped,
        )
    }
}
