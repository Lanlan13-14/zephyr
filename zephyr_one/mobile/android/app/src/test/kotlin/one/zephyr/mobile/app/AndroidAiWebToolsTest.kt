package one.zephyr.mobile.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidAiWebToolsTest {

    @Test
    fun `parses duckduckgo result anchors and unwraps uddg`() {
        val html = """
            <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example Docs</a>
            <a class="result__snippet">Official documentation</a>
        """.trimIndent()

        val hits = AndroidAiWebTools.parseDuckDuckGo(html, 6)

        assertEquals(1, hits.size)
        assertEquals("Example Docs", hits[0].title)
        assertEquals("https://example.com/docs", hits[0].url)
        assertEquals("Official documentation", hits[0].snippet)
    }

    @Test
    fun `falls back to generic http anchors when result class is missing`() {
        val html = """<a href="https://zephyr.example/ai">Zephyr AI</a>"""

        val hits = AndroidAiWebTools.parseDuckDuckGo(html, 3)

        assertEquals(1, hits.size)
        assertEquals("Zephyr AI", hits[0].title)
        assertEquals("https://zephyr.example/ai", hits[0].url)
    }

    @Test
    fun `stripHtml drops tags and collapses whitespace`() {
        val text = AndroidAiWebTools.stripHtml("<html><script>alert(1)</script><p>Hello&nbsp;<b>AI</b></p></html>")
        assertEquals("Hello AI", text)
        assertTrue(text.none { it == '<' })
    }
}
