@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package one.zephyr.mobile.feature.connections

import one.zephyr.mobile.ui.icon.ZephyrIcons

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import one.zephyr.mobile.ui.component.AlertDialog
import one.zephyr.mobile.ui.component.AssistChip
import one.zephyr.mobile.ui.component.Button
import one.zephyr.mobile.ui.component.Card
import one.zephyr.mobile.ui.component.DropdownMenu
import one.zephyr.mobile.ui.component.DropdownMenuItem
import one.zephyr.mobile.ui.component.FilterChip
import one.zephyr.mobile.ui.component.Icon
import one.zephyr.mobile.ui.component.IconButton
import one.zephyr.mobile.ui.component.OutlinedButton
import one.zephyr.mobile.ui.component.OutlinedTextField
import one.zephyr.mobile.ui.component.Slider
import one.zephyr.mobile.ui.component.Switch
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.component.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.ConnectionMode
import one.zephyr.mobile.model.FileSyncDirectoryIntent
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.RdpFps
import one.zephyr.mobile.model.RdpQuality
import one.zephyr.mobile.model.RdpResolution
import one.zephyr.mobile.model.RdpSettings
import one.zephyr.mobile.model.RdpSoundMode
import one.zephyr.mobile.model.RdpTouchMode
import one.zephyr.mobile.model.SecretPresence
import one.zephyr.mobile.model.SecretState
import one.zephyr.mobile.model.TerminalEncoding
import one.zephyr.mobile.ui.chrome.PushedPageHeader
import one.zephyr.mobile.ui.component.CleartextProtocolWarning
import one.zephyr.mobile.ui.component.SectionHeader
import one.zephyr.mobile.ui.state.PageStateScaffold
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme

/**
 * S11 连接编辑器.
 *
 * Renders [ConnectionEditorUiState.sections] in order rather than hardcoding the eight sections, so
 * the frozen order in SCREEN_CATALOG.md 6 has exactly one definition ([EditorSection]) and a
 * protocol that has no RDP section simply produces a shorter list.
 *
 * Stateless apart from two genuinely visual pieces of state: the discard dialog and which dropdown
 * is open. Everything else is hoisted into the ViewModel.
 */
@Composable
fun ConnectionEditorScreen(
    state: PageState<ConnectionEditorUiState>,
    isCreate: Boolean,
    onIntent: (EditorIntent) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var confirmDiscard by remember { mutableStateOf(false) }

    Column(modifier.fillMaxSize()) {
        PushedPageHeader(
            title = stringResource(
                if (isCreate) R.string.editor_title_create else R.string.editor_title_edit,
            ),
            onBack = {
                val dirty = (state as? PageState.Content)?.value?.draft?.isDirty == true
                if (dirty) confirmDiscard = true else onBack()
            },
            backDescription = stringResource(R.string.editor_back),
        )

        PageStateScaffold(state = state, modifier = Modifier.fillMaxSize()) { ui ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = ZephyrSpacing.lg),
            ) {
                for (section in ui.sections) {
                    SectionCard(title = sectionTitle(section)) {
                        when (section) {
                            EditorSection.BASIC -> BasicSection(ui, onIntent)
                            EditorSection.AUTH -> AuthSection(ui, onIntent)
                            EditorSection.ROUTE -> RouteSection(ui, onIntent)
                            EditorSection.RDP_CHANNELS -> RdpChannelSection(ui, onIntent)
                            EditorSection.RDP_DISPLAY -> RdpDisplaySection(ui, onIntent)
                            EditorSection.FILE_SYNC -> FileSyncSection(ui, onIntent)
                            EditorSection.METADATA -> MetadataSection(ui, onIntent)
                        }
                    }
                    Spacer(Modifier.height(ZephyrSpacing.md))
                }

                FixedActions(ui = ui, onIntent = onIntent)
                Spacer(Modifier.height(ZephyrSpacing.xxl))
            }
        }
    }

    if (confirmDiscard) {
        AlertDialog(
            onDismissRequest = { confirmDiscard = false },
            title = { Text(stringResource(R.string.editor_discard_title)) },
            text = { Text(stringResource(R.string.editor_discard_message)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmDiscard = false
                        onBack()
                    },
                ) { Text(stringResource(R.string.editor_discard_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { confirmDiscard = false }) {
                    Text(stringResource(R.string.editor_keep_editing))
                }
            },
        )
    }
}

