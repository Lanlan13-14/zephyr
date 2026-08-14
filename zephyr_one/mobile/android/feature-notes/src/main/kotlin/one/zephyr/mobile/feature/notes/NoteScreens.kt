package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.ui.icon.ZephyrIcons

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import one.zephyr.mobile.ui.component.AlertDialog
import one.zephyr.mobile.ui.component.FilterChip
import one.zephyr.mobile.ui.component.Icon
import one.zephyr.mobile.ui.component.OutlinedTextField
import one.zephyr.mobile.ui.component.Switch
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.component.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import one.zephyr.mobile.data.repository.NoteRepository
import one.zephyr.mobile.model.Note
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.ui.chrome.HeaderAddButton
import one.zephyr.mobile.ui.chrome.PushedPageHeader
import one.zephyr.mobile.ui.format.RelativeTime
import one.zephyr.mobile.ui.state.PageStateScaffold
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme
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
            combine(notes.observeNotes(ownerUserId), filterState) { rows, filter ->
                NoteListStates.derive(
                    notes = rows.filterNot(Note::isTrashed),
                    trashed = rows.filter(Note::isTrashed),
                    filter = filter,
                    loaded = true,
                    online = online,
                    bound = bound,
                    lastSyncedAt = lastSyncedAt,
                )
            }.collect { page.value = it }
        }
    }

    fun setQuery(value: String) { filterState.value = filterState.value.copy(query = value) }
    fun setScope(scope: NoteScope) { filterState.value = filterState.value.copy(scope = scope) }
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

    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = stringResource(R.string.notes_title), onBack = onBack) {
            HeaderAddButton(stringResource(R.string.notes_create), onCreate)
        }
        PageStateScaffold(state = state, modifier = Modifier.fillMaxSize()) { content ->
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(horizontal = ZephyrSpacing.lg, vertical = ZephyrSpacing.sm),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                item("search") {
                    NoteSearch(filter.query, viewModel::setQuery)
                }
                item("scopes") {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.horizontalScroll(rememberScrollState())) {
                        FilterChip(selected = filter.scope == NoteScope.ACTIVE, onClick = { viewModel.setScope(NoteScope.ACTIVE) }, label = { Text(stringResource(R.string.notes_scope_all)) })
                        FilterChip(selected = filter.scope == NoteScope.TRASH, onClick = { viewModel.setScope(NoteScope.TRASH) }, label = { Text(stringResource(R.string.notes_scope_trash, content.trashedCount)) })
                        content.availableTags.take(8).forEach { tag ->
                            FilterChip(selected = tag in filter.tags, onClick = { viewModel.toggleTag(tag) }, label = { Text(tag) })
                        }
                    }
                }
                items(content.notes, key = { it.noteId }) { note ->
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clickable { onOpen(note) }
                            .padding(vertical = 10.dp),
                    ) {
                        Text(note.title.ifBlank { stringResource(R.string.library_untitled_note) }, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                        Text(
                            listOf(note.groupPath, RelativeTime.format(nowMs, note.updatedAt)).filter { it.isNotBlank() }.joinToString(" · "),
                            color = ZephyrTheme.palette.onFloatingMuted,
                            fontSize = 12.sp,
                        )
                        Row {
                            if (filter.scope == NoteScope.TRASH) {
                                TextButton(onClick = { viewModel.restore(note) }) { Text(stringResource(R.string.notes_restore)) }
                            } else {
                                TextButton(onClick = { pendingTrash = note }) { Text(stringResource(R.string.notes_trash)) }
                            }
                        }
                    }
                }
                item("limits") {
                    Text(
                        stringResource(R.string.notes_limits),
                        color = ZephyrTheme.palette.onFloatingMuted,
                        fontSize = 12.sp,
                        modifier = Modifier.padding(vertical = ZephyrSpacing.md),
                    )
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
}

@Composable
fun NoteEditorRoute(
    viewModel: NoteEditorViewModel,
    onBack: () -> Unit,
    onMessage: suspend (String) -> Unit,
) {
    val draft by viewModel.draft.collectAsState()
    LaunchedEffect(viewModel) { viewModel.message.collect { onMessage(it) } }
    LaunchedEffect(viewModel) { viewModel.finished.collect { onBack() } }

    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(
            title = if (draft?.isCreate == true) stringResource(R.string.notes_create) else stringResource(R.string.notes_edit),
            onBack = onBack,
        ) {
            TextButton(onClick = viewModel::save, enabled = draft?.canSave == true) {
                Text(stringResource(R.string.notes_save))
            }
        }
        val current = draft
        if (current == null) {
            Text(stringResource(R.string.notes_missing), modifier = Modifier.padding(ZephyrSpacing.lg))
            return
        }
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = ZephyrSpacing.lg),
        ) {
            OutlinedTextField(
                value = current.current.title,
                onValueChange = { viewModel.edit { d -> d.withTitle(it) } },
                label = { Text(stringResource(R.string.notes_field_title)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                isError = current.issueFor("title") != null,
            )
            OutlinedTextField(
                value = current.current.groupPath,
                onValueChange = { viewModel.edit { d -> d.withGroupPath(it) } },
                label = { Text(stringResource(R.string.notes_field_group)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            OutlinedTextField(
                value = current.current.tags.joinToString(","),
                onValueChange = { raw ->
                    viewModel.edit { draft ->
                        var next = draft.copy(current = draft.current.copy(tags = emptyList()))
                        raw.split(',').map { it.trim() }.filter { it.isNotEmpty() }.forEach { next = next.withTagAdded(it) }
                        next
                    }
                },
                label = { Text(stringResource(R.string.notes_field_tags)) },
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            BasicTextField(
                value = current.current.content,
                onValueChange = { viewModel.edit { d -> d.withContent(it) } },
                textStyle = TextStyle(color = ZephyrTheme.palette.onBackground, fontSize = 15.sp),
                cursorBrush = SolidColor(ZephyrTheme.palette.brand.accent),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(280.dp),
            )
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.notes_ai_read), modifier = Modifier.weight(1f))
                Switch(checked = current.current.aiReadEnabled, onCheckedChange = { viewModel.edit { d -> d.withAiRead(it) } })
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.notes_ai_write), modifier = Modifier.weight(1f))
                Switch(checked = current.current.aiWriteEnabled, onCheckedChange = { viewModel.edit { d -> d.withAiWrite(it) } })
            }
            Text(
                "${current.titleLength}/${Note.MAX_TITLE_CHARS} · ${current.contentBytes} B / ${Note.MAX_CONTENT_BYTES}",
                color = ZephyrTheme.palette.onFloatingMuted,
                fontSize = 12.sp,
                modifier = Modifier.padding(vertical = ZephyrSpacing.md),
            )
        }
    }
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
