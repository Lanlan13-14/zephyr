package one.zephyr.mobile.feature.notes

/** An inline emphasis run inside one text block. */
data class MarkdownSpan(val start: Int, val end: Int, val style: MarkdownStyle)

enum class MarkdownStyle { BOLD, ITALIC, CODE, STRIKETHROUGH }

/** Text with its inline styling resolved, so the composable only positions glyphs. */
data class MarkdownText(val text: String, val spans: List<MarkdownSpan>)

/** One block of the rendered preview. */
sealed interface MarkdownBlock {
    data class Heading(val level: Int, val text: MarkdownText) : MarkdownBlock

    data class Paragraph(val text: MarkdownText) : MarkdownBlock

    /** @param language empty when the fence carried no info string. */
    data class CodeBlock(val language: String, val code: String) : MarkdownBlock

    data class BulletItem(val depth: Int, val text: MarkdownText) : MarkdownBlock

    data class NumberedItem(val depth: Int, val number: Int, val text: MarkdownText) : MarkdownBlock

    data class Quote(val text: MarkdownText) : MarkdownBlock

    /** @param checked renders a real checkbox state, which a plain bullet cannot convey. */
    data class TaskItem(val depth: Int, val checked: Boolean, val text: MarkdownText) : MarkdownBlock

    /**
     * GFM table. [alignments] has one entry per column: left / center / right / "" (default).
     * Cell text keeps inline styling, which is how the main end's markdown.js renders it.
     */
    data class Table(
        val header: List<MarkdownText>,
        val alignments: List<String>,
        val rows: List<List<MarkdownText>>,
    ) : MarkdownBlock

    data object Divider : MarkdownBlock
}

/**
 * The Markdown subset S32 previews.
 *
 * Deliberately small and dependency-free. SCREEN_CATALOG.md 13 asks for Markdown 编辑/预览, not a
 * CommonMark-complete renderer, and a note is the user's own text: shipping a third-party parser
 * would add an HTML/inline-script surface to a screen that only needs to lay out prose. Anything not
 * recognised is rendered verbatim as a paragraph, so no input is ever lost or silently altered.
 */
object Markdown {

    const val FENCE = "```"
    const val MAX_HEADING_LEVEL = 6

    /** Preview beyond this many blocks is truncated: a 1 MiB note would otherwise stall layout. */
    const val MAX_PREVIEW_BLOCKS = 2_000

    fun parse(source: String): List<MarkdownBlock> {
        val blocks = ArrayList<MarkdownBlock>()
        val lines = source.split("\n").map { it.removeSuffix("\r") }
        val paragraph = StringBuilder()
        var index = 0

        fun flushParagraph() {
            if (paragraph.isEmpty()) return
            blocks.add(MarkdownBlock.Paragraph(inline(paragraph.toString())))
            paragraph.setLength(0)
        }

        while (index < lines.size && blocks.size < MAX_PREVIEW_BLOCKS) {
            val line = lines[index]
            val trimmed = line.trim()

            if (trimmed.startsWith(FENCE)) {
                flushParagraph()
                val language = trimmed.removePrefix(FENCE).trim()
                val code = StringBuilder()
                index++
                // An unterminated fence takes the rest of the document rather than falling back to
                // paragraphs: that is what the user sees in every other Markdown editor.
                while (index < lines.size && lines[index].trim() != FENCE) {
                    if (code.isNotEmpty()) code.append("\n")
                    code.append(lines[index])
                    index++
                }
                if (index < lines.size) index++
                blocks.add(MarkdownBlock.CodeBlock(language = language, code = code.toString()))
                continue
            }

            if (trimmed.isEmpty()) {
                flushParagraph()
                index++
                continue
            }

            // GFM table: a header row of pipe cells followed by an alignment separator. Only
            // recognised when both lines match, so an ordinary "| a | b" sentence stays a paragraph.
            if (index + 1 < lines.size && isTableSeparator(lines[index + 1]) && isTableRow(trimmed)) {
                flushParagraph()
                val header = splitTableRow(trimmed).map { inline(it) }
                val alignments = tableAlignments(lines[index + 1])
                val body = ArrayList<List<MarkdownText>>()
                index += 2
                while (index < lines.size && isTableRow(lines[index].trim()) && lines[index].isNotBlank()) {
                    body.add(splitTableRow(lines[index].trim()).map { inline(it) })
                    index++
                }
                blocks.add(MarkdownBlock.Table(header = header, alignments = alignments, rows = body))
                continue
            }

            if (isDivider(trimmed)) {
                flushParagraph()
                blocks.add(MarkdownBlock.Divider)
                index++
                continue
            }

            val heading = headingLevel(trimmed)
            if (heading > 0) {
                flushParagraph()
                blocks.add(
                    MarkdownBlock.Heading(
                        level = heading,
                        text = inline(trimmed.substring(heading).trim()),
                    ),
                )
                index++
                continue
            }

            if (trimmed.startsWith("> ") || trimmed == ">") {
                flushParagraph()
                blocks.add(MarkdownBlock.Quote(inline(trimmed.removePrefix(">").trim())))
                index++
                continue
            }

            val depth = indentDepth(line)
            val task = taskMarker(trimmed)
            if (task != null) {
                flushParagraph()
                blocks.add(
                    MarkdownBlock.TaskItem(
                        depth = depth,
                        checked = task.first,
                        text = inline(task.second),
                    ),
                )
                index++
                continue
            }

            if (isBullet(trimmed)) {
                flushParagraph()
                blocks.add(
                    MarkdownBlock.BulletItem(depth = depth, text = inline(trimmed.substring(2).trim())),
                )
                index++
                continue
            }

            val numbered = numberedMarker(trimmed)
            if (numbered != null) {
                flushParagraph()
                blocks.add(
                    MarkdownBlock.NumberedItem(
                        depth = depth,
                        number = numbered.first,
                        text = inline(numbered.second),
                    ),
                )
                index++
                continue
            }

            // Soft line breaks join into one paragraph, which is standard Markdown behaviour and
            // stops a hard-wrapped note from rendering as one line per source line.
            if (paragraph.isNotEmpty()) paragraph.append(" ")
            paragraph.append(trimmed)
            index++
        }
        flushParagraph()
        return blocks
    }

