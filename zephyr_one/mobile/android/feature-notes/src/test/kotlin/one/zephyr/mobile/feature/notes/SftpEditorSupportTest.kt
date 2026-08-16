package one.zephyr.mobile.feature.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SftpEditorSupportTest {

    @Test
    fun languageAndOutlineComeFromThePathAndText() {
        assertEquals("Kotlin", SftpEditorSupport.languageOf("/src/Main.kt"))
        val items = SftpEditorSupport.outline(
            """
            class Host {
              fun start() {}
              private fun stop() {}
            }
            """.trimIndent(),
            "Host.kt",
        )
        assertTrue(items.any { it.name == "Host" })
        assertTrue(items.any { it.name == "start" })
    }

    @Test
    fun findIsCaseInsensitiveAndBounded() {
        val hits = SftpEditorSupport.findInText("Alpha\nalpha\nBETA", "alp")
        assertEquals(2, hits.size)
        assertEquals(1, hits.first().line)
    }

    @Test
    fun formatIndentsBracesWithoutInventingCode() {
        val formatted = SftpEditorSupport.formatDocument("fun x(){\nval a=1\n}", tabSize = 4)
        assertEquals("fun x(){\n    val a=1\n}", formatted)
    }

    @Test
    fun workspaceHitsParseJsonObjects() {
        val raw = """{"hits":[{"path":"/var/a.conf","line":12,"text":"worker_processes auto;"},{"path":"/var/b.conf","line":3,"text":"listen 80;"}],"filesScanned":4}"""
        val (hits, scanned) = SftpEditorSupport.parseWorkspaceHits(raw)
        assertEquals(4, scanned)
        assertEquals(2, hits.size)
        assertEquals("/var/a.conf", hits[0].path)
        assertEquals(12, hits[0].line)
    }

    @Test
    fun bundleCommandRefusesEmptyAndQuotesPaths() {
        val command = SftpTransferOps.bundleCommand(listOf("/var/log", "/etc/nginx"), "/tmp/a.tar.gz")
        assertTrue(command.startsWith("tar -czf '/tmp/a.tar.gz'"))
        assertTrue(command.contains("'/var/log'"))
        try {
            SftpTransferOps.bundleCommand(emptyList(), "/tmp/a.tar.gz")
            throw AssertionError("empty bundle accepted")
        } catch (_: IllegalArgumentException) {
        }
    }
}
