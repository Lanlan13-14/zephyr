package one.zephyr.mobile.feature.notes

import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import one.zephyr.mobile.ui.component.AlertDialog
import one.zephyr.mobile.ui.component.GroupCard
import one.zephyr.mobile.ui.component.OutlinedTextField
import one.zephyr.mobile.ui.component.PrimaryButton
import one.zephyr.mobile.ui.component.SettingsRow
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
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
import kotlinx.coroutines.launch
import one.zephyr.mobile.data.repository.NoteRepository
import one.zephyr.mobile.model.Snippet
import one.zephyr.mobile.ui.chrome.HeaderAddButton
import one.zephyr.mobile.ui.chrome.PushedPageActionBar
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
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 140.dp),
        ) {
            item("snippets") {
                GroupCard {
                    rows.forEachIndexed { index, snippet ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    snippet.command.lineSequence().firstOrNull().orEmpty(),
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 13.sp,
                                    maxLines = 1,
                                )
                                Text(
                                    buildList {
                                        add(snippet.name)
                                        if (snippet.group.isNotBlank()) add(snippet.group)
                                        if (snippet.autoRun) add("autoRun")
                                    }.joinToString(" · "),
                                    color = ZephyrTheme.palette.onFloatingSubtle,
                                    fontSize = 11.5.sp,
                                )
                            }
                            SnippetMiniButton("插入", active = false) { onInsert(snippet) }
                            SnippetMiniButton("执行", active = true) { onRun(snippet) }
                        }
                        if (index != rows.lastIndex) {
                            Box(Modifier.fillMaxWidth().height(1.dp).background(ZephyrTheme.palette.surfaces.outlineSoft))
                        }
                    }
                }
            }
            item("limits") {
                Text(
                    "name 60 / command 20000 / group 40 · 最多 500 条 · 删除进入同步 tombstone",
                    color = ZephyrTheme.palette.onFloatingSubtle,
                    fontSize = 13.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(top = 26.dp, bottom = 8.dp),
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
    val scope = rememberCoroutineScope()
    LaunchedEffect(viewModel) { viewModel.message.collect { onMessage(it) } }
    LaunchedEffect(viewModel) { viewModel.finished.collect { onBack() } }

    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(
            title = if (draft?.isCreate == true) stringResource(R.string.snippets_create) else stringResource(R.string.snippets_edit),
            onBack = onBack,
        )
        val current = draft
        if (current == null) {
            Text(stringResource(R.string.snippets_missing), modifier = Modifier.padding(ZephyrSpacing.lg))
            return
        }
        Box(Modifier.fillMaxSize()) {
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp)
                    .padding(bottom = 190.dp),
            ) {
                GroupCard(Modifier.padding(top = 4.dp)) {
                    one.zephyr.mobile.ui.component.FieldRow(
                        label = "名称",
                        value = current.current.name,
                        onValueChange = { viewModel.edit { d -> d.withName(it) } },
                        placeholder = "最多 60 字",
                    )
                    one.zephyr.mobile.ui.component.FieldRow(
                        label = "分组",
                        value = current.current.group,
                        onValueChange = { viewModel.edit { d -> d.withGroup(it) } },
                        placeholder = "最多 40 字",
                    )
                    one.zephyr.mobile.ui.component.FieldRow(
                        label = "命令",
                        value = current.current.command,
                        onValueChange = { viewModel.edit { d -> d.withCommand(it) } },
                        mono = true,
                        singleLine = false,
                    )
                    SettingsRow(
                        title = "autoRun",
                        subtitle = "插入终端后立即执行 · 仍需 execute 权限",
                        showDivider = false,
                        trailing = {
                            Switch(
                                checked = current.current.autoRun,
                                onCheckedChange = { viewModel.edit { d -> d.withAutoRun(it) } },
                            )
                        },
                    )
                }
                Text(
                    "插入不需要 execute 权限；实际执行需要 connection 的 execute 能力，危险命令仍走确认策略",
                    color = ZephyrTheme.palette.onFloatingSubtle,
                    fontSize = 13.sp,
                    modifier = Modifier.fillMaxWidth().padding(top = 26.dp, bottom = 8.dp),
                )
            }
            PushedPageActionBar(Modifier.align(Alignment.BottomCenter)) {
                PrimaryButton(
                    onClick = { scope.launch { onMessage("已插入当前终端（未执行）") } },
                    modifier = Modifier.weight(1f),
                    ghost = true,
                ) { Text("插入终端") }
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
private fun SnippetMiniButton(label: String, active: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) Color(0xFF7EE787) else ZephyrTheme.palette.onFloatingMuted,
        fontSize = 10.5.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(
                if (active) ZephyrTheme.palette.status.success.copy(alpha = 0.22f)
                else ZephyrTheme.palette.surfaces.elevated,
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 9.dp, vertical = 3.dp),
    )
}