    private fun isDivider(trimmed: String): Boolean =
        trimmed.length >= 3 && (trimmed.all { it == '-' } || trimmed.all { it == '*' } || trimmed.all { it == '_' })

    /** A table body/header line: at least one pipe, same rule as the main end's splitTableRow. */
    private fun isTableRow(trimmed: String): Boolean = trimmed.contains('|')

    /** The | --- | :---: | ---: | separator. Requires at least one dash per cell, like GFM. */
    private fun isTableSeparator(line: String): Boolean {
        val trimmed = line.trim()
        if (!trimmed.contains('-') || !isTableRow(trimmed)) return false
        val cells = splitTableRow(trimmed)
        if (cells.isEmpty()) return false
        return cells.all { cell ->
            val body = cell.removePrefix(":").removeSuffix(":")
            body.isNotEmpty() && body.all { it == '-' }
        }
    }

    private fun splitTableRow(line: String): List<String> {
        var value = line.trim()
        if (value.startsWith("|")) value = value.substring(1)
        if (value.endsWith("|")) value = value.substring(0, value.length - 1)
        if (value.isEmpty()) return emptyList()
        return value.split('|').map { it.trim() }
    }

    private fun tableAlignments(separator: String): List<String> =
        splitTableRow(separator).map { cell ->
            val left = cell.startsWith(":")
            val right = cell.endsWith(":")
            when {
                left && right -> "center"
                right -> "right"
                left -> "left"
                else -> ""
            }
        }

    private fun headingLevel(trimmed: String): Int {
        var level = 0
        while (level < trimmed.length && trimmed[level] == '#') level++
        if (level == 0 || level > MAX_HEADING_LEVEL) return 0
        // "#hashtag" is not a heading: ATX requires a space after the run of hashes.
        if (level >= trimmed.length || trimmed[level] != ' ') return 0
        return level
    }

    private fun isBullet(trimmed: String): Boolean =
        trimmed.length > 1 &&
            (trimmed.startsWith("- ") || trimmed.startsWith("* ") || trimmed.startsWith("+ "))

    private fun taskMarker(trimmed: String): Pair<Boolean, String>? {
        if (!isBullet(trimmed)) return null
        val body = trimmed.substring(2).trim()
        return when {
            body.startsWith("[ ] ") -> false to body.removePrefix("[ ] ").trim()
            body.startsWith("[x] ") || body.startsWith("[X] ") -> true to body.substring(4).trim()
            body == "[ ]" -> false to ""
            body == "[x]" || body == "[X]" -> true to ""
            else -> null
        }
    }

