package one.zephyr.mobile.app

import one.zephyr.mobile.feature.notes.RecentFileOrigin
import one.zephyr.mobile.feature.notes.RecentFileRecord
import one.zephyr.mobile.feature.tools.ToolEntry
import one.zephyr.mobile.model.Note
import one.zephyr.mobile.model.Snippet
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DestinationRoutesTest {

    @Test
    fun `every tool row opens a named page instead of a missing-host notice`() {
        val routes = ToolEntry.entries.map(DestinationRoutes::tool)
        assertEquals(ToolEntry.entries.size, routes.size)
        assertTrue(routes.all { it.isNotBlank() })
        assertFalse(routes.any { it.contains("尚未接入") })
    }

    @Test
    fun `library actions land on demo pages`() {
        assertEquals("notes", DestinationRoutes.library(LibraryAction.Notes))
        assertEquals("snippets", DestinationRoutes.library(LibraryAction.Snippets))
        assertEquals("files", DestinationRoutes.library(LibraryAction.Files))
        assertEquals("downloads", DestinationRoutes.library(LibraryAction.Downloads))
        assertEquals("library-create", DestinationRoutes.library(LibraryAction.Create))
        assertEquals("note-editor", DestinationRoutes.library(LibraryAction.CreateNote))
        assertEquals("snippet-editor", DestinationRoutes.library(LibraryAction.CreateSnippet))
        assertEquals(
            "notes",
            DestinationRoutes.library(LibraryAction.OpenNote(Note(noteId = "n", ownerUserId = "u", title = "t"))),
        )
        assertEquals(
            "snippets",
            DestinationRoutes.library(LibraryAction.OpenSnippet(Snippet(id = "s", ownerUserId = "u", name = "n", command = "ls"))),
        )
        assertEquals(
            "files",
            DestinationRoutes.library(
                LibraryAction.RecentFile(
                    RecentFileRecord("c", "prod", "/a", "a", 1, 1, 1, RecentFileOrigin.BROWSED),
                ),
            ),
        )
    }

    @Test
    fun `demo page inventory is still covered`() {
        val live = DestinationRoutes.demoPages.toSet()
        assertTrue("home" in live)
        assertTrue("protocol" in live)
        assertTrue("appearance" in live)
        assertTrue("file-sync" in live)
        assertTrue(live.any { it.startsWith("ops:") })
        assertTrue(live.any { it.startsWith("resource:") })
    }
}
