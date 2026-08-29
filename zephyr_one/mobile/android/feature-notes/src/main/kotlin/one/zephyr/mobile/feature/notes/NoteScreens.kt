package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.ui.icon.ZephyrIcons

import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import one.zephyr.mobile.ui.component.AlertDialog
import one.zephyr.mobile.ui.component.DropdownMenu
import one.zephyr.mobile.ui.component.DropdownMenuItem
import one.zephyr.mobile.ui.component.FilterChip
import one.zephyr.mobile.ui.component.GroupCard
import one.zephyr.mobile.ui.component.Icon
import one.zephyr.mobile.ui.component.OutlinedTextField
import one.zephyr.mobile.ui.component.PrimaryButton
import one.zephyr.mobile.ui.component.SettingsRow
import one.zephyr.mobile.ui.component.Surface
import one.zephyr.mobile.ui.component.Switch
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.component.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
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
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.launch
import one.zephyr.mobile.data.repository.NoteRepository
import one.zephyr.mobile.model.Note
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.SyncState
import one.zephyr.mobile.ui.chrome.HeaderAddButton
import one.zephyr.mobile.ui.chrome.PushedPageActionBar
import one.zephyr.mobile.ui.chrome.PushedPageHeader
import one.zephyr.mobile.ui.format.RelativeTime
import one.zephyr.mobile.ui.state.PageStateScaffold
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme
import one.zephyr.mobile.ui.theme.ZephyrRadius
import java.util.UUID

class NoteListViewModel(
    private val notes: NoteRepository,
    private val ownerUserId: String,
    private val online: Boolean,
    private val bound: Boolean,
    private val lastSyncedAt: Long?,
) : ViewModel() {
    private val filterState = MutableStateFlow(NoteFilter())
    val filter: StateFlow<NoteFilter> = filterState.asStateFlow()

    private val page = MutableStateFlow<PageState<NoteListContent>>(PageState.InitialLoading)
    val state: StateFlow<PageState<NoteListContent>> = page.asStateFlow()

    init {
        viewModelScope.launch {
            combine(
                notes.observeNotes(ownerUserId),
                notes.observeTrashedNotes(ownerUserId),
                filterState,
            ) { active, trashed, filter ->
                NoteListStates.derive(
                    notes = active,
                    trashed = trashed,
                    filter = filter,
                    loaded = true,
                    online = online,
                    bound = bound,
                    lastSyncedAt = lastSyncedAt,
                )
            }.flowOn(Dispatchers.Default).collect { page.value = it }
        }
    }

    fun setQuery(value: String) { filterState.value = filterState.value.copy(query = value) }
    fun setScope(scope: NoteScope) {
        // Trash is a different pool, not a filter on the current group. Leaving 运维/清单 selected
        // when the user taps 回收站 hides every trashed note that is not in that group — the list
        // "disappears" and the empty-filter placeholder replaces it. Clear group/tag facets on
        // the trash transition so the trash always shows every recoverable row.
        filterState.value = if (scope == NoteScope.TRASH) {
            filterState.value.copy(scope = scope, groupPath = "", tags = emptySet())
        } else {
            filterState.value.copy(scope = scope)
        }
    }

    fun purge(note: Note) {
        viewModelScope.launch { runCatching { notes.purgeNote(note, ownerUserId) } }
    }
    fun setGroupPath(groupPath: String) { filterState.value = filterState.value.copy(groupPath = groupPath, tags = emptySet()) }
    fun toggleTag(tag: String) { filterState.value = filterState.value.withTagToggled(tag) }
    fun setGroup(path: String) { filterState.value = filterState.value.copy(groupPath = path) }

    fun trash(note: Note) {
        viewModelScope.launch { runCatching { notes.trashNote(note, ownerUserId) } }
    }

    fun restore(note: Note) {
        viewModelScope.launch { runCatching { notes.restoreNote(note, ownerUserId) } }
    }

    companion object {
        fun factory(
            notes: NoteRepository,
            ownerUserId: String,
            online: Boolean,
            bound: Boolean,
            lastSyncedAt: Long?,
        ): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                NoteListViewModel(notes, ownerUserId, online, bound, lastSyncedAt) as T
        }
    }
}