/** One user action on the editor. An interface rather than 20 lambdas keeps the screen signature usable. */
sealed interface EditorIntent {
    data class Name(val value: String) : EditorIntent
    data class Host(val value: String) : EditorIntent
    data class Port(val value: String) : EditorIntent
    data class Username(val value: String) : EditorIntent
    data class Remark(val value: String) : EditorIntent
    data class Tags(val value: List<String>) : EditorIntent
    data class ProtocolChanged(val value: Protocol) : EditorIntent
    data class Encoding(val value: TerminalEncoding) : EditorIntent
    data class Mode(val value: ConnectionMode) : EditorIntent
    data class ProxySelected(val value: String?) : EditorIntent
    data class SshKeySelected(val value: String?) : EditorIntent
    data class JumpAdded(val value: String) : EditorIntent
    data class JumpRemoved(val value: String) : EditorIntent
    data class JumpMoved(val from: Int, val to: Int) : EditorIntent
    data class Password(val value: SecretState) : EditorIntent
    data class PrivateKey(val value: SecretState) : EditorIntent
    data class Rdp(val value: RdpSettings) : EditorIntent
    data class FileSync(val value: FileSyncDirectoryIntent) : EditorIntent
    data class Visibility(val value: String) : EditorIntent
    data class RepairRoute(val field: String) : EditorIntent
    data object Test : EditorIntent
    data object Save : EditorIntent
    data object SaveAndConnect : EditorIntent
    data object ConnectWithoutSaving : EditorIntent
}

@Composable
private fun sectionTitle(section: EditorSection): String = when (section) {
    EditorSection.BASIC -> stringResource(R.string.editor_section_basic)
    EditorSection.AUTH -> stringResource(R.string.editor_section_auth)
    EditorSection.ROUTE -> stringResource(R.string.editor_section_route)
    EditorSection.RDP_CHANNELS -> stringResource(R.string.editor_section_rdp_channels)
    EditorSection.RDP_DISPLAY -> stringResource(R.string.editor_section_rdp_display)
    EditorSection.FILE_SYNC -> stringResource(R.string.editor_section_file_sync)
    EditorSection.METADATA -> stringResource(R.string.editor_section_metadata)
}

@Composable
private fun SectionCard(title: String, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        SectionHeader(title)
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(ZephyrSpacing.lg)) { content() }
        }
    }
}

// ---- sections ----------------------------------------------------------------------------------

