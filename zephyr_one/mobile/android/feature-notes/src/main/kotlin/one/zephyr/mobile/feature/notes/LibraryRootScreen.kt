package one.zephyr.mobile.feature.notes

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Note
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import one.zephyr.mobile.model.Note
import one.zephyr.mobile.model.Snippet
import one.zephyr.mobile.ui.format.RelativeTime
import one.zephyr.mobile.ui.island.islandContentBottomInset
import one.zephyr.mobile.ui.theme.ZephyrRadius
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme

enum class LibrarySection { ALL, FILES, NOTES, SNIPPETS }

data class LibraryRootContent(
    val summary: ResourceHomeSummary,
    val notes: List<Note>,
    val snippets: List<Snippet>,
) {
    fun files(query: String, section: LibrarySection): List<RecentFileRecord> =
        if (section != LibrarySection.ALL && section != LibrarySection.FILES) emptyList()
        else summary.recentFiles.filter { file ->
            query.matchesAny(file.name, file.path, file.connectionLabel)
        }

    fun notes(query: String, section: LibrarySection): List<Note> =
        if (section != LibrarySection.ALL && section != LibrarySection.NOTES) emptyList()
        else notes.filter { note ->
            query.matchesAny(note.title, note.groupPath, note.content, note.tags.joinToString())
        }.sortedByDescending(Note::updatedAt)

    fun snippets(query: String, section: LibrarySection): List<Snippet> =
        if (section != LibrarySection.ALL && section != LibrarySection.SNIPPETS) emptyList()
        else snippets.filter { snippet ->
            query.matchesAny(snippet.name, snippet.group, snippet.command)
        }.sortedByDescending(Snippet::updatedAt)

    fun hasResults(query: String, section: LibrarySection): Boolean =
        files(query, section).isNotEmpty() || notes(query, section).isNotEmpty() || snippets(query, section).isNotEmpty()
}

private fun String.matchesAny(vararg candidates: String): Boolean {
    val needle = trim()
    return needle.isEmpty() || candidates.any { it.contains(needle, ignoreCase = true) }
}

/** S30 root binding. Every navigation action is supplied by the app root. */
@Composable
fun LibraryRootRoute(
    content: LibraryRootContent,
    nowMs: Long,
    onCreateResource: () -> Unit,
    onOpenFiles: () -> Unit,
    onOpenNotes: () -> Unit,
    onOpenSnippets: () -> Unit,
    onOpenDownloads: () -> Unit,
    onOpenRecentFile: (RecentFileRecord) -> Unit,
    onOpenNote: (Note) -> Unit,
    onOpenSnippet: (Snippet) -> Unit,
    modifier: Modifier = Modifier,
) {
    LibraryRootScreen(
        content = content,
        nowMs = nowMs,
        onCreateResource = onCreateResource,
        onOpenFiles = onOpenFiles,
        onOpenNotes = onOpenNotes,
        onOpenSnippets = onOpenSnippets,
        onOpenDownloads = onOpenDownloads,
        onOpenRecentFile = onOpenRecentFile,
        onOpenNote = onOpenNote,
        onOpenSnippet = onOpenSnippet,
        modifier = modifier,
    )
}