class NoteEditorViewModel(
    private val notes: NoteRepository,
    private val ownerUserId: String,
    private val noteId: String?,
    private val newIdFactory: () -> String,
) : ViewModel() {
    private val draftState = MutableStateFlow<NoteDraft?>(null)
    val draft: StateFlow<NoteDraft?> = draftState.asStateFlow()
    private val messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val message: SharedFlow<String> = messages
    private val done = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val finished: SharedFlow<Unit> = done

    init {
        viewModelScope.launch {
            if (noteId == null) {
                draftState.value = NoteDraft.create(ownerUserId, newIdFactory())
                return@launch
            }
            notes.observeNote(noteId).collect { note ->
                if (note == null) {
                    draftState.value = null
                } else if (draftState.value == null || draftState.value?.isDirty != true) {
                    draftState.value = NoteDraft.edit(note)
                }
            }
        }
    }

    fun edit(block: (NoteDraft) -> NoteDraft) {
        draftState.value = draftState.value?.let(block)
    }

    fun save() {
        val current = draftState.value ?: return
        if (!current.canSave) {
            viewModelScope.launch { messages.emit(issueText(current.validate().firstOrNull())) }
            return
        }
        viewModelScope.launch {
            runCatching {
                notes.saveNote(
                    note = current.normalized().copy(updatedAt = System.currentTimeMillis()),
                    mask = current.changedFields(),
                    ownerUserId = ownerUserId,
                    createdLocally = current.isCreate,
                )
            }.onSuccess {
                messages.emit("已保存，待同步")
                done.emit(Unit)
            }.onFailure { messages.emit(it.message ?: "保存未完成") }
        }
    }

    companion object {
        fun factory(
            notes: NoteRepository,
            ownerUserId: String,
            noteId: String?,
            newIdFactory: () -> String = { UUID.randomUUID().toString() },
        ): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                NoteEditorViewModel(notes, ownerUserId, noteId, newIdFactory) as T
        }
    }
}

private fun issueText(issue: NoteIssue?): String = when (issue?.code) {
    NoteIssueCode.TITLE_REQUIRED -> "请输入标题"
    NoteIssueCode.TITLE_TOO_LONG -> "标题不能超过 200 字"
    NoteIssueCode.CONTENT_TOO_LARGE -> "正文超过 1 MiB"
    NoteIssueCode.TOO_MANY_TAGS -> "标签最多 100 个"
    NoteIssueCode.TOO_MANY_LINKS -> "关联连接最多 100 个"
    null -> "无法保存"
}

