package one.zephyr.mobile.ui.component

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import one.zephyr.mobile.ui.theme.ZephyrTheme

/** An inline emphasis run inside one text block. */
data class MarkdownSpan(val start: Int, val end: Int, val style: MarkdownStyle)

enum class MarkdownStyle { BOLD, ITALIC, CODE, STRIKETHROUGH, LINK }

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
     */
    data class Table(
        val header: List<MarkdownText>,
        val alignments: List<String>,
        val rows: List<List<MarkdownText>>,
    ) : MarkdownBlock

    data object Divider : MarkdownBlock
}

/**
 * Dependency-free GFM-compatible Markdown parser.
 */
object Markdown {

    const val FENCE = "```"
    const val MAX_HEADING_LEVEL = 6
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

            if (paragraph.isNotEmpty()) paragraph.append(" ")
            paragraph.append(trimmed)
            index++
        }
        flushParagraph()
        return blocks
    }

    private fun isDivider(trimmed: String): Boolean =
        trimmed.length >= 3 && (trimmed.all { it == '-' } || trimmed.all { it == '*' } || trimmed.all { it == '_' })

    private fun isTableRow(trimmed: String): Boolean = trimmed.contains('|')

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

    private fun findMatchingCloseParen(source: String, openIndex: Int): Int {
        var depth = 0
        for (i in openIndex until source.length) {
            when (source[i]) {
                '(' -> depth++
                ')' -> {
                    depth--
                    if (depth == 0) return i
                }
            }
        }
        return -1
    }

    private fun isSafeHref(url: String): Boolean {
        val value = url.trim().lowercase()
        if (value.isEmpty()) return false
        if (value.startsWith("/") || value.startsWith("#")) return true
        val scheme = value.substringBefore(':', "")
        return scheme in SAFE_SCHEMES
    }

    private val SAFE_SCHEMES = setOf("http", "https", "mailto", "tel", "ssh", "telnet", "jms", "ftp")

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

                character == '[' -> {
                    val labelEnd = source.indexOf(']', index + 1)
                    val urlOpen = if (labelEnd >= 0 && labelEnd + 1 < source.length && source[labelEnd + 1] == '(') labelEnd + 1 else -1
                    val urlClose = if (urlOpen >= 0) findMatchingCloseParen(source, urlOpen) else -1
                    if (labelEnd < 0 || urlOpen < 0 || urlClose < 0) {
                        out.append(character)
                        index++
                    } else {
                        val label = source.substring(index + 1, labelEnd)
                        val url = source.substring(urlOpen + 1, urlClose).trim()
                        if (isSafeHref(url)) {
                            val nested = inline(label)
                            val start = out.length
                            out.append(nested.text)
                            spans.add(MarkdownSpan(start, out.length, MarkdownStyle.LINK))
                            spans.addAll(nested.spans.map { it.copy(start = it.start + start, end = it.end + start) })
                        } else {
                            out.append(label)
                        }
                        index = urlClose + 1
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
                    is MarkdownBlock.Table -> block.header.joinToString(" ") { it.text }
                    MarkdownBlock.Divider -> null
                }
            }
            .filter { it.isNotBlank() }
            .joinToString(" ")
        return if (text.length <= maxChars) text else text.take(maxChars).trimEnd() + "…"
    }
}

fun markdownAnnotated(text: MarkdownText, linkColor: Color): AnnotatedString {
    val builder = AnnotatedString.Builder(text.text)
    for (span in text.spans) {
        if (span.start < 0 || span.end > text.text.length || span.start >= span.end) continue
        val style = when (span.style) {
            MarkdownStyle.BOLD -> SpanStyle(fontWeight = FontWeight.Bold)
            MarkdownStyle.ITALIC -> SpanStyle(fontStyle = FontStyle.Italic)
            MarkdownStyle.CODE -> SpanStyle(fontFamily = FontFamily.Monospace)
            MarkdownStyle.STRIKETHROUGH -> SpanStyle(textDecoration = TextDecoration.LineThrough)
            MarkdownStyle.LINK -> SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline)
        }
        builder.addStyle(style, span.start, span.end)
    }
    return builder.toAnnotatedString()
}

@Composable
fun MarkdownView(
    source: String,
    modifier: Modifier = Modifier,
) {
    val blocks = remember(source) { Markdown.parse(source) }
    Column(modifier = modifier) {
        blocks.forEach { block ->
            MarkdownBlockView(block)
        }
    }
}

