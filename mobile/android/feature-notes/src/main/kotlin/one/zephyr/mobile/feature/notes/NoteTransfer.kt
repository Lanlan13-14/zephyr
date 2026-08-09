package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.model.Note

/**
 * One parsed import candidate, before it becomes a [Note].
 *
 * Kept separate from [Note] because an imported file has no id, no owner and no revision: minting
 * those is the ViewModel's job, and letting the parser do it would make an import look like it had
 * already been reconciled with the mirror.
 */
data class NoteImportCandidate(
    val title: String,
    val content: String,
    val groupPath: String = "",
    val tags: List<String> = emptyList(),
)

/** Why one file in a multi-file import was skipped, so the summary can be specific. */
enum class NoteImportSkipReason {
    EMPTY_FILE,
    TITLE_TOO_LONG,
    CONTENT_TOO_LARGE,
    TOO_MANY_TAGS,
}

data class NoteImportResult(
    val accepted: List<NoteImportCandidate>,
    val skipped: List<Pair<String, NoteImportSkipReason>>,
) {
    val acceptedCount: Int get() = accepted.size
    val skippedCount: Int get() = skipped.size
}

/**
 * Markdown import and export for S32 导入/导出.
 *
 * The format is Markdown with a small YAML-ish front matter block. It is deliberately not JSON: the
 * export is meant to stay readable and editable outside One, and a note is already Markdown. Only
 * the four fields a user can reconstruct are carried; revision, owner and sync state are server or
 * device facts that must not be importable, because a file claiming revision 9 would otherwise be
 * able to fabricate a sync baseline.
 *
 * Import enforces the same frozen limits as the editor (SCREEN_CATALOG.md 13) so a bad file becomes
 * a reported skip rather than a rejected push later.
 */
object NoteTransfer {

    const val DELIMITER = "---"
    const val KEY_TITLE = "title"
    const val KEY_GROUP = "group"
    const val KEY_TAGS = "tags"

    /** Export file name, sanitised so a title with a slash cannot escape the target directory. */
    fun fileNameFor(note: Note): String {
        val safe = note.title.trim()
            .map { character -> if (character in ILLEGAL_NAME_CHARS || character.code < 0x20) '_' else character }
            .joinToString("")
            .trim()
            .take(MAX_FILE_NAME_STEM)
        val stem = safe.ifEmpty { note.noteId }
        return stem + ".md"
    }

    fun export(note: Note): String = buildString {
        append(DELIMITER).append('\n')
        append(KEY_TITLE).append(": ").append(escapeValue(note.title)).append('\n')
        if (note.groupPath.isNotEmpty()) {
            append(KEY_GROUP).append(": ").append(escapeValue(note.groupPath)).append('\n')
        }
        if (note.tags.isNotEmpty()) {
            append(KEY_TAGS).append(": ").append(note.tags.joinToString(", ") { escapeValue(it) }).append('\n')
        }
        append(DELIMITER).append('\n')
        append(note.content)
    }

    /**
     * Parses one file.
     *
     * A file with no front matter is still accepted: the first Markdown heading becomes the title
     * and the whole text becomes the body. Refusing it would make One unable to import a plain
     * Markdown file, which is the most likely thing a user actually has.
     */
    fun parse(fileName: String, text: String): NoteImportCandidate? {
        val normalized = text.replace("\r\n", "\n").replace('\r', '\n')
        if (normalized.isBlank()) return null

        val lines = normalized.split('\n')
        if (lines.firstOrNull()?.trim() == DELIMITER) {
            val closing = lines.drop(1).indexOfFirst { it.trim() == DELIMITER }
            if (closing >= 0) {
                val header = lines.subList(1, closing + 1)
                val body = lines.drop(closing + 2).joinToString("\n")
                return fromFrontMatter(fileName, header, body)
            }
        }
        return fromPlainMarkdown(fileName, normalized)
    }

    private fun fromFrontMatter(
        fileName: String,
        header: List<String>,
        body: String,
    ): NoteImportCandidate {
        var title = ""
        var group = ""
        var tags = emptyList<String>()
        for (line in header) {
            val separator = line.indexOf(':')
            if (separator <= 0) continue
            val key = line.substring(0, separator).trim().lowercase()
            val value = unescapeValue(line.substring(separator + 1).trim())
            when (key) {
                KEY_TITLE -> title = value
                KEY_GROUP -> group = value
                KEY_TAGS -> tags = value.split(',').map { it.trim() }.filter { it.isNotEmpty() }.distinct()
            }
        }
        return NoteImportCandidate(
            title = title.ifEmpty { titleFromFileName(fileName) },
            content = body,
            groupPath = group,
            tags = tags,
        )
    }

    private fun fromPlainMarkdown(fileName: String, text: String): NoteImportCandidate {
        val heading = text.split('\n').firstOrNull { it.trimStart().startsWith("#") }
        val title = heading?.trimStart()?.trimStart('#')?.trim().orEmpty()
        return NoteImportCandidate(
            title = title.ifEmpty { titleFromFileName(fileName) },
            content = text,
        )
    }

    private fun titleFromFileName(fileName: String): String =
        fileName.substringAfterLast('/').substringBeforeLast('.').ifEmpty { fileName }

    /**
     * Validates a batch.
     *
     * The bulk ceiling is applied by the caller through [NoteBulk]; this only rejects individual
     * files that could never be saved, and it reports why per file rather than failing the whole
     * import, because one oversized file should not discard 40 good ones.
     */
    fun validate(candidates: List<Pair<String, NoteImportCandidate>>): NoteImportResult {
        val accepted = ArrayList<NoteImportCandidate>()
        val skipped = ArrayList<Pair<String, NoteImportSkipReason>>()
        for ((fileName, candidate) in candidates) {
            val reason = when {
                candidate.title.isBlank() && candidate.content.isBlank() -> NoteImportSkipReason.EMPTY_FILE
                candidate.title.length > Note.MAX_TITLE_CHARS -> NoteImportSkipReason.TITLE_TOO_LONG
                Utf8Size.of(candidate.content) > Note.MAX_CONTENT_BYTES -> NoteImportSkipReason.CONTENT_TOO_LARGE
                candidate.tags.size > Note.MAX_TAGS -> NoteImportSkipReason.TOO_MANY_TAGS
                else -> null
            }
            if (reason == null) accepted.add(candidate) else skipped.add(fileName to reason)
        }
        return NoteImportResult(accepted = accepted, skipped = skipped)
    }

    /**
     * A value containing a newline would break the one-line-per-key format, so it is encoded rather
     * than dropped: losing part of a title on export would make the round trip lossy.
     */
    private fun escapeValue(value: String): String =
        value.replace("\\", "\\\\").replace("\n", "\\n")

    private fun unescapeValue(value: String): String {
        val out = StringBuilder(value.length)
        var index = 0
        while (index < value.length) {
            val character = value[index]
            if (character == '\\' && index + 1 < value.length) {
                when (value[index + 1]) {
                    'n' -> { out.append('\n'); index += 2 }
                    '\\' -> { out.append('\\'); index += 2 }
                    else -> { out.append(character); index++ }
                }
            } else {
                out.append(character)
                index++
            }
        }
        return out.toString()
    }

    private const val MAX_FILE_NAME_STEM = 64
    private val ILLEGAL_NAME_CHARS = charArrayOf('/', '\\', ':', '*', '?', '"', '<', '>', '|')
}