@Composable
fun NoteListRoute(
    viewModel: NoteListViewModel,
    nowMs: Long,
    onBack: () -> Unit,
    onOpen: (Note) -> Unit,
    onCreate: () -> Unit,
) {
    val state by viewModel.state.collectAsState()
    val filter by viewModel.filter.collectAsState()
    var pendingTrash by remember { mutableStateOf<Note?>(null) }
    var pendingRestore by remember { mutableStateOf<Note?>(null) }
    var pendingPurge by remember { mutableStateOf<Note?>(null) }

    Box(Modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = stringResource(R.string.notes_title), onBack = onBack) {
            HeaderAddButton(stringResource(R.string.notes_create), onCreate)
        }
        // The scope/filter row lives OUTSIDE PageStateScaffold. When the list is empty the scaffold
        // renders only the empty placeholder and never calls its content lambda, which used to hide
        // the 回收站 chip exactly when the user wanted to open the trash. Keep the chips always visible.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(start = 16.dp, end = 16.dp, bottom = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            FilterChip(
                selected = filter.scope == NoteScope.ACTIVE && filter.groupPath.isEmpty(),
                onClick = {
                    viewModel.setScope(NoteScope.ACTIVE)
                    viewModel.setGroupPath("")
                },
                label = { Text("全部") },
            )
            listOf("运维", "清单").forEach { group ->
                FilterChip(
                    selected = filter.scope == NoteScope.ACTIVE && filter.groupPath == group,
                    onClick = {
                        viewModel.setScope(NoteScope.ACTIVE)
                        viewModel.setGroupPath(group)
                    },
                    label = { Text(group) },
                )
            }
            FilterChip(
                selected = filter.scope == NoteScope.TRASH,
                onClick = { viewModel.setScope(NoteScope.TRASH) },
                label = { Text("回收站") },
            )
        }
        PageStateScaffold(state = state, modifier = Modifier.fillMaxSize()) { content ->
            Column(Modifier.fillMaxSize()) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 2.dp, bottom = 140.dp),
                ) {
                    item("notes") {
                        GroupCard {
                            val inTrash = filter.scope == NoteScope.TRASH
                            content.notes.forEachIndexed { index, note ->
                                var rowMenu by remember(note.noteId) { mutableStateOf(false) }
                                SettingsRow(
                                    title = note.title.ifBlank { stringResource(R.string.library_untitled_note) },
                                    subtitle = buildList {
                                        if (note.groupPath.isNotBlank()) add(note.groupPath)
                                        if (note.linkedConnectionIds.isNotEmpty()) add("关联连接")
                                        add(RelativeTime.format(nowMs, note.updatedAt))
                                        if (note.aiReadEnabled || note.aiWriteEnabled) add("AI 可读写")
                                    }.joinToString(" · "),
                                    showDivider = index != content.notes.lastIndex,
                                    onClick = { onOpen(note) },
                                    leading = { NoteIcon(note.syncState == SyncState.PENDING_LOCAL) },
                                    trailing = {
                                        Row(
                                            verticalAlignment = Alignment.CenterVertically,
                                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                                        ) {
                                            if (note.syncState == SyncState.PENDING_LOCAL) PendingBadge()
                                            Box {
                                                Text(
                                                    "⋮",
                                                    color = ZephyrTheme.palette.onFloatingSubtle,
                                                    fontSize = 17.sp,
                                                    modifier = Modifier
                                                        .clip(androidx.compose.foundation.shape.RoundedCornerShape(8.dp))
                                                        .clickable { rowMenu = true }
                                                        .padding(horizontal = 8.dp, vertical = 4.dp),
                                                )
                                                DropdownMenu(expanded = rowMenu, onDismissRequest = { rowMenu = false }) {
                                                    if (!inTrash) {
                                                        DropdownMenuItem(
                                                            text = { Text("打开") },
                                                            onClick = {
                                                                rowMenu = false
                                                                onOpen(note)
                                                            },
                                                        )
                                                        if (note.capabilities.canDelete) {
                                                            DropdownMenuItem(
                                                                text = {
                                                                    Text(
                                                                        stringResource(R.string.notes_trash),
                                                                        color = ZephyrTheme.palette.status.error,
                                                                    )
                                                                },
                                                                onClick = {
                                                                    rowMenu = false
                                                                    pendingTrash = note
                                                                },
                                                            )
                                                        }
                                                    } else {
                                                        DropdownMenuItem(
                                                            text = { Text(stringResource(R.string.notes_restore)) },
                                                            onClick = {
                                                                rowMenu = false
                                                                pendingRestore = note
                                                            },
                                                        )
                                                        if (note.capabilities.canDelete) {
                                                            DropdownMenuItem(
                                                                text = {
                                                                    Text(
                                                                        stringResource(R.string.notes_purge),
                                                                        color = ZephyrTheme.palette.status.error,
                                                                    )
                                                                },
                                                                onClick = {
                                                                    rowMenu = false
                                                                    pendingPurge = note
                                                                },
                                                            )
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    },
                                )
                            }
                        }
                    }
                    item("limits") {
                        Text(
                            "默认私有 · 可关联连接、按标签归档 · 标题 200 / 正文 1 MiB / 标签 100",
                            color = ZephyrTheme.palette.onFloatingSubtle,
                            fontSize = 13.sp,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().padding(top = 26.dp, bottom = 8.dp),
                        )
                    }
                }
            }
        }
    }

    pendingTrash?.let { target ->
        AlertDialog(
            onDismissRequest = { pendingTrash = null },
            title = { Text(stringResource(R.string.notes_trash_title)) },
            text = { Text(stringResource(R.string.notes_trash_message, target.title.ifBlank { "无标题笔记" })) },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.trash(target)
                    pendingTrash = null
                }) { Text(stringResource(R.string.notes_trash)) }
            },
            dismissButton = { TextButton(onClick = { pendingTrash = null }) { Text(stringResource(R.string.notes_cancel)) } },
        )
    }

    pendingRestore?.let { target ->
        AlertDialog(
            onDismissRequest = { pendingRestore = null },
            title = { Text(stringResource(R.string.notes_restore_title)) },
            text = { Text(stringResource(R.string.notes_restore_message, target.title.ifBlank { "无标题笔记" })) },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.restore(target)
                    pendingRestore = null
                }) { Text(stringResource(R.string.notes_restore)) }
            },
            dismissButton = { TextButton(onClick = { pendingRestore = null }) { Text(stringResource(R.string.notes_cancel)) } },
        )
    }

    pendingPurge?.let { target ->
        AlertDialog(
            onDismissRequest = { pendingPurge = null },
            title = { Text(stringResource(R.string.notes_purge_title)) },
            text = { Text(stringResource(R.string.notes_purge_message, target.title.ifBlank { "无标题笔记" })) },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.purge(target)
                    pendingPurge = null
                }) { Text(stringResource(R.string.notes_purge)) }
            },
            dismissButton = { TextButton(onClick = { pendingPurge = null }) { Text(stringResource(R.string.notes_cancel)) } },
        )
    }
    }
}

