package one.zephyr.mobile.feature.notes

/**
 * Undo/redo for the in-drawer SFTP editor.
 *
 * The previous editor copied the whole file into a `List<String>` on every keystroke.
 * A 200 KiB file then allocated another 200 KiB per character and recomputed outline
 * plus find against the new snapshot. Typing felt stuck because it *was* stuck.
 *
 * Snapshots are still full strings (the editor already holds the current text), but
 * successive small edits inside [coalesceMs] share one undo entry.
 */
class SftpEditorHistory(
    private val capacity: Int = DEFAULT_CAPACITY,
    private val coalesceMs: Long = DEFAULT_COALESCE_MS,
    private val coalesceChars: Int = DEFAULT_COALESCE_CHARS,
) {
    private val undo = ArrayList<String>()
    private val redo = ArrayList<String>()
    private var lastPushAt = 0L

    val undoSize: Int get() = undo.size
    val redoSize: Int get() = redo.size
    fun canUndo(): Boolean = undo.isNotEmpty()
    fun canRedo(): Boolean = redo.isNotEmpty()

    fun record(previous: String, next: String, nowMs: Long = System.currentTimeMillis()): Boolean {
        if (previous == next) return false
        val coalesce = undo.isNotEmpty() &&
            nowMs - lastPushAt in 0..coalesceMs &&
            isSmallSingleRegionEdit(previous, next)
        if (!coalesce) {
            undo += previous
            if (undo.size > capacity) undo.removeAt(0)
        }
        lastPushAt = nowMs
        redo.clear()
        return true
    }

    fun undo(current: String): String? {
        val previous = undo.removeLastOrNull() ?: return null
        redo += current
        lastPushAt = 0L
        return previous
    }

    fun redo(current: String): String? {
        val next = redo.removeLastOrNull() ?: return null
        undo += current
        lastPushAt = 0L
        return next
    }

    fun clear() {
        undo.clear()
        redo.clear()
        lastPushAt = 0L
    }

    private fun isSmallSingleRegionEdit(previous: String, next: String): Boolean {
        val prefix = commonPrefix(previous, next)
        val suffix = commonSuffix(previous, next, prefix)
        val removed = previous.length - prefix - suffix
        val inserted = next.length - prefix - suffix
        return removed <= coalesceChars && inserted <= coalesceChars
    }

    private fun commonPrefix(left: String, right: String): Int {
        val limit = minOf(left.length, right.length)
        var index = 0
        while (index < limit && left[index] == right[index]) index++
        return index
    }

    private fun commonSuffix(left: String, right: String, prefix: Int): Int {
        val leftRemain = left.length - prefix
        val rightRemain = right.length - prefix
        val limit = minOf(leftRemain, rightRemain)
        var index = 0
        while (index < limit && left[left.length - 1 - index] == right[right.length - 1 - index]) {
            index++
        }
        return index
    }

    companion object {
        const val DEFAULT_CAPACITY = 80
        const val DEFAULT_COALESCE_MS = 400L
        const val DEFAULT_COALESCE_CHARS = 24
    }
}