@Composable
private fun BasicSection(ui: ConnectionEditorUiState, onIntent: (EditorIntent) -> Unit) {
    val draft = ui.draft
    Field(
        label = stringResource(R.string.editor_field_name),
        value = draft.current.name,
        issue = ui.issueFor("name"),
        onChange = { onIntent(EditorIntent.Name(it)) },
    )

    Spacer(Modifier.height(ZephyrSpacing.md))
    Text(stringResource(R.string.editor_field_protocol), style = ZephyrTheme.typography.caption)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm)) {
        for (protocol in Protocol.entries) {
            FilterChip(
                selected = draft.current.protocol == protocol,
                onClick = { onIntent(EditorIntent.ProtocolChanged(protocol)) },
                label = { Text(protocol.wireName) },
            )
        }
    }
    // The warning stays attached to the choice rather than appearing only at connect time.
    if (draft.current.protocol.isCleartext) {
        Spacer(Modifier.height(ZephyrSpacing.xs))
        CleartextProtocolWarning(draft.current.protocol)
    }

    Spacer(Modifier.height(ZephyrSpacing.md))
    Field(
        label = stringResource(R.string.editor_field_host),
        value = draft.current.host,
        issue = ui.issueFor("host"),
        onChange = { onIntent(EditorIntent.Host(it)) },
    )

    Spacer(Modifier.height(ZephyrSpacing.md))
    Field(
        label = stringResource(R.string.editor_field_port),
        value = draft.current.port.toString(),
        issue = ui.issueFor("port"),
        keyboardType = KeyboardType.Number,
        onChange = { onIntent(EditorIntent.Port(it)) },
    )

    Spacer(Modifier.height(ZephyrSpacing.md))
    Field(
        label = stringResource(R.string.editor_field_username),
        value = draft.current.username,
        issue = ui.issueFor("username"),
        onChange = { onIntent(EditorIntent.Username(it)) },
    )

    if (draft.showsDomainField) {
        Spacer(Modifier.height(ZephyrSpacing.md))
        Field(
            label = stringResource(R.string.editor_field_domain),
            value = draft.current.rdp.domain,
            issue = null,
            onChange = { onIntent(EditorIntent.Rdp(draft.current.rdp.copy(domain = it))) },
        )
    }

    if (draft.showsEncodingField) {
        Spacer(Modifier.height(ZephyrSpacing.md))
        Text(stringResource(R.string.editor_field_encoding), style = ZephyrTheme.typography.caption)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm)) {
            for (encoding in ConnectionDraft.availableEncodings(draft.current.protocol)) {
                FilterChip(
                    selected = draft.current.encoding == encoding,
                    onClick = { onIntent(EditorIntent.Encoding(encoding)) },
                    label = { Text(encoding.wireName) },
                )
            }
        }
    }
}

@Composable
private fun AuthSection(ui: ConnectionEditorUiState, onIntent: (EditorIntent) -> Unit) {
    val draft = ui.draft
    SecretEditor(
        label = stringResource(R.string.editor_field_password),
        stored = draft.original?.password ?: SecretPresence.absent,
        state = draft.password,
        onChange = { onIntent(EditorIntent.Password(it)) },
    )

    if (draft.showsSshKeyField) {
        Spacer(Modifier.height(ZephyrSpacing.md))
        val keyNames = ui.sshKeys.associate { it.id to it.name }
        Selector(
            label = stringResource(R.string.editor_field_ssh_key),
            selectedId = draft.current.sshKeyId,
            options = keyNames,
            issue = ui.issueFor("sshKeyId"),
            onSelect = { onIntent(EditorIntent.SshKeySelected(it)) },
            onRepair = { onIntent(EditorIntent.RepairRoute("sshKeyId")) },
        )

        Spacer(Modifier.height(ZephyrSpacing.md))
        SecretEditor(
            label = stringResource(R.string.editor_field_private_key),
            stored = draft.original?.privateKey ?: SecretPresence.absent,
            state = draft.privateKey,
            multiline = true,
            onChange = { onIntent(EditorIntent.PrivateKey(it)) },
        )
    }
}

@Composable
private fun RouteSection(ui: ConnectionEditorUiState, onIntent: (EditorIntent) -> Unit) {
    val draft = ui.draft
    FlowRow(horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm)) {
        for (mode in ConnectionMode.entries) {
            FilterChip(
                selected = draft.current.connectionMode == mode,
                onClick = { onIntent(EditorIntent.Mode(mode)) },
                label = { Text(modeLabel(mode)) },
            )
        }
    }

    when (draft.current.connectionMode) {
        ConnectionMode.DIRECT -> Unit

        ConnectionMode.PROXY -> {
            Spacer(Modifier.height(ZephyrSpacing.md))
            Selector(
                label = stringResource(R.string.editor_mode_proxy),
                selectedId = draft.current.proxyId,
                options = ui.proxies.associate { it.id to (it.name + " · " + it.host + ":" + it.port) },
                issue = ui.issueFor("proxyId"),
                onSelect = { onIntent(EditorIntent.ProxySelected(it)) },
                onRepair = { onIntent(EditorIntent.RepairRoute("proxyId")) },
            )
        }

        ConnectionMode.JUMP -> {
            Spacer(Modifier.height(ZephyrSpacing.md))
            JumpChainEditor(ui = ui, onIntent = onIntent)
        }
    }
}