@Composable
fun NoteEditorRoute(
    viewModel: NoteEditorViewModel,
    onBack: () -> Unit,
    onMessage: suspend (String) -> Unit,
) {
    val draft by viewModel.draft.collectAsState()
    var preview by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(viewModel) { viewModel.message.collect { onMessage(it) } }
    LaunchedEffect(viewModel) { viewModel.finished.collect { onBack() } }

    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(
            title = if (draft?.isCreate == true) stringResource(R.string.notes_create) else stringResource(R.string.notes_edit),
            onBack = onBack,
        ) {
            one.zephyr.mobile.ui.component.SegmentedControl(
                options = listOf("编辑", "预览"),
                selectedIndex = if (preview) 1 else 0,
                onSelect = { preview = it == 1 },
                modifier = Modifier.width(92.dp),
            )
        }
        val current = draft
        if (current == null) {
            Text(stringResource(R.string.notes_missing), modifier = Modifier.padding(ZephyrSpacing.lg))
            return
        }
        Box(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize()) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 16.dp)
                        .padding(bottom = 16.dp),
                ) {
                    GroupCard {
                        one.zephyr.mobile.ui.component.FieldRow(
                            label = "标题",
                            value = current.current.title,
                            onValueChange = { viewModel.edit { d -> d.withTitle(it) } },
                            placeholder = "最多 200 字",
                        )
                        one.zephyr.mobile.ui.component.FieldRow(
                            label = "标签",
                            value = current.current.tags.joinToString(", "),
                            onValueChange = { raw ->
                                viewModel.edit { noteDraft ->
                                    var next = noteDraft.copy(current = noteDraft.current.copy(tags = emptyList()))
                                    raw.split(',').map(String::trim).filter(String::isNotEmpty).forEach { next = next.withTagAdded(it) }
                                    next
                                }
                            },
                            placeholder = "逗号分隔，最多 100 字",
                        )
                        SettingsRow(
                            title = "关联连接",
                            subtitle = if (current.linkCount == 0) "未关联 · 最多 100 字" else "已关联 ${current.linkCount} 个连接",
                            showChevron = true,
                            showDivider = false,
                            onClick = {},
                        )
                    }
                }
                if (preview) {
                    val previewBlocks = remember(current.current.content) { Markdown.parse(current.current.content) }
                    Column(
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxWidth()
                            .verticalScroll(rememberScrollState())
                            .padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 140.dp),
                    ) {
                        if (previewBlocks.isEmpty()) {
                            Text(
                                stringResource(R.string.notes_preview_empty),
                                color = ZephyrTheme.palette.onFloatingSubtle,
                                fontSize = 15.5.sp,
                            )
                        } else {
                            previewBlocks.forEach { block -> MarkdownBlockView(block) }
                        }
                    }
                } else {
                    BasicTextField(
                        value = current.current.content,
                        onValueChange = { viewModel.edit { d -> d.withContent(it) } },
                        textStyle = TextStyle(color = ZephyrTheme.palette.onBackground, fontSize = 15.5.sp, lineHeight = 26.sp),
                        cursorBrush = SolidColor(ZephyrTheme.palette.brand.accent),
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxWidth()
                            .padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 140.dp),
                        decorationBox = { inner ->
                            Box {
                                if (current.current.content.isEmpty()) Text("Markdown 正文，最大 1 MiB…", color = ZephyrTheme.palette.onFloatingSubtle)
                                inner()
                            }
                        },
                    )
                }
            }
            PushedPageActionBar(Modifier.align(Alignment.BottomCenter)) {
                PrimaryButton(
                    onClick = { scope.launch { onMessage("正文 1 MiB 上限 · 当前 ${current.contentBytes} B") } },
                    modifier = Modifier.weight(1f),
                    ghost = true,
                ) { Text("统计") }
                PrimaryButton(
                    onClick = viewModel::save,
                    enabled = current.canSave,
                    modifier = Modifier.weight(1.4f),
                ) { Text("保存") }
            }
        }
    }
}

