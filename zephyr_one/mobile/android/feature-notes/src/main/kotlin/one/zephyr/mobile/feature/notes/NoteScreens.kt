package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.ui.icon.ZephyrIcons

import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
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
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import one.zephyr.mobile.ui.component.AlertDialog
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
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

    Box(Modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = stringResource(R.string.notes_title), onBack = onBack) {
            HeaderAddButton(stringResource(R.string.notes_create), onCreate)
        }
        PageStateScaffold(state = state, modifier = Modifier.fillMaxSize()) { content ->
            Column(Modifier.fillMaxSize()) {
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
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 2.dp, bottom = 140.dp),
                ) {
                    item("notes") {
                        GroupCard {
                            content.notes.forEachIndexed { index, note ->
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
                                        if (note.syncState == SyncState.PENDING_LOCAL) PendingBadge()
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
                        .weight(1f)
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
                    Text(
                        current.current.content,
                        color = ZephyrTheme.palette.onBackground,
                        fontSize = 15.5.sp,
                        style = TextStyle(lineHeight = 26.sp),
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxWidth()
                            .verticalScroll(rememberScrollState())
                            .padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 140.dp),
                    )
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