/**
 * Ordered jump chain.
 *
 * Reordering uses explicit up/down buttons rather than a drag handle: the chain is at most 8 rows,
 * order is semantically load-bearing, and buttons carry accessibility labels a drag gesture cannot
 * (SCREEN_CATALOG.md 26).
 */
@Composable
private fun JumpChainEditor(ui: ConnectionEditorUiState, onIntent: (EditorIntent) -> Unit) {
    val chain = ui.draft.current.jumpHostIds
    val names = ui.jumpHosts.associate { it.id to it.name }

    Text(
        text = stringResource(R.string.editor_jump_chain, Connection.MAX_JUMP_DEPTH),
        style = ZephyrTheme.typography.caption,
    )
    ui.issueFor("jumpHostIds")?.let { IssueText(it) }

    chain.forEachIndexed { index, id ->
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = (index + 1).toString() + ". " + (names[id] ?: id),
                style = ZephyrTheme.typography.mono,
                modifier = Modifier.weight(1f),
            )
            IconButton(
                onClick = { onIntent(EditorIntent.JumpMoved(index, index - 1)) },
                enabled = index > 0,
            ) {
                Icon(ZephyrIcons.ArrowUp, contentDescription = stringResource(R.string.editor_jump_up))
            }
            IconButton(
                onClick = { onIntent(EditorIntent.JumpMoved(index, index + 1)) },
                enabled = index < chain.size - 1,
            ) {
                Icon(ZephyrIcons.ArrowDown, contentDescription = stringResource(R.string.editor_jump_down))
            }
            IconButton(onClick = { onIntent(EditorIntent.JumpRemoved(id)) }) {
                Icon(ZephyrIcons.Close, contentDescription = stringResource(R.string.editor_jump_remove))
            }
        }
    }

    val addable = ui.jumpHosts.filter { it.id !in chain && it.id in ui.inventory.usableJumpHostIds }
    if (addable.isNotEmpty() && chain.size < Connection.MAX_JUMP_DEPTH) {
        var expanded by remember { mutableStateOf(false) }
        OutlinedButton(onClick = { expanded = true }) {
            Text(stringResource(R.string.editor_jump_add))
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            for (host in addable) {
                DropdownMenuItem(
                    text = { Text(host.name) },
                    onClick = {
                        expanded = false
                        onIntent(EditorIntent.JumpAdded(host.id))
                    },
                )
            }
        }
    }
}

@Composable
private fun RdpChannelSection(ui: ConnectionEditorUiState, onIntent: (EditorIntent) -> Unit) {
    val rdp = ui.draft.current.rdp

    Text(stringResource(R.string.editor_rdp_sound), style = ZephyrTheme.typography.caption)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm)) {
        for (mode in RdpSoundMode.entries) {
            FilterChip(
                selected = rdp.soundMode == mode,
                onClick = { onIntent(EditorIntent.Rdp(rdp.copy(soundMode = mode))) },
                label = { Text(mode.wireName) },
            )
        }
    }

    ToggleRow(stringResource(R.string.editor_rdp_clipboard), rdp.clipboard) {
        onIntent(EditorIntent.Rdp(rdp.copy(clipboard = it)))
    }
    ToggleRow(stringResource(R.string.editor_rdp_microphone), rdp.microphone) {
        onIntent(EditorIntent.Rdp(rdp.copy(microphone = it)))
    }
    ToggleRow(stringResource(R.string.editor_rdp_camera), rdp.camera) {
        onIntent(EditorIntent.Rdp(rdp.copy(camera = it)))
    }
    ToggleRow(stringResource(R.string.editor_rdp_storage), rdp.storage) {
        onIntent(EditorIntent.Rdp(rdp.copy(storage = it)))
    }
    ToggleRow(stringResource(R.string.editor_rdp_location), rdp.location) {
        onIntent(EditorIntent.Rdp(rdp.copy(location = it)))
    }

    Spacer(Modifier.height(ZephyrSpacing.sm))
    Text(
        text = stringResource(R.string.editor_rdp_permission_note),
        style = ZephyrTheme.typography.caption,
        color = ZephyrTheme.palette.onFloatingMuted,
    )
}