@Composable
fun LibraryRootScreen(
    content: LibraryRootContent,
    nowMs: Long,
    onCreateResource: () -> Unit,
    onOpenFiles: () -> Unit,
    onOpenNotes: () -> Unit,
    onOpenSnippets: () -> Unit,
    onOpenDownloads: () -> Unit,
    onOpenRecentFile: (RecentFileRecord) -> Unit,
    onOpenNote: (Note) -> Unit,
    onOpenSnippet: (Snippet) -> Unit,
    modifier: Modifier = Modifier,
) {
    var query by rememberSaveable { mutableStateOf("") }
    var sectionName by rememberSaveable { mutableStateOf(LibrarySection.ALL.name) }
    val section = remember(sectionName) { LibrarySection.valueOf(sectionName) }
    val files = remember(content, query, section) { content.files(query, section) }
    val notes = remember(content, query, section) { content.notes(query, section) }
    val snippets = remember(content, query, section) { content.snippets(query, section) }
    val palette = ZephyrTheme.palette

    Column(modifier.fillMaxSize().padding(horizontal = ZephyrSpacing.lg)) {
        RootHeader(stringResource(R.string.library_title), stringResource(R.string.library_create), onCreateResource)
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(bottom = islandContentBottomInset()),
            verticalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm),
        ) {
            item("entry-grid") {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        LibraryEntryCard(
                            title = stringResource(R.string.library_files),
                            detail = stringResource(R.string.library_files_detail, content.summary.recentFiles.size),
                            icon = Icons.Filled.Folder,
                            tint = Color(0xFF64D2FF),
                            onClick = onOpenFiles,
                            modifier = Modifier.weight(1f),
                        )
                        LibraryEntryCard(
                            title = stringResource(R.string.library_notes),
                            detail = stringResource(R.string.library_notes_detail, content.summary.noteCount),
                            icon = Icons.Filled.Note,
                            tint = palette.status.warning,
                            onClick = onOpenNotes,
                            modifier = Modifier.weight(1f),
                        )
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        LibraryEntryCard(
                            title = stringResource(R.string.library_snippets),
                            detail = stringResource(R.string.library_snippets_detail, content.summary.snippetCount),
                            icon = Icons.Filled.Code,
                            tint = palette.protocol.ssh,
                            onClick = onOpenSnippets,
                            modifier = Modifier.weight(1f),
                        )
                        LibraryEntryCard(
                            title = stringResource(R.string.library_downloads),
                            detail = stringResource(R.string.library_downloads_detail, content.summary.activeDownloadCount),
                            icon = Icons.Filled.Download,
                            tint = palette.protocol.vnc,
                            onClick = onOpenDownloads,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
            item("search") { LibrarySearch(query, { query = it }) }
            item("filters") {
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm),
                ) {
                    LibrarySection.entries.forEach { value ->
                        FilterPill(value, selected = value == section) { sectionName = value.name }
                    }
                }
            }
            if (!content.hasResults(query, section)) {
                item("empty") {
                    Text(
                        stringResource(R.string.library_no_results),
                        color = palette.onFloatingMuted,
                        modifier = Modifier.fillMaxWidth().padding(vertical = ZephyrSpacing.xl),
                    )
                }
            }
            if (files.isNotEmpty()) {
                item("files-title") { RootSectionTitle(stringResource(R.string.library_recent_files)) }
                item("files-group") {
                    RowGroup {
                        files.forEachIndexed { index, file ->
                            RootRow(
                                title = file.name,
                                detail = listOf(RemotePath.parentOf(file.path), file.connectionLabel, RelativeTime.format(nowMs, file.touchedAt))
                                    .filter(String::isNotBlank).joinToString(" · "),
                                icon = if (file.origin == RecentFileOrigin.DOWNLOADED) Icons.Filled.Download else Icons.Filled.Folder,
                                tint = Color(0xFF64D2FF),
                                mono = true,
                                showDivider = index != files.lastIndex,
                                onClick = { onOpenRecentFile(file) },
                            )
                        }
                    }
                }
            }
            if (notes.isNotEmpty()) {
                item("notes-title") { RootSectionTitle(stringResource(R.string.library_recent_notes)) }
                item("notes-group") {
                    RowGroup {
                        notes.forEachIndexed { index, note ->
                            RootRow(
                                title = note.title.ifBlank { stringResource(R.string.library_untitled_note) },
                                detail = listOf(note.groupPath, RelativeTime.format(nowMs, note.updatedAt)).filter(String::isNotBlank).joinToString(" · "),
                                icon = Icons.Filled.Note,
                                tint = palette.status.warning,
                                showDivider = index != notes.lastIndex,
                                onClick = { onOpenNote(note) },
                            )
                        }
                    }
                }
            }
            if (snippets.isNotEmpty()) {
                item("snippets-title") { RootSectionTitle(stringResource(R.string.library_recent_snippets)) }
                item("snippets-group") {
                    RowGroup {
                        snippets.forEachIndexed { index, snippet ->
                            RootRow(
                                title = snippet.name,
                                detail = listOf(snippet.group, snippet.command.lineSequence().firstOrNull().orEmpty())
                                    .filter(String::isNotBlank).joinToString(" · "),
                                icon = Icons.Filled.Code,
                                tint = palette.protocol.ssh,
                                mono = true,
                                showDivider = index != snippets.lastIndex,
                                onClick = { onOpenSnippet(snippet) },
                            )
                        }
                    }
                }
            }
            item("privacy") {
                Text(
                    stringResource(R.string.library_metadata_notice),
                    color = palette.onFloatingMuted,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(horizontal = ZephyrSpacing.xs, vertical = ZephyrSpacing.sm),
                )
            }
        }
    }
}

@Composable
private fun RootHeader(title: String, actionDescription: String, onAction: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 62.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, fontSize = 23.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f).semantics { heading() })
        Surface(shape = CircleShape, color = ZephyrTheme.palette.surfaces.elevated) {
            IconButton(onClick = onAction, modifier = Modifier.size(38.dp)) {
                Icon(Icons.Filled.Add, contentDescription = actionDescription, tint = ZephyrTheme.palette.brand.accent)
            }
        }
    }
}