@Composable
private fun NoteIcon(pending: Boolean) {
    Surface(shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp), color = ZephyrTheme.palette.surfaces.elevated) {
        Box(Modifier.size(30.dp), contentAlignment = Alignment.Center) {
            Icon(
                ZephyrIcons.Notes,
                contentDescription = null,
                tint = if (pending) ZephyrTheme.palette.status.warning else ZephyrTheme.palette.onFloatingMuted,
                modifier = Modifier.size(16.dp),
            )
        }
    }
}

@Composable
private fun PendingBadge() {
    Text(
        "待同步",
        color = ZephyrTheme.palette.status.pendingSync,
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier
            .clip(androidx.compose.foundation.shape.RoundedCornerShape(8.dp))
            .background(ZephyrTheme.palette.status.pendingSync.copy(alpha = 0.14f))
            .padding(horizontal = 8.dp, vertical = 2.dp),
    )
}

@Composable
private fun NoteSearch(query: String, onQueryChange: (String) -> Unit) {
    val palette = ZephyrTheme.palette
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(ZephyrIcons.Search, contentDescription = null, tint = palette.onFloatingSubtle)
        Spacer(Modifier.padding(4.dp))
        BasicTextField(
            value = query,
            onValueChange = onQueryChange,
            singleLine = true,
            textStyle = TextStyle(color = palette.onBackground, fontSize = 14.sp),
            modifier = Modifier.weight(1f),
            decorationBox = { inner ->
                if (query.isEmpty()) Text(stringResource(R.string.notes_search), color = palette.onFloatingSubtle)
                inner()
            },
        )
    }
}


// ---- Markdown preview --------------------------------------------------------------------------

/**
 * Inline spans → AnnotatedString.
 *
 * CODE wins over emphasis inside a span because the parser resolved backticks first; nesting is
 * applied in insertion order, which matches how [Markdown.inline] emits spans.
 */