@Composable
private fun RdpDisplaySection(ui: ConnectionEditorUiState, onIntent: (EditorIntent) -> Unit) {
    val rdp = ui.draft.current.rdp

    Text(stringResource(R.string.editor_rdp_resolution), style = ZephyrTheme.typography.caption)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm)) {
        for (value in RdpResolution.entries) {
            FilterChip(
                selected = rdp.resolution == value,
                onClick = { onIntent(EditorIntent.Rdp(rdp.copy(resolution = value))) },
                label = { Text(value.wireName) },
            )
        }
    }

    Spacer(Modifier.height(ZephyrSpacing.sm))
    Text(stringResource(R.string.editor_rdp_quality), style = ZephyrTheme.typography.caption)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm)) {
        for (value in RdpQuality.entries) {
            FilterChip(
                selected = rdp.quality == value,
                onClick = { onIntent(EditorIntent.Rdp(rdp.copy(quality = value))) },
                label = { Text(value.wireName) },
            )
        }
    }

    Spacer(Modifier.height(ZephyrSpacing.sm))
    Text(stringResource(R.string.editor_rdp_fps), style = ZephyrTheme.typography.caption)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm)) {
        for (value in RdpFps.entries) {
            FilterChip(
                selected = rdp.fps == value,
                onClick = { onIntent(EditorIntent.Rdp(rdp.copy(fps = value))) },
                label = { Text(value.value.toString()) },
            )
        }
    }

    Spacer(Modifier.height(ZephyrSpacing.sm))
    Text(stringResource(R.string.editor_rdp_touch_mode), style = ZephyrTheme.typography.caption)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm)) {
        for (value in RdpTouchMode.entries) {
            FilterChip(
                selected = rdp.touchMode == value,
                onClick = { onIntent(EditorIntent.Rdp(rdp.copy(touchMode = value))) },
                label = { Text(value.wireName) },
            )
        }
    }

    Spacer(Modifier.height(ZephyrSpacing.sm))
    // The numeric value is in the label because a slider position alone is not readable
    // (SCREEN_CATALOG.md 26 requires progress as a readable value).
    Text(
        text = stringResource(R.string.editor_rdp_sensitivity, rdp.touchSensitivity),
        style = ZephyrTheme.typography.tabularNumeric,
    )
    Slider(
        value = rdp.touchSensitivity,
        onValueChange = {
            onIntent(EditorIntent.Rdp(rdp.copy(touchSensitivity = RdpSettings.clampSensitivity(it))))
        },
        valueRange = RdpSettings.MIN_SENSITIVITY..RdpSettings.MAX_SENSITIVITY,
    )
}

@Composable
private fun FileSyncSection(ui: ConnectionEditorUiState, onIntent: (EditorIntent) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm)) {
        for (intent in FileSyncDirectoryIntent.entries) {
            FilterChip(
                selected = ui.draft.current.fileSyncIntent == intent,
                onClick = { onIntent(EditorIntent.FileSync(intent)) },
                label = { Text(fileSyncLabel(intent)) },
            )
        }
    }
    Spacer(Modifier.height(ZephyrSpacing.sm))
    Text(
        text = stringResource(R.string.editor_file_sync_note),
        style = ZephyrTheme.typography.caption,
        color = ZephyrTheme.palette.onFloatingMuted,
    )
}