@Composable
private fun LibraryEntryCard(
    title: String,
    detail: String,
    icon: ImageVector,
    tint: Color,
    onClick: () -> Unit,
    modifier: Modifier,
) {
    Surface(
        modifier = modifier.heightIn(min = 72.dp).clickable(onClick = onClick),
        color = ZephyrTheme.palette.surfaces.content,
        shape = RoundedCornerShape(ZephyrRadius.md),
        border = BorderStroke(1.dp, ZephyrTheme.palette.surfaces.outline.copy(alpha = .35f)),
    ) {
        Row(Modifier.padding(ZephyrSpacing.md), verticalAlignment = Alignment.CenterVertically) {
            Surface(shape = RoundedCornerShape(10.dp), color = tint.copy(alpha = .15f)) {
                Box(Modifier.size(38.dp), contentAlignment = Alignment.Center) {
                    Icon(icon, null, tint = tint, modifier = Modifier.size(20.dp))
                }
            }
            Spacer(Modifier.width(ZephyrSpacing.md))
            Column(Modifier.weight(1f)) {
                Text(title, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 2)
                Text(detail, fontSize = 11.5.sp, color = ZephyrTheme.palette.onFloatingMuted, maxLines = 2)
            }
        }
    }
}

@Composable
private fun LibrarySearch(value: String, onValueChange: (String) -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth().padding(top = ZephyrSpacing.sm),
        color = ZephyrTheme.palette.surfaces.elevated,
        shape = RoundedCornerShape(10.dp),
    ) {
        Row(Modifier.heightIn(min = 40.dp).padding(horizontal = ZephyrSpacing.md), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Search, null, tint = ZephyrTheme.palette.onFloatingMuted, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(ZephyrSpacing.sm))
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier.weight(1f),
                singleLine = true,
                textStyle = androidx.compose.ui.text.TextStyle(color = ZephyrTheme.palette.onBackground, fontSize = 13.5.sp),
                decorationBox = { inner ->
                    Box {
                        if (value.isEmpty()) Text(stringResource(R.string.library_search_hint), color = ZephyrTheme.palette.onFloatingMuted, fontSize = 13.5.sp)
                        inner()
                    }
                },
            )
        }
    }
}

@Composable
private fun FilterPill(section: LibrarySection, selected: Boolean, onClick: () -> Unit) {
    val label = when (section) {
        LibrarySection.ALL -> stringResource(R.string.library_filter_all)
        LibrarySection.FILES -> stringResource(R.string.library_files)
        LibrarySection.NOTES -> stringResource(R.string.library_notes)
        LibrarySection.SNIPPETS -> stringResource(R.string.library_snippets)
    }
    Surface(
        modifier = Modifier.heightIn(min = 36.dp).clickable(onClick = onClick),
        color = if (selected) ZephyrTheme.palette.brand.accent else ZephyrTheme.palette.surfaces.elevated,
        contentColor = if (selected) Color.White else ZephyrTheme.palette.onFloatingMuted,
        shape = RoundedCornerShape(18.dp),
    ) { Box(Modifier.padding(horizontal = 13.dp, vertical = 8.dp), contentAlignment = Alignment.Center) { Text(label, fontSize = 12.5.sp) } }
}

@Composable
private fun RootSectionTitle(title: String) {
    Text(
        title.uppercase(),
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        color = ZephyrTheme.palette.onFloatingMuted,
        modifier = Modifier.padding(start = ZephyrSpacing.xs, top = ZephyrSpacing.md, bottom = 2.dp).semantics { heading() },
    )
}

@Composable
private fun RowGroup(content: @Composable () -> Unit) {
    Surface(
        color = ZephyrTheme.palette.surfaces.content,
        shape = RoundedCornerShape(ZephyrRadius.md),
        border = BorderStroke(1.dp, ZephyrTheme.palette.surfaces.outline.copy(alpha = .35f)),
    ) { Column { content() } }
}

@Composable
private fun RootRow(
    title: String,
    detail: String,
    icon: ImageVector,
    tint: Color,
    showDivider: Boolean,
    onClick: () -> Unit,
    mono: Boolean = false,
) {
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 58.dp).clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(shape = RoundedCornerShape(8.dp), color = ZephyrTheme.palette.surfaces.elevated) {
                Box(Modifier.size(30.dp), contentAlignment = Alignment.Center) { Icon(icon, null, tint = tint, modifier = Modifier.size(17.dp)) }
            }
            Spacer(Modifier.width(ZephyrSpacing.md))
            Column(Modifier.weight(1f)) {
                Text(
                    title,
                    fontSize = 14.sp,
                    fontFamily = if (mono) androidx.compose.ui.text.font.FontFamily.Monospace else null,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (detail.isNotBlank()) Text(detail, fontSize = 11.5.sp, color = ZephyrTheme.palette.onFloatingMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        if (showDivider) HorizontalDivider(Modifier.padding(start = 56.dp), color = ZephyrTheme.palette.surfaces.outline.copy(alpha = .35f))
    }
}
