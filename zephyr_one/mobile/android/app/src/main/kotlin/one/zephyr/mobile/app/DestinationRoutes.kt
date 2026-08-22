package one.zephyr.mobile.app

import one.zephyr.mobile.feature.tools.OneSettingsAnchor
import one.zephyr.mobile.feature.tools.OpsSection
import one.zephyr.mobile.feature.tools.ResourceKind
import one.zephyr.mobile.feature.tools.ToolEntry

/**
 * The destination a tools / library row must open.
 *
 * Kept as a table rather than inline in the composable so a test can prove every demo page has a
 * real route and none of them still collapse to a "尚未接入" snackbar.
 */
object DestinationRoutes {

    fun tool(entry: ToolEntry): String = when (entry) {
        ToolEntry.BATCH_EXEC -> "batch"
        ToolEntry.DOCKER -> "ops:" + OpsSection.DOCKER.name
        ToolEntry.MONITOR -> "ops:" + OpsSection.METRICS.name
        ToolEntry.LOGS -> "ops:" + OpsSection.LOGS.name
        ToolEntry.PROXY -> "resource:" + ResourceKind.PROXY.name
        ToolEntry.SSH_KEY -> "resource:" + ResourceKind.SSH_KEY.name
        ToolEntry.JUMP_HOST -> "resource:" + ResourceKind.JUMP_HOST.name
        ToolEntry.AI_WORKSPACE -> "ai"
        ToolEntry.FILE_SYNC -> "file-sync"
        ToolEntry.SERVER_SETTINGS -> "server-settings"
        ToolEntry.BACKUP_RESTORE -> "backup"
        ToolEntry.RUNTIME_STATUS -> "runtime"
        ToolEntry.APPEARANCE -> "one:" + OneSettingsAnchor.APPEARANCE.name
        ToolEntry.LANGUAGE -> "one:" + OneSettingsAnchor.LANGUAGE.name
        ToolEntry.APP_LOCK -> "one:" + OneSettingsAnchor.APP_LOCK.name
        ToolEntry.NETWORK -> "one:" + OneSettingsAnchor.NETWORK.name
        ToolEntry.DIAGNOSTICS -> "one:" + OneSettingsAnchor.DIAGNOSTICS.name
    }

    fun library(action: LibraryAction): String = when (action) {
        LibraryAction.Create -> "library-create"
        LibraryAction.CreateNote -> "note-editor"
        LibraryAction.CreateSnippet -> "snippet-editor"
        LibraryAction.Files, is LibraryAction.RecentFile -> "files"
        LibraryAction.Notes, is LibraryAction.OpenNote -> "notes"
        LibraryAction.Snippets, is LibraryAction.OpenSnippet -> "snippets"
        LibraryAction.Downloads -> "downloads"
    }

    val demoPages: List<String> = listOf(
        "home", "sessions", "library", "tools",
        "editor", "protocol", "note", "snippet",
        "terminal", "rdp", "vnc",
        "file-sync", "backup", "ai", "appearance",
        "language", "batch", "ops:" + OpsSection.DOCKER.name,
        "files", "notes", "snippets",
        "resource:" + ResourceKind.PROXY.name,
        "resource:" + ResourceKind.SSH_KEY.name,
        "server-settings", "runtime",
        "conflicts", "devices", "shares", "binding",
    )
}
