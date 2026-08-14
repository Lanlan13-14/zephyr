package one.zephyr.mobile.feature.notes

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import one.zephyr.mobile.ui.component.AlertDialog
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
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
import kotlinx.coroutines.launch
import one.zephyr.mobile.data.repository.NoteRepository
import one.zephyr.mobile.model.Snippet
import one.zephyr.mobile.ui.chrome.HeaderAddButton
import one.zephyr.mobile.ui.chrome.PushedPageHeader
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme
import java.util.UUID

class SnippetListViewModel(
    private val notes: NoteRepository,
    private val ownerUserId: String,
) : ViewModel() {
    private val rows = MutableStateFlow<List<Snippet>>(emptyList())
    val snippets: StateFlow<List<Snippet>> = rows.asStateFlow()

    init {
        viewModelScope.launch {
            notes.observeSnippets(ownerUserId).collect { list ->
                rows.value = list.filter { it.deletedAt == null }.sortedByDescending(Snippet::updatedAt)
            }
        }
    }

    fun delete(snippet: Snippet) {
        viewModelScope.launch { runCatching { notes.deleteSnippet(snippet, ownerUserId) } }
    }

    companion object {
        fun factory(notes: NoteRepository, ownerUserId: String): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    SnippetListViewModel(notes, ownerUserId) as T
            }
    }
}

class SnippetEditorViewModel(
    private val notes: NoteRepository,
    private val ownerUserId: String,
    private val snippetId: String?,
    private val newIdFactory: () -> String,
) : ViewModel() {
    private val draftState = MutableStateFlow<SnippetDraft?>(null)
    val draft: StateFlow<SnippetDraft?> = draftState.asStateFlow()
    private val messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val message: SharedFlow<String> = messages
    private val done = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val finished: SharedFlow<Unit> = done

    init {
        viewModelScope.launch {
            val existing = notes.observeSnippets(ownerUserId)
            existing.collect { all ->
                val live = all.filter { it.deletedAt == null }
                if (snippetId == null) {
                    if (draftState.value == null) {
                        draftState.value = SnippetDraft.create(ownerUserId, newIdFactory(), existingCount = live.size)
                    }
                    return@collect
                }
                val found = live.firstOrNull { it.id == snippetId }
                if (found == null) {
                    draftState.value = null
                } else if (draftState.value == null || draftState.value?.isDirty != true) {
                    draftState.value = SnippetDraft.edit(found, existingCount = live.size)
                }
            }
        }
    }

    fun edit(block: (SnippetDraft) -> SnippetDraft) {
        draftState.value = draftState.value?.let(block)
    }

    fun save() {
        val current = draftState.value ?: return
        val issues = current.validate()
        if (issues.isNotEmpty() || !current.isDirty) {
            viewModelScope.launch { messages.emit(snippetIssueText(issues.firstOrNull())) }
            return
        }
        viewModelScope.launch {
            runCatching {
                notes.saveSnippet(
                    snippet = current.normalized().copy(updatedAt = System.currentTimeMillis()),
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
            snippetId: String?,
            newIdFactory: () -> String = { UUID.randomUUID().toString() },
        ): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                SnippetEditorViewModel(notes, ownerUserId, snippetId, newIdFactory) as T
        }
    }
}

private fun snippetIssueText(issue: SnippetIssue?): String = when (issue?.code) {
    SnippetIssueCode.NAME_REQUIRED -> "请输入名称"
    SnippetIssueCode.NAME_TOO_LONG -> "名称不能超过 60 字"
    SnippetIssueCode.COMMAND_REQUIRED -> "请输入命令"
    SnippetIssueCode.COMMAND_TOO_LONG -> "命令不能超过 20000 字"
    SnippetIssueCode.GROUP_TOO_LONG -> "分组不能超过 40 字"
    SnippetIssueCode.ACCOUNT_LIMIT_REACHED -> "已达到 500 条上限"
    null -> "无法保存"
}

@Composable
fun SnippetListRoute(
    viewModel: SnippetListViewModel,
    onBack: () -> Unit,
    onOpen: (Snippet) -> Unit,
    onCreate: () -> Unit,
    onInsert: (Snippet) -> Unit,
    onRun: (Snippet) -> Unit,
) {
    val rows by viewModel.snippets.collectAsState()
    var pending by remember { mutableStateOf<Snippet?>(null) }

    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = stringResource(R.string.snippets_title), onBack = onBack) {
            HeaderAddButton(stringResource(R.string.snippets_create), onCreate)
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = ZephyrSpacing.lg, vertical = ZephyrSpacing.sm),
        ) {
            items(rows, key = { it.id }) { snippet ->
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clickable { onOpen(snippet) }
                        .padding(vertical = 10.dp),
                ) {
                    Text(snippet.name, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                    Text(
                        listOf(snippet.group, snippet.command.lineSequence().firstOrNull().orEmpty())
                            .filter { it.isNotBlank() }
                            .joinToString(" · "),
                        color = ZephyrTheme.palette.onFloatingMuted,
                        fontSize = 12.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                    Row {
                        TextButton(onClick = { onInsert(snippet) }) { Text(stringResource(R.string.snippets_insert)) }
                        TextButton(onClick = { onRun(snippet) }) { Text(stringResource(R.string.snippets_run)) }
                        TextButton(onClick = { pending = snippet }) { Text(stringResource(R.string.snippets_delete)) }
                    }
                }
            }
            item("limits") {
                Text(
                    stringResource(R.string.snippets_limits),
                    color = ZephyrTheme.palette.onFloatingMuted,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(vertical = ZephyrSpacing.md),
                )
            }
        }
    }

    pending?.let { target ->
        AlertDialog(
            onDismissRequest = { pending = null },
            title = { Text(stringResource(R.string.snippets_delete_title)) },
            text = { Text(stringResource(R.string.snippets_delete_message, target.name)) },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.delete(target)
                    pending = null
                }) { Text(stringResource(R.string.snippets_delete)) }
            },
            dismissButton = { TextButton(onClick = { pending = null }) { Text("取消") } },
        )
    }
}

