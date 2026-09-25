package one.zephyr.mobile.feature.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SftpEditorSupportTest {

    @Test
    fun `broken json reports the parser message`() {
        val problems = SftpEditorSupport.diagnostics("{", "config.json")
        assertEquals(1, problems.size)
        assertTrue(problems.single().message.isNotBlank())
    }

    @Test
    fun `valid json and other languages stay clean`() {
        assertTrue(SftpEditorSupport.diagnostics("""{"ok":true}""", "config.json").isEmpty())
        assertTrue(SftpEditorSupport.diagnostics("this is not json", "notes.txt").isEmpty())
    }

    @Test
    fun `replace keeps case insensitive matches and ignores a blank query`() {
        assertEquals("b-b", SftpEditorSupport.replaceAll("A-a", "a", "b"))
        assertEquals("A-a", SftpEditorSupport.replaceAll("A-a", "   ", "b"))
    }

    @Test
    fun `trim drops trailing spaces but keeps the line break`() {
        assertEquals("a\nb", SftpEditorSupport.trimTrailingWhitespace("a  \nb\t"))
    }
}