@Composable
fun SftpPlaceholderRoute(
    connections: List<one.zephyr.mobile.model.Connection>,
    onBack: () -> Unit,
    onOpenConnection: (one.zephyr.mobile.model.Connection) -> Unit,
) {
    val selected = connections.firstOrNull { it.protocol.supportsFiles && it.capabilities.canReadFiles }
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "文件 · ${selected?.name ?: "prod-web-01"}", onBack = onBack) {
            HeaderAddButton("上传") { selected?.let(onOpenConnection) }
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            listOf("~", "deploy", "releases").forEachIndexed { index, label ->
                one.zephyr.mobile.ui.component.FilterChip(
                    selected = index == 0,
                    onClick = { selected?.let(onOpenConnection) },
                    label = { Text(label, fontFamily = FontFamily.Monospace) },
                )
            }
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 2.dp, bottom = 140.dp),
        ) {
            item("files") {
                GroupCard {
                    SftpRow("..", "上级目录")
                    SftpRow("deploy-2026-08-11.tar.gz", "18.4 MB · 昨天 22:41", more = true)
                    SftpRow("deploy-2026-08-04.tar.gz", "17.9 MB · 8月4日", more = true)
                    SftpRow("rollback-notes.md", "2.1 KB · 8月1日", note = true, divider = false)
                }
            }
            item("transfer-label") { SftpSectionLabel("传输") }
            item("transfer") {
                GroupCard {
                    TransferRow("access.log", 0.62f, "62%", complete = false)
                    TransferRow("deploy.tar.gz", 1f, "完成", complete = true)
                }
            }
            item("conflict-label") { SftpSectionLabel("保存冲突 · rollback-notes.md") }
            item("diff") {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DiffPanel("本机 · 2 分钟前", "# rollback\n1. stop nginx\n2. restore dump", Modifier.weight(1f))
                    DiffPanel("远端 · mtime 更新", "# rollback\n1. stop nginx\n2. restore dump\n3. verify 5xx", Modifier.weight(1f))
                }
            }
            item("conflict-actions") {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    PrimaryButton(onClick = { selected?.let(onOpenConnection) }, modifier = Modifier.weight(1f), ghost = true) { Text("另存") }
                    PrimaryButton(onClick = { selected?.let(onOpenConnection) }, modifier = Modifier.weight(1f), ghost = true) { Text("保留本机") }
                    PrimaryButton(onClick = { selected?.let(onOpenConnection) }, modifier = Modifier.weight(1.4f)) { Text("覆盖远端") }
                }
            }
            item("limits") {
                Text(
                    "list/stat/read/download = fileRead · upload/new/edit/rename/delete = fileWrite",
                    color = ZephyrTheme.palette.onFloatingSubtle,
                    fontSize = 13.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(top = 26.dp, bottom = 8.dp),
                )
            }
        }
    }
}

@Composable
private fun SftpRow(
    name: String,
    detail: String,
    more: Boolean = false,
    note: Boolean = false,
    divider: Boolean = true,
) {
    SettingsRow(
        title = name,
        subtitle = detail,
        showDivider = divider,
        leading = {
            one.zephyr.mobile.ui.component.Surface(
                shape = RoundedCornerShape(8.dp),
                color = ZephyrTheme.palette.surfaces.elevated,
            ) {
                Box(Modifier.size(30.dp), contentAlignment = Alignment.Center) {
                    one.zephyr.mobile.ui.component.Icon(
                        if (note) one.zephyr.mobile.ui.icon.ZephyrIcons.Notes else one.zephyr.mobile.ui.icon.ZephyrIcons.File,
                        contentDescription = null,
                        tint = if (note) ZephyrTheme.palette.status.warning else ZephyrTheme.palette.protocol.sftp,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
        },
        trailing = {
            if (more) Text("•••", color = ZephyrTheme.palette.onFloatingSubtle, fontSize = 13.sp)
        },
    )
}

@Composable
private fun SftpSectionLabel(text: String) {
    Text(
        text.uppercase(),
        color = ZephyrTheme.palette.onFloatingSubtle,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(start = 4.dp, top = 22.dp, bottom = 10.dp),
    )
}

@Composable
private fun TransferRow(name: String, progress: Float, label: String, complete: Boolean) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(name, fontFamily = FontFamily.Monospace, fontSize = 12.5.sp, modifier = Modifier.weight(0.8f), maxLines = 1)
        Box(
            Modifier
                .weight(1f)
                .height(4.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(ZephyrTheme.palette.surfaces.elevated),
        ) {
            Box(
                Modifier
                    .fillMaxWidth(progress)
                    .height(4.dp)
                    .background(if (complete) ZephyrTheme.palette.status.success else ZephyrTheme.palette.brand.accent),
            )
        }
        Text(
            label,
            color = if (complete) ZephyrTheme.palette.status.success else ZephyrTheme.palette.onFloatingMuted,
            fontSize = 12.5.sp,
        )
    }
}

@Composable
private fun DiffPanel(title: String, body: String, modifier: Modifier = Modifier) {
    Column(
        modifier
            .clip(RoundedCornerShape(10.dp))
            .background(ZephyrTheme.palette.surfaces.content)
            .padding(10.dp),
    ) {
        Text(title, color = ZephyrTheme.palette.onFloatingMuted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        Text(body, color = ZephyrTheme.palette.onFloatingMuted, fontSize = 10.5.sp, fontFamily = FontFamily.Monospace)
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