@Composable
fun MarkdownBlockView(block: MarkdownBlock) {
    val palette = ZephyrTheme.palette
    when (block) {
        is MarkdownBlock.Heading -> Text(
            text = markdownAnnotated(block.text, palette.brand.accent),
            color = palette.onBackground,
            style = TextStyle(
                fontWeight = FontWeight.Bold,
                fontSize = when (block.level) {
                    1 -> 20.sp
                    2 -> 18.sp
                    3 -> 16.5.sp
                    4 -> 15.5.sp
                    5 -> 14.5.sp
                    else -> 14.sp
                },
                lineHeight = 26.sp,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = if (block.level <= 2) 12.dp else 8.dp, bottom = 4.dp),
        )

        is MarkdownBlock.Paragraph -> Text(
            text = markdownAnnotated(block.text, palette.brand.accent),
            color = palette.onBackground,
            style = TextStyle(fontSize = 14.sp, lineHeight = 22.sp),
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 3.dp),
        )

        is MarkdownBlock.CodeBlock -> Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 6.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(palette.surfaces.elevated)
                .padding(horizontal = 10.dp, vertical = 8.dp),
        ) {
            if (block.language.isNotBlank()) {
                Text(
                    block.language,
                    color = palette.onFloatingSubtle,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(bottom = 4.dp),
                )
            }
            Text(
                block.code,
                color = palette.onBackground,
                fontFamily = FontFamily.Monospace,
                fontSize = 12.5.sp,
                style = TextStyle(lineHeight = 18.sp),
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
            )
        }

        is MarkdownBlock.BulletItem -> MarkdownListRow(
            depth = block.depth,
            marker = "•",
            text = block.text,
        )

        is MarkdownBlock.NumberedItem -> MarkdownListRow(
            depth = block.depth,
            marker = block.number.toString() + ".",
            text = block.text,
        )

        is MarkdownBlock.TaskItem -> MarkdownListRow(
            depth = block.depth,
            marker = if (block.checked) "☑" else "☐",
            text = block.text,
        )

        is MarkdownBlock.Quote -> Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 4.dp),
        ) {
            Box(
                Modifier
                    .width(3.dp)
                    .height(20.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(palette.brand.accent.copy(alpha = 0.7f)),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = markdownAnnotated(block.text, palette.brand.accent),
                color = palette.onFloatingMuted,
                style = TextStyle(fontSize = 13.5.sp, lineHeight = 20.sp),
                modifier = Modifier.weight(1f),
            )
        }

        is MarkdownBlock.Table -> Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 6.dp)
                .clip(RoundedCornerShape(8.dp))
                .border(1.dp, palette.surfaces.outlineSoft, RoundedCornerShape(8.dp))
                .horizontalScroll(rememberScrollState()),
        ) {
            MarkdownTableRow(cells = block.header, alignments = block.alignments, header = true, linkColor = palette.brand.accent)
            block.rows.forEach { row ->
                Box(Modifier.fillMaxWidth().height(1.dp).background(palette.surfaces.outlineSoft))
                MarkdownTableRow(cells = row, alignments = block.alignments, header = false, linkColor = palette.brand.accent)
            }
        }

        MarkdownBlock.Divider -> Box(
            Modifier
                .fillMaxWidth()
                .padding(vertical = 8.dp)
                .height(1.dp)
                .background(palette.surfaces.outlineSoft),
        )
    }
}

@Composable
fun MarkdownTableRow(
    cells: List<MarkdownText>,
    alignments: List<String>,
    header: Boolean,
    linkColor: Color,
) {
    val palette = ZephyrTheme.palette
    Row(
        modifier = Modifier
            .background(if (header) palette.surfaces.elevated else Color.Transparent)
            .padding(horizontal = 8.dp, vertical = 6.dp),
    ) {
        cells.forEachIndexed { index, cell ->
            val align = when (alignments.getOrNull(index)) {
                "center" -> TextAlign.Center
                "right" -> TextAlign.End
                else -> TextAlign.Start
            }
            Text(
                text = markdownAnnotated(cell, linkColor),
                color = palette.onBackground,
                style = TextStyle(
                    fontSize = 13.sp,
                    lineHeight = 18.sp,
                    fontWeight = if (header) FontWeight.SemiBold else FontWeight.Normal,
                    textAlign = align,
                ),
                modifier = Modifier.width(130.dp),
            )
        }
    }
}

@Composable
fun MarkdownListRow(depth: Int, marker: String, text: MarkdownText) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = (depth * 16).dp, top = 2.dp, bottom = 2.dp),
    ) {
        Text(
            marker,
            color = ZephyrTheme.palette.onFloatingMuted,
            fontSize = 14.sp,
            modifier = Modifier.width(20.dp),
        )
        Text(
            text = markdownAnnotated(text, ZephyrTheme.palette.brand.accent),
            color = ZephyrTheme.palette.onBackground,
            style = TextStyle(fontSize = 14.sp, lineHeight = 21.sp),
            modifier = Modifier.weight(1f),
        )
    }
}
