package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.model.Note
import one.zephyr.mobile.model.Snippet
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LibraryRootContentTest {

    private val file = RecentFileRecord(
        connectionId = "c1",
        connectionLabel = "prod",
        path = "/etc/nginx/nginx.conf",
        name = "nginx.conf",
        sizeBytes = 100,
        mtimeMs = 1,
        touchedAt = 30,
        origin = RecentFileOrigin.BROWSED,
    )
    private val note = Note(noteId = "n1", ownerUserId = "u", title = "Runbook", content = "restart nginx", updatedAt = 20)
    private val snippet = Snippet(id = "s1", ownerUserId = "u", name = "Disk usage", command = "du -x", group = "ops", updatedAt = 10)
    private val content = LibraryRootContent(
        summary = ResourceHomeSummary(1, 1, 0, 0, listOf(file)),
        notes = listOf(note),
        snippets = listOf(snippet),
    )

    @Test
    fun `search covers paths note bodies and snippet commands`() {
        assertEquals(listOf(file), content.files("/etc/nginx", LibrarySection.ALL))
        assertEquals(listOf(note), content.notes("restart", LibrarySection.ALL))
        assertEquals(listOf(snippet), content.snippets("du -x", LibrarySection.ALL))
    }

    @Test
    fun `section filter excludes other resource kinds`() {
        assertTrue(content.files("", LibrarySection.FILES).isNotEmpty())
        assertTrue(content.notes("", LibrarySection.FILES).isEmpty())
        assertTrue(content.snippets("", LibrarySection.FILES).isEmpty())
        assertFalse(content.hasResults("missing", LibrarySection.ALL))
    }
}