@Composable
private fun MetadataSection(ui: ConnectionEditorUiState, onIntent: (EditorIntent) -> Unit) {
    Field(
        label = stringResource(R.string.editor_field_tags),
        value = ui.draft.current.tags.joinToString(","),
        issue = null,
        supporting = stringResource(R.string.editor_field_tags_hint),
        // Split here rather than in the draft so the raw text stays exactly what the user typed
        // until they leave the field; the draft normalises on save.
        onChange = { onIntent(EditorIntent.Tags(it.split(',').map(String::trim))) },
    )

    Spacer(Modifier.height(ZephyrSpacing.md))
    Field(
        label = stringResource(R.string.editor_field_remark),
        value = ui.draft.current.remark,
        issue = null,
        onChange = { onIntent(EditorIntent.Remark(it)) },
    )

    Spacer(Modifier.height(ZephyrSpacing.md))
    Text(stringResource(R.string.editor_field_visibility), style = ZephyrTheme.typography.caption)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm)) {
        for (option in VISIBILITY_OPTIONS) {
            FilterChip(
                selected = ui.draft.current.visibility == option,
                onClick = { onIntent(EditorIntent.Visibility(option)) },
                label = { Text(option) },
            )
        }
    }
}

/**
 * The three fixed actions.
 *
 * Order and presence are frozen by SCREEN_CATALOG.md 6.8. 保存 stays enabled while the form is
 * dirty even if validation would fail, because pressing it is how the user asks to see what is
 * wrong; the ViewModel answers with issues instead of a silent no-op.
 */
@Composable
private fun FixedActions(ui: ConnectionEditorUiState, onIntent: (EditorIntent) -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        ui.testResult?.let { TestResultText(it) }

        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(
                onClick = { onIntent(EditorIntent.Test) },
                enabled = !ui.testing && !ui.saving,
            ) { Text(stringResource(R.string.editor_action_test)) }

            Button(
                onClick = { onIntent(EditorIntent.Save) },
                enabled = !ui.saving,
            ) { Text(stringResource(R.string.editor_action_save)) }
        }

        Spacer(Modifier.height(ZephyrSpacing.sm))
        TextButton(onClick = { onIntent(EditorIntent.ConnectWithoutSaving) }) {
            Text(stringResource(R.string.editor_action_connect_unsaved))
        }
    }
}

@Composable
private fun TestResultText(result: ConnectionTestResult) {
    val palette = ZephyrTheme.palette
    val (text, color) = when (result) {
        is ConnectionTestResult.Reachable ->
            stringResource(R.string.editor_test_reachable, result.roundTripMs) to palette.status.success
        is ConnectionTestResult.Authenticated ->
            stringResource(R.string.editor_test_authenticated, result.roundTripMs) to palette.status.success
        // The structured message and its requestId are shown as-is: a test that failed because the
        // engine is unavailable must not read like a wrong password.
        is ConnectionTestResult.Failed -> result.error.message to palette.status.error
    }
    Text(text, style = ZephyrTheme.typography.caption, color = color)
    if (result is ConnectionTestResult.Failed) {
        Text(result.error.diagnosticText(), style = ZephyrTheme.typography.monoCaption)
    }
    Spacer(Modifier.height(ZephyrSpacing.sm))
}

// ---- reusable pieces ---------------------------------------------------------------------------

@Composable
private fun Field(
    label: String,
    value: String,
    issue: DraftIssue?,
    onChange: (String) -> Unit,
    keyboardType: KeyboardType = KeyboardType.Text,
    supporting: String? = null,
) {
    Column(Modifier.fillMaxWidth()) {
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            modifier = Modifier.fillMaxWidth(),
            label = { Text(label) },
            isError = issue != null,
            singleLine = true,
            supportingText = supporting?.let { { Text(it) } },
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = keyboardType),
        )
        issue?.let { IssueText(it) }
    }
}

@Composable
private fun IssueText(issue: DraftIssue) {
    Text(issue.message, style = ZephyrTheme.typography.caption, color = ZephyrTheme.palette.status.error)
}

/**
 * Secret tri-state.
 *
 * The three modes derive from the [SecretState] the draft already holds, so there is no second
 * source of truth and a masked placeholder can never be mistaken for typed input
 * (ZEPHYR_PARITY.md 5.3). The stored value is described, never rendered.
 */
