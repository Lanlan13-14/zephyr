package one.zephyr.mobile.feature.notes

/**
 * What the editor recorded when it read the file.
 *
 * SCREEN_CATALOG.md 12: "读取时记录 mtime/hash". Both are kept because they answer different
 * questions at save time, and a baseline with only one of them cannot distinguish a touched file
 * from a rewritten one.
 */
data class EditorBaseline(
    val path: String,
    val mtimeMs: Long,
    val sha256: String,
)

/**
 * The save-time comparison outcome.
 *
 * Modelled as a type rather than a boolean so the UI cannot collapse the two frozen states
 * (mtime conflict and hash mismatch) into one "文件已变化" message: they need different wording and,
 * for [TouchedOnly], no interruption at all.
 */
sealed interface SaveGuard {

    /** Nothing moved since the read. */
    data object Clean : SaveGuard

    /**
     * mtime moved but the bytes are identical.
     *
     * Not a conflict: nobody's work is at risk. Interrupting here would train the user to click
     * through the overwrite dialog, which is exactly what makes the real conflict dangerous.
     */
    data class TouchedOnly(val serverMtimeMs: Long) : SaveGuard

    /** Someone else's edit is on the server. This is the state that must never be overwritten silently. */
    data class ContentChanged(val serverMtimeMs: Long, val serverSha256: String?) : SaveGuard

    /** The file is gone, so there is nothing to overwrite and "另存为" is the only sane path. */
    data object Vanished : SaveGuard

    /** The remote path became a directory, which no write can resolve. */
    data object BecameDirectory : SaveGuard

    val requiresPrompt: Boolean
        get() = this is ContentChanged || this is Vanished || this is BecameDirectory

    /** True when the server hash was unavailable, so the verdict came from mtime alone. */
    val isMtimeOnlyVerdict: Boolean
        get() = this is ContentChanged && serverSha256 == null
}

/** The choices the conflict dialog offers, per SCREEN_CATALOG.md 12: compare / 另存 / 覆盖确认. */
enum class SaveConflictChoice { COMPARE, SAVE_AS, OVERWRITE, CANCEL }

/** What the ViewModel should actually do next. */
sealed interface SavePlan {

    /** @param force true only after the user explicitly confirmed an overwrite. */
    data class Write(val force: Boolean) : SavePlan

    data class Prompt(val guard: SaveGuard) : SavePlan

    /** Write to a different path; the editor rebases onto the new file afterwards. */
    data class WriteCopy(val path: String) : SavePlan

    data object Abandon : SavePlan
}

/**
 * The S31 save-conflict rule.
 *
 * The whole point of this object is the frozen sentence "不静默覆盖". Every path that could reach a
 * forced write goes through [resolve] with an explicit [SaveConflictChoice.OVERWRITE], so there is
 * no code path where a stale baseline silently wins. Pure, so the entire matrix is unit tested
 * without an engine.
 */
object SftpEditorConflicts {

    /**
     * Compares the baseline against a fresh stat taken immediately before writing.
     *
     * @param current null when the stat found nothing.
     */
    fun guard(baseline: EditorBaseline, current: RemoteStat?): SaveGuard {
        if (current == null) return SaveGuard.Vanished
        if (current.isDirectory) return SaveGuard.BecameDirectory

        val hashKnown = current.sha256 != null
        val sameHash = ContentHash.matches(current.sha256, baseline.sha256)
        val sameMtime = current.mtimeMs == baseline.mtimeMs

        // Hash is authoritative when the adapter can supply it: it answers "did the bytes change",
        // which is the question that actually matters.
        if (hashKnown) {
            return when {
                sameHash && sameMtime -> SaveGuard.Clean
                sameHash -> SaveGuard.TouchedOnly(current.mtimeMs)
                else -> SaveGuard.ContentChanged(current.mtimeMs, current.sha256)
            }
        }

        // No server hash: mtime is all there is, so a moved mtime has to be treated as a content
        // change. Failing closed here can cost the user one extra dialog; failing open would cost
        // them someone else's work.
        return if (sameMtime) SaveGuard.Clean else SaveGuard.ContentChanged(current.mtimeMs, null)
    }

    /** First save attempt: prompt when the guard says so, otherwise a plain unforced write. */
    fun plan(guard: SaveGuard): SavePlan =
        if (guard.requiresPrompt) SavePlan.Prompt(guard) else SavePlan.Write(force = false)

    /**
     * Turns the user's dialog choice into the next action.
     *
     * [SaveConflictChoice.COMPARE] deliberately keeps the prompt open: viewing a diff is not a
     * decision, and closing the dialog on it would leave the user with unsaved work and no dialog.
     */
    fun resolve(
        choice: SaveConflictChoice,
        guard: SaveGuard,
        copyPath: String?,
    ): SavePlan = when (choice) {
        SaveConflictChoice.COMPARE -> SavePlan.Prompt(guard)
        SaveConflictChoice.SAVE_AS ->
            if (copyPath.isNullOrBlank()) SavePlan.Prompt(guard) else SavePlan.WriteCopy(copyPath)
        // A vanished file has nothing to overwrite, so overwrite cannot be honoured as such; it
        // becomes a plain create, which is what the user meant by "save it anyway".
        SaveConflictChoice.OVERWRITE -> SavePlan.Write(force = true)
        SaveConflictChoice.CANCEL -> SavePlan.Abandon
    }

    /**
     * Suggested "另存为" name: the original with a marker inserted before the extension.
     *
     * Never the same path, because a save-as that collided with the file it is protecting would
     * defeat the purpose.
     */
    fun copyPathFor(path: String, marker: String = COPY_MARKER): String {
        val directory = RemotePath.parentOf(path)
        val name = RemotePath.nameOf(path)
        val dot = name.lastIndexOf('.')
        val renamed = if (dot <= 0) {
            name + marker
        } else {
            name.substring(0, dot) + marker + name.substring(dot)
        }
        return RemotePath.join(directory, renamed)
    }

    const val COPY_MARKER = ".local"
}
