package one.zephyr.mobile.ui.state

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.SearchOff
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import one.zephyr.mobile.model.EmptyReason
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.ui.R
import one.zephyr.mobile.ui.format.RelativeTime
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme

/**
 * Renders the frozen page-state contract.
 *
 * SCREEN_CATALOG.md 2 defines nine states, and MOBILE_EXPERIENCE.md 6 makes a vague "失败" toast an
 * explicit anti-pattern. Centralising the branches here is what guarantees a screen cannot ship with
 * only "loading" and "content": if a screen has a [PageState], every state already has a real
 * rendering, including the requestId the user needs to report a failure.
 *
 * @param onRetry invoked for the retryable branch only; the terminal states deliberately offer no
 *   retry, because retrying a revoked resource or an incompatible protocol cannot succeed.
 */
@Composable
fun <T> PageStateScaffold(
    state: PageState<T>,
    modifier: Modifier = Modifier,
    onRetry: (() -> Unit)? = null,
    onUpgrade: (() -> Unit)? = null,
    content: @Composable (T) -> Unit,
) {
    // Read here rather than taken as a parameter: every caller would otherwise have to thread a
    // clock through purely so one banner can say how old the mirror is.
    val nowMs = System.currentTimeMillis()
    when (state) {
        PageState.InitialLoading -> CenteredStatus(modifier) {
            CircularProgressIndicator()
            Spacer(Modifier.height(ZephyrSpacing.lg))
            Text(stringResource(R.string.state_loading), textAlign = TextAlign.Center)
        }

        is PageState.Content -> Column(modifier.fillMaxSize()) {
            // Banners sit above the content rather than replacing it: a pending write or an open
            // conflict must not hide the data the user is looking at.
            if (state.conflict) StateBanner(stringResource(R.string.state_conflict), ZephyrTheme.palette.status.conflict)
            if (state.pendingSync) StateBanner(stringResource(R.string.state_pending_sync), ZephyrTheme.palette.status.pendingSync)
            if (state.savingLocal) StateBanner(stringResource(R.string.state_saving_local), ZephyrTheme.palette.status.pendingSync)
            content(state.value)
        }

        is PageState.Empty -> CenteredStatus(modifier) {
            val icon = when (state.reason) {
                EmptyReason.NO_MATCHING_FILTER -> Icons.Filled.SearchOff
                else -> Icons.Filled.Inbox
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
            // Owned data has a local mirror, so offline shows the cache with its age rather than an
            // error (SHARED_RESOURCE_RESIDENCY.md 3).
            StateBanner(
                text = state.lastSyncedAt?.let { syncedAt ->
                    stringResource(R.string.state_offline_cached_at, RelativeTime.format(nowMs, syncedAt))
                }
                    ?: stringResource(R.string.state_offline_cached),
                color = ZephyrTheme.palette.status.offline,
            )
            content(state.value)
        }

        // Shared-to-me data has no mirror by design, so offline is terminal for it.
        PageState.OfflineNoCache -> CenteredStatus(modifier) {
            StatusIcon(Icons.Filled.CloudOff)
            Spacer(Modifier.height(ZephyrSpacing.lg))
            Text(stringResource(R.string.state_offline_no_cache), textAlign = TextAlign.Center)
        }

        is PageState.PermissionDenied -> CenteredStatus(modifier) {
            StatusIcon(Icons.Filled.Lock)
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
            StatusIcon(Icons.Filled.ErrorOutline)
            Spacer(Modifier.height(ZephyrSpacing.lg))
            Text(stringResource(R.string.state_not_found), textAlign = TextAlign.Center)
        }

        is PageState.RetryableError -> CenteredStatus(modifier) {
            StatusIcon(Icons.Filled.ErrorOutline, ZephyrTheme.palette.status.error)
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
            StatusIcon(Icons.Filled.SystemUpdate, ZephyrTheme.palette.status.error)
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

/**
 * Copyable diagnostics.
 *
 * Only code, status and requestId, per DIAGNOSTICS redaction: enough for the server operator to find
 * the request in a log, with no host, path, username or secret.
 */
@Composable
private fun DiagnosticsRow(error: MobileError) {
    val clipboard = LocalClipboardManager.current
    val text = error.diagnosticText()
    // Android 13+ shows its own clipboard toast, older releases show nothing at all, so the button
    // confirms in place. Without it a user on API 26..32 cannot tell whether the copy happened.
    var copied by remember(text) { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = ZephyrTheme.typography.monoCaption)
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
private fun StatusIcon(icon: ImageVector, tint: androidx.compose.ui.graphics.Color = ZephyrTheme.palette.onFloatingMuted) {
    Icon(imageVector = icon, contentDescription = null, tint = tint, modifier = Modifier.size(40.dp))
}

@Composable
private fun CenteredStatus(modifier: Modifier, content: @Composable () -> Unit) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .padding(ZephyrSpacing.xl)
            // Announced to TalkBack when it appears, so a state change is not silent for a screen
            // reader user.
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
private fun StateBanner(text: String, color: androidx.compose.ui.graphics.Color) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = ZephyrSpacing.lg, vertical = ZephyrSpacing.sm)
            .semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(8.dp).padding(0.dp)) {
            androidx.compose.foundation.Canvas(Modifier.fillMaxSize()) { drawCircle(color) }
        }
        Spacer(Modifier.width(ZephyrSpacing.sm))
        Text(text, style = ZephyrTheme.typography.caption)
    }
}