@Composable
private fun SecretEditor(
    label: String,
    stored: SecretPresence,
    state: SecretState,
    onChange: (SecretState) -> Unit,
    multiline: Boolean = false,
) {
    Column(Modifier.fillMaxWidth()) {
        Text(label, style = ZephyrTheme.typography.caption)
        Text(
            text = ConnectionDraft.presenceFor(state, stored).let {
                if (it.hasValue) SecretPresence.MASK else stringResource(R.string.editor_secret_clear)
            },
            style = ZephyrTheme.typography.mono,
        )

        FlowRow(horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm)) {
            FilterChip(
                selected = state is SecretState.Unchanged,
                onClick = { onChange(SecretState.Unchanged) },
                label = { Text(stringResource(R.string.editor_secret_keep)) },
            )
            FilterChip(
                selected = state is SecretState.Replace,
                onClick = { onChange(SecretState.Replace("")) },
                label = { Text(stringResource(R.string.editor_secret_replace)) },
            )
            FilterChip(
                selected = state is SecretState.Clear,
                onClick = { onChange(SecretState.Clear) },
                label = { Text(stringResource(R.string.editor_secret_clear)) },
            )
        }

        if (state is SecretState.Replace) {
            OutlinedTextField(
                value = state.editingText(),
                onValueChange = { onChange(SecretState.Replace(it)) },
                modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.editor_secret_new_value)) },
                singleLine = !multiline,
                minLines = if (multiline) 4 else 1,
                visualTransformation = if (multiline) {
                    androidx.compose.ui.text.input.VisualTransformation.None
                } else {
                    PasswordVisualTransformation()
                },
            )
        }
    }
}

/**
 * Dependency picker with a repair affordance.
 *
 * When the current selection is not in [options] the row shows the repair action instead of
 * silently rendering an empty selection, which is what SCREEN_CATALOG.md 6 means by
 * "路由需要修复".
 */
@Composable
private fun Selector(
    label: String,
    selectedId: String?,
    options: Map<String, String>,
    issue: DraftIssue?,
    onSelect: (String?) -> Unit,
    onRepair: () -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Text(label, style = ZephyrTheme.typography.caption)
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = { expanded = true }) {
                Text(
                    selectedId?.let { options[it] ?: it }
                        ?: stringResource(R.string.editor_none),
                )
            }
            if (issue != null) {
                Spacer(Modifier.width(ZephyrSpacing.sm))
                AssistChip(
                    onClick = onRepair,
                    label = { Text(stringResource(R.string.editor_route_repair)) },
                )
            }
        }
        issue?.let { IssueText(it) }

        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.editor_none)) },
                onClick = {
                    expanded = false
                    onSelect(null)
                },
            )
            for ((id, name) in options) {
                DropdownMenuItem(
                    text = { Text(name) },
                    onClick = {
                        expanded = false
                        onSelect(id)
                    },
                )
            }
        }
    }
}

@Composable
private fun ToggleRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = ZephyrSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun modeLabel(mode: ConnectionMode): String = when (mode) {
    ConnectionMode.DIRECT -> stringResource(R.string.editor_mode_direct)
    ConnectionMode.PROXY -> stringResource(R.string.editor_mode_proxy)
    ConnectionMode.JUMP -> stringResource(R.string.editor_mode_jump)
}

@Composable
private fun fileSyncLabel(intent: FileSyncDirectoryIntent): String = when (intent) {
    FileSyncDirectoryIntent.OFF -> stringResource(R.string.editor_file_sync_off)
    FileSyncDirectoryIntent.ASK -> stringResource(R.string.editor_file_sync_ask)
    FileSyncDirectoryIntent.LOCAL_SHARE -> stringResource(R.string.editor_file_sync_local_share)
    FileSyncDirectoryIntent.SERVER_BRIDGE -> stringResource(R.string.editor_file_sync_server_bridge)
}

/** Zephyr's connection visibility values. Kept as the wire strings because the server owns them. */
private val VISIBILITY_OPTIONS = listOf("private", "shared_users", "shared_admins", "shared_all")
