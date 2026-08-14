package one.zephyr.mobile.ui.state

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import one.zephyr.mobile.model.EmptyReason
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.ui.R
import one.zephyr.mobile.ui.component.CircularProgressIndicator
import one.zephyr.mobile.ui.component.Icon
import one.zephyr.mobile.ui.component.OutlinedButton
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.format.RelativeTime
import one.zephyr.mobile.ui.icon.ZephyrIcons
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTextStyles
import one.zephyr.mobile.ui.theme.ZephyrTheme

@Composable
fun <T> PageStateScaffold(
    state: PageState<T>,
    modifier: Modifier = Modifier,
    onRetry: (() -> Unit)? = null,
    onUpgrade: (() -> Unit)? = null,
    content: @Composable (T) -> Unit,
) {
    val nowMs = System.currentTimeMillis()
    when (state) {
        PageState.InitialLoading -> CenteredStatus(modifier) {
            CircularProgressIndicator()
            Spacer(Modifier.height(ZephyrSpacing.lg))
            Text(stringResource(R.string.state_loading), textAlign = TextAlign.Center)
        }

        is PageState.Content -> Column(modifier.fillMaxSize()) {
            if (state.conflict) StateBanner(stringResource(R.string.state_conflict), ZephyrTheme.palette.status.conflict)
            if (state.pendingSync) StateBanner(stringResource(R.string.state_pending_sync), ZephyrTheme.palette.status.pendingSync)
            if (state.savingLocal) StateBanner(stringResource(R.string.state_saving_local), ZephyrTheme.palette.status.pendingSync)
            content(state.value)
        }

        is PageState.Empty -> CenteredStatus(modifier) {
            val icon = when (state.reason) {
                EmptyReason.NO_MATCHING_FILTER -> ZephyrIcons.Search
                else -> ZephyrIcons.Inbox
            }
            StatusIcon(icon)
            Spacer(Modifier.height(ZephyrSpacing.lg))
            Text(
                text = when (state.reason) {
                    EmptyReason.NO_DATA -> stringResource(R.string.state_empty_no_data)
                    EmptyReason.NO_MATCHING_FILTER -> stringResource(R.string.state_empty_filtered)
                    EmptyReason.NOT_YET_SYNCED -> stringResource(R.string.state_empty_not_synced)
                },
                textAlign = TextAlign.Center,
            )
        }

        is PageState.OfflineWithCache -> Column(modifier.fillMaxSize()) {
            StateBanner(
                text = state.lastSyncedAt?.let { syncedAt ->
                    stringResource(R.string.state_offline_cached_at, RelativeTime.format(nowMs, syncedAt))
                } ?: stringResource(R.string.state_offline_cached),
                color = ZephyrTheme.palette.status.offline,
            )
            content(state.value)
        }

        PageState.OfflineNoCache -> CenteredStatus(modifier) {
            StatusIcon(ZephyrIcons.CloudOff)
            Spacer(Modifier.height(ZephyrSpacing.lg))
            Text(stringResource(R.string.state_offline_no_cache), textAlign = TextAlign.Center)
        }

        is PageState.PermissionDenied -> CenteredStatus(modifier) {
            StatusIcon(ZephyrIcons.Lock)
            Spacer(Modifier.height(ZephyrSpacing.lg))
            Text(
                text = stringResource(R.string.state_permission_denied, state.missing.wireName),
                textAlign = TextAlign.Center,
            )
            state.reason?.let {
                Spacer(Modifier.height(ZephyrSpacing.sm))
                Text(it, textAlign = TextAlign.Center)
            }
        }

        PageState.NotFoundOrRevoked -> CenteredStatus(modifier) {
            StatusIcon(ZephyrIcons.Error)
            Spacer(Modifier.height(ZephyrSpacing.lg))
            Text(stringResource(R.string.state_not_found), textAlign = TextAlign.Center)
        }

        is PageState.RetryableError -> CenteredStatus(modifier) {
            StatusIcon(ZephyrIcons.Error, ZephyrTheme.palette.status.error)
            Spacer(Modifier.height(ZephyrSpacing.lg))
            Text(state.error.message, textAlign = TextAlign.Center)
            Spacer(Modifier.height(ZephyrSpacing.md))
            DiagnosticsRow(state.error)
            if (onRetry != null) {
                Spacer(Modifier.height(ZephyrSpacing.lg))
                OutlinedButton(onClick = onRetry) { Text(stringResource(R.string.action_retry)) }
            }
        }

        is PageState.FatalIncompatible -> CenteredStatus(modifier) {
            StatusIcon(ZephyrIcons.SystemUpdate, ZephyrTheme.palette.status.error)
            Spacer(Modifier.height(ZephyrSpacing.lg))
            Text(stringResource(R.string.state_fatal_incompatible), textAlign = TextAlign.Center)
            Spacer(Modifier.height(ZephyrSpacing.md))
            DiagnosticsRow(state.error)
            if (onUpgrade != null) {
                Spacer(Modifier.height(ZephyrSpacing.lg))
                OutlinedButton(onClick = onUpgrade) { Text(stringResource(R.string.action_check_update)) }
            }
        }
    }
}

@Composable
private fun DiagnosticsRow(error: MobileError) {
    val clipboard = LocalClipboardManager.current
    val text = error.diagnosticText()
    var copied by remember(text) { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = ZephyrTextStyles.monoCaption)
        Spacer(Modifier.width(ZephyrSpacing.sm))
        OutlinedButton(
            onClick = {
                clipboard.setText(AnnotatedString(text))
                copied = true
            },
        ) {
            Text(
                text = if (copied) {
                    stringResource(R.string.action_copied)
                } else {
                    stringResource(R.string.action_copy_diagnostics)
                },
            )
        }
    }
}

@Composable
private fun StatusIcon(icon: ImageVector, tint: Color = ZephyrTheme.palette.onFloatingMuted) {
    Icon(imageVector = icon, contentDescription = null, tint = tint, modifier = Modifier.size(40.dp))
}

@Composable
private fun CenteredStatus(modifier: Modifier, content: @Composable () -> Unit) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .padding(ZephyrSpacing.xl)
            .semantics { liveRegion = LiveRegionMode.Polite },
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            content = { content() },
        )
    }
}

@Composable
private fun StateBanner(text: String, color: Color) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = ZephyrSpacing.lg, vertical = ZephyrSpacing.sm)
            .semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Canvas(Modifier.size(8.dp)) { drawCircle(color) }
        Spacer(Modifier.width(ZephyrSpacing.sm))
        Text(text, style = ZephyrTextStyles.caption)
    }
}