    private fun numberedMarker(trimmed: String): Pair<Int, String>? {
        val dot = trimmed.indexOf(". ")
        if (dot <= 0 || dot > 9) return null
        val number = trimmed.substring(0, dot).toIntOrNull() ?: return null
        return number to trimmed.substring(dot + 2).trim()
    }

    /** Two spaces per level, which is the indent every list in a note actually uses. */
    private fun indentDepth(line: String): Int {
        var spaces = 0
        for (character in line) {
            when (character) {
                ' ' -> spaces++
                '\t' -> spaces += 2
                else -> return spaces / 2
            }
        }
        return spaces / 2
    }

    /**
     * Inline emphasis.
     *
     * Code spans are resolved first and their contents are excluded from further matching, because
     * inside backticks an asterisk is literal. Unmatched markers are left as text rather than
     * treated as an error: a lone asterisk is a perfectly ordinary character in prose.
     */
    fun inline(source: String): MarkdownText {
        val out = StringBuilder()
        val spans = ArrayList<MarkdownSpan>()
        var index = 0

        while (index < source.length) {
            val character = source[index]
            when {
                character == '\\' && index + 1 < source.length -> {
                    out.append(source[index + 1])
                    index += 2
                }

                character == '`' -> {
                    val close = source.indexOf('`', index + 1)
                    if (close < 0) {
                        out.append(character)
                        index++
                    } else {
                        val start = out.length
                        out.append(source, index + 1, close)
                        spans.add(MarkdownSpan(start, out.length, MarkdownStyle.CODE))
                        index = close + 1
                    }
                }

                source.startsWith("**", index) -> {
                    val close = source.indexOf("**", index + 2)
                    if (close < 0) {
                        out.append("**")
                        index += 2
                    } else {
                        val nested = inline(source.substring(index + 2, close))
                        val start = out.length
                        out.append(nested.text)
                        spans.add(MarkdownSpan(start, out.length, MarkdownStyle.BOLD))
                        spans.addAll(nested.spans.map { it.copy(start = it.start + start, end = it.end + start) })
                        index = close + 2
                    }
                }

                source.startsWith("~~", index) -> {
                    val close = source.indexOf("~~", index + 2)
                    if (close < 0) {
                        out.append("~~")
                        index += 2
                    } else {
                        val nested = inline(source.substring(index + 2, close))
                        val start = out.length
                        out.append(nested.text)
                        spans.add(MarkdownSpan(start, out.length, MarkdownStyle.STRIKETHROUGH))
                        spans.addAll(nested.spans.map { it.copy(start = it.start + start, end = it.end + start) })
                        index = close + 2
                    }
                }

                character == '*' || character == '_' -> {
                    val close = source.indexOf(character, index + 1)
                    if (close < 0) {
                        out.append(character)
                        index++
                    } else {
                        val nested = inline(source.substring(index + 1, close))
                        val start = out.length
                        out.append(nested.text)
                        spans.add(MarkdownSpan(start, out.length, MarkdownStyle.ITALIC))
                        spans.addAll(nested.spans.map { it.copy(start = it.start + start, end = it.end + start) })
                        index = close + 1
                    }
                }

                else -> {
                    out.append(character)
                    index++
                }
            }
        }
        return MarkdownText(text = out.toString(), spans = spans)
    }

    /**
     * Plain-text projection, used for the list row summary and the search index.
     *
     * Markers are stripped rather than shown, so a preview line reads as prose instead of leaking
     * hashes and asterisks into a two-line summary.
     */
    fun plainSummary(source: String, maxChars: Int = 140): String {
        val text = parse(source)
            .asSequence()
            .mapNotNull { block ->
                when (block) {
                    is MarkdownBlock.Heading -> block.text.text
                    is MarkdownBlock.Paragraph -> block.text.text
                    is MarkdownBlock.BulletItem -> block.text.text
                    is MarkdownBlock.NumberedItem -> block.text.text
                    is MarkdownBlock.TaskItem -> block.text.text
                    is MarkdownBlock.Quote -> block.text.text
                    is MarkdownBlock.CodeBlock -> block.code.lineSequence().firstOrNull()
                    MarkdownBlock.Divider -> null
                }
            }
            .filter { it.isNotBlank() }
            .joinToString(" ")
        return if (text.length <= maxChars) text else text.take(maxChars).trimEnd() + "…"
    }
}