@Composable
fun SnippetEditorRoute(
    viewModel: SnippetEditorViewModel,
    onBack: () -> Unit,
    onMessage: suspend (String) -> Unit,
) {
    val draft by viewModel.draft.collectAsState()
    LaunchedEffect(viewModel) { viewModel.message.collect { onMessage(it) } }
    LaunchedEffect(viewModel) { viewModel.finished.collect { onBack() } }

    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(
            title = if (draft?.isCreate == true) stringResource(R.string.snippets_create) else stringResource(R.string.snippets_edit),
            onBack = onBack,
        ) {
            TextButton(onClick = viewModel::save, enabled = draft?.canSave == true) {
                Text(stringResource(R.string.snippets_save))
            }
        }
        val current = draft
        if (current == null) {
            Text(stringResource(R.string.snippets_missing), modifier = Modifier.padding(ZephyrSpacing.lg))
            return
        }
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = ZephyrSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            OutlinedTextField(
                value = current.current.name,
                onValueChange = { viewModel.edit { d -> d.withName(it) } },
                label = { Text(stringResource(R.string.snippets_field_name)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            OutlinedTextField(
                value = current.current.group,
                onValueChange = { viewModel.edit { d -> d.withGroup(it) } },
                label = { Text(stringResource(R.string.snippets_field_group)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            OutlinedTextField(
                value = current.current.command,
                onValueChange = { viewModel.edit { d -> d.withCommand(it) } },
                label = { Text(stringResource(R.string.snippets_field_command)) },
                modifier = Modifier.fillMaxWidth().height(180.dp),
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.snippets_autorun), modifier = Modifier.weight(1f), fontSize = 13.sp)
                Switch(checked = current.current.autoRun, onCheckedChange = { viewModel.edit { d -> d.withAutoRun(it) } })
            }
        }
    }
}

@Composable
fun SftpPlaceholderRoute(
    connections: List<one.zephyr.mobile.model.Connection>,
    onBack: () -> Unit,
    onOpenConnection: (one.zephyr.mobile.model.Connection) -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = stringResource(R.string.sftp_title), onBack = onBack)
        Column(Modifier.padding(horizontal = ZephyrSpacing.lg)) {
            Text(stringResource(R.string.sftp_engine_missing), color = ZephyrTheme.palette.onFloatingMuted)
            Text(
                stringResource(R.string.sftp_pick_connection),
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(top = ZephyrSpacing.lg, bottom = ZephyrSpacing.sm),
            )
            connections.filter { it.protocol.supportsFiles && it.capabilities.canReadFiles }.forEach { connection ->
                Text(
                    "${connection.name} · ${connection.host}:${connection.port}",
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onOpenConnection(connection) }
                        .padding(vertical = 12.dp),
                )
            }
        }
    }
}

@Composable
fun DownloadsRoute(
    downloads: List<FileDownload>,
    onBack: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = stringResource(R.string.library_downloads_title), onBack = onBack)
        if (downloads.isEmpty()) {
            Text(
                stringResource(R.string.library_downloads_empty),
                color = ZephyrTheme.palette.onFloatingMuted,
                modifier = Modifier.padding(ZephyrSpacing.lg),
            )
        } else {
            LazyColumn(contentPadding = PaddingValues(ZephyrSpacing.lg)) {
                items(downloads, key = { it.id }) { item ->
                    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                        Text(item.fileName, fontWeight = FontWeight.SemiBold)
                        Text(
                            "${item.connectionName} · ${item.state.name} · ${item.percentComplete?.let { "$it%" } ?: "${item.transferredBytes} B"}",
                            color = ZephyrTheme.palette.onFloatingMuted,
                            fontSize = 12.sp,
                        )
                    }
                }
            }
        }
    }
}