private fun markdownAnnotated(text: MarkdownText, linkColor: Color): AnnotatedString {
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

/** One block of the preview, laid out the way the main end's notes.js renders the same document. */
@Composable
private fun MarkdownBlockView(block: MarkdownBlock) {
    val palette = ZephyrTheme.palette
    when (block) {
        is MarkdownBlock.Heading -> Text(
            text = markdownAnnotated(block.text, palette.brand.accent),
            color = palette.onBackground,
            style = TextStyle(
                fontWeight = FontWeight.Bold,
                fontSize = when (block.level) {
                    1 -> 23.sp
                    2 -> 20.sp
                    3 -> 18.sp
                    4 -> 16.5.sp
                    5 -> 15.5.sp
                    else -> 15.sp
                },
                lineHeight = 28.sp,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = if (block.level <= 2) 16.dp else 12.dp, bottom = 6.dp),
        )

        is MarkdownBlock.Paragraph -> Text(
            text = markdownAnnotated(block.text, palette.brand.accent),
            color = palette.onBackground,
            style = TextStyle(fontSize = 15.5.sp, lineHeight = 26.sp),
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 5.dp),
        )

        is MarkdownBlock.CodeBlock -> Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 8.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(palette.surfaces.elevated)
                .padding(horizontal = 12.dp, vertical = 10.dp),
        ) {
            if (block.language.isNotBlank()) {
                Text(
                    block.language,
                    color = palette.onFloatingSubtle,
                    fontSize = 11.sp,
                    modifier = Modifier.padding(bottom = 6.dp),
                )
            }
            Text(
                block.code,
                color = palette.onBackground,
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                style = TextStyle(lineHeight = 20.sp),
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
                .padding(vertical = 5.dp),
        ) {
            Box(
                Modifier
                    .width(3.dp)
                    .height(22.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(palette.brand.accent.copy(alpha = 0.6f)),
            )
            Spacer(Modifier.width(10.dp))
            Text(
                text = markdownAnnotated(block.text, palette.brand.accent),
                color = palette.onFloatingMuted,
                style = TextStyle(fontSize = 15.sp, lineHeight = 24.sp),
                modifier = Modifier.weight(1f),
            )
        }

        is MarkdownBlock.Table -> Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 8.dp)
                .clip(RoundedCornerShape(10.dp))
                .border(1.dp, palette.surfaces.outlineSoft, RoundedCornerShape(10.dp))
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
                .padding(vertical = 10.dp)
                .height(1.dp)
                .background(palette.surfaces.outlineSoft),
        )
    }
}

@Composable
private fun MarkdownTableRow(
    cells: List<MarkdownText>,
    alignments: List<String>,
    header: Boolean,
    linkColor: Color,
) {
    val palette = ZephyrTheme.palette
    Row(
        modifier = Modifier
            .background(if (header) palette.surfaces.elevated else Color.Transparent)
            .padding(horizontal = 10.dp, vertical = 7.dp),
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
                    fontSize = 14.sp,
                    lineHeight = 21.sp,
                    fontWeight = if (header) FontWeight.SemiBold else FontWeight.Normal,
                    textAlign = align,
                ),
                modifier = Modifier.width(140.dp),
            )
        }
    }
}

@Composable
private fun MarkdownListRow(depth: Int, marker: String, text: MarkdownText) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = (depth * 18).dp, top = 3.dp, bottom = 3.dp),
    ) {
        Text(
            marker,
            color = ZephyrTheme.palette.onFloatingMuted,
            fontSize = 15.sp,
            modifier = Modifier.width(24.dp),
        )
        Text(
            text = markdownAnnotated(text, ZephyrTheme.palette.brand.accent),
            color = ZephyrTheme.palette.onBackground,
            style = TextStyle(fontSize = 15.5.sp, lineHeight = 25.sp),
            modifier = Modifier.weight(1f),
        )
    }
}
