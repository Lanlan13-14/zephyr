package one.zephyr.mobile.ui.component

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownViewTest {

    @Test
    fun parseHeadingsAndParagraphs() {
        val src = """
            # Title
            ## Subtitle
            Here is a paragraph with **bold** and `code`.
        """.trimIndent()
        val blocks = Markdown.parse(src)
        assertEquals(3, blocks.size)
        assertTrue(blocks[0] is MarkdownBlock.Heading)
        assertEquals(1, (blocks[0] as MarkdownBlock.Heading).level)
        assertEquals("Title", (blocks[0] as MarkdownBlock.Heading).text.text)

        assertTrue(blocks[1] is MarkdownBlock.Heading)
        assertEquals(2, (blocks[1] as MarkdownBlock.Heading).level)
        assertEquals("Subtitle", (blocks[1] as MarkdownBlock.Heading).text.text)

        assertTrue(blocks[2] is MarkdownBlock.Paragraph)
        val p = blocks[2] as MarkdownBlock.Paragraph
        assertEquals("Here is a paragraph with bold and code.", p.text.text)
        assertEquals(2, p.text.spans.size)
        assertEquals(MarkdownStyle.BOLD, p.text.spans[0].style)
        assertEquals(MarkdownStyle.CODE, p.text.spans[1].style)
    }

    @Test
    fun parseFencedCodeBlock() {
        val src = """
            ```kotlin
            fun main() {
                println("Hello")
            }
            ```
        """.trimIndent()
        val blocks = Markdown.parse(src)
        assertEquals(1, blocks.size)
        assertTrue(blocks[0] is MarkdownBlock.CodeBlock)
        val cb = blocks[0] as MarkdownBlock.CodeBlock
        assertEquals("kotlin", cb.language)
        assertTrue(cb.code.contains("println(\"Hello\")"))
    }

    @Test
    fun parseGfmTable() {
        val src = """
            | Name | Role | Status |
            | :--- | :--: | ----: |
            | Alice | Admin | Active |
            | Bob | User | Pending |
        """.trimIndent()
        val blocks = Markdown.parse(src)
        assertEquals(1, blocks.size)
        assertTrue(blocks[0] is MarkdownBlock.Table)
        val table = blocks[0] as MarkdownBlock.Table
        assertEquals(3, table.header.size)
        assertEquals(listOf("left", "center", "right"), table.alignments)
        assertEquals(2, table.rows.size)
        assertEquals("Alice", table.rows[0][0].text)
        assertEquals("Pending", table.rows[1][2].text)
    }

    @Test
    fun parseTaskItemsAndBullets() {
        val src = """
            - [x] Task done
            - [ ] Task pending
            - Bullet item
            1. Numbered item
        """.trimIndent()
        val blocks = Markdown.parse(src)
        assertEquals(4, blocks.size)
        assertTrue(blocks[0] is MarkdownBlock.TaskItem)
        assertTrue((blocks[0] as MarkdownBlock.TaskItem).checked)
        assertEquals("Task done", (blocks[0] as MarkdownBlock.TaskItem).text.text)

        assertTrue(blocks[1] is MarkdownBlock.TaskItem)
        assertFalse((blocks[1] as MarkdownBlock.TaskItem).checked)

        assertTrue(blocks[2] is MarkdownBlock.BulletItem)
        assertEquals("Bullet item", (blocks[2] as MarkdownBlock.BulletItem).text.text)

        assertTrue(blocks[3] is MarkdownBlock.NumberedItem)
        assertEquals(1, (blocks[3] as MarkdownBlock.NumberedItem).number)
        assertEquals("Numbered item", (blocks[3] as MarkdownBlock.NumberedItem).text.text)
    }

    @Test
    fun parseQuoteAndDivider() {
        val src = """
            > This is a quote block
            ---
        """.trimIndent()
        val blocks = Markdown.parse(src)
        assertEquals(2, blocks.size)
        assertTrue(blocks[0] is MarkdownBlock.Quote)
        assertEquals("This is a quote block", (blocks[0] as MarkdownBlock.Quote).text.text)
        assertTrue(blocks[1] is MarkdownBlock.Divider)
    }

    @Test
    fun inlineStylesAndLinkSafety() {
        val text = "Check [Safe](https://example.com) and [Unsafe](javascript:alert(1)) and ~~deleted~~"
        val parsed = Markdown.inline(text)
        assertEquals("Check Safe and Unsafe and deleted", parsed.text)
        val linkSpans = parsed.spans.filter { it.style == MarkdownStyle.LINK }
        assertEquals(1, linkSpans.size) // javascript: 被过滤，只有 https: 作为 LINK
        val strikeSpans = parsed.spans.filter { it.style == MarkdownStyle.STRIKETHROUGH }
        assertEquals(1, strikeSpans.size)
    }

    @Test
    fun plainSummaryExtractsCleanText() {
        val src = """
            # Header
            This is **bold** and `code` in paragraph.
        """.trimIndent()
        val summary = Markdown.plainSummary(src)
        assertEquals("Header This is bold and code in paragraph.", summary)
    }
}
