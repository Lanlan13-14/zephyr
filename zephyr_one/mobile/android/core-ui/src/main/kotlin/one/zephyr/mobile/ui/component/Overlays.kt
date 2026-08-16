package one.zephyr.mobile.ui.component

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import android.view.ViewGroup
import android.view.WindowManager
import kotlinx.coroutines.delay
import one.zephyr.mobile.ui.theme.ProvideContentColor
import one.zephyr.mobile.ui.theme.ZephyrMotionTokens
import one.zephyr.mobile.ui.theme.ZephyrRadius
import one.zephyr.mobile.ui.theme.ZephyrTextStyles
import one.zephyr.mobile.ui.theme.ZephyrTheme

data class ActionSheetItem(
    val label: String,
    val subtitle: String? = null,
    val danger: Boolean = false,
    val cancel: Boolean = false,
    val enabled: Boolean = true,
    val onClick: () -> Unit,
)

data class ActionSheetGroup(
    val title: String? = null,
    val items: List<ActionSheetItem>,
)

/**
 * Demo `#action-sheet`: left/right 10, bottom safe+10, groups with chrome blur,
 * 50px rows, 420ms drawer ease, cancel group last.
 */
@Composable
fun ActionSheet(
    visible: Boolean,
    onDismiss: () -> Unit,
    groups: List<ActionSheetGroup>,
    modifier: Modifier = Modifier,
) {
    if (!visible && groups.isEmpty()) return
    val motion = ZephyrTheme.motion
    val shown = visible
    val palette = ZephyrTheme.palette
    val scrim by animateFloatAsState(
        targetValue = if (shown) 1f else 0f,
        animationSpec = tween(motion.scale(ZephyrMotionTokens.MED_MS)),
        label = "sheetScrim",
    )
    val slide by animateFloatAsState(
        targetValue = if (shown) 0f else 1f,
        animationSpec = tween(motion.scale(ZephyrMotionTokens.SHEET_MS), easing = ZephyrMotionTokens.easeDrawer),
        label = "sheetSlide",
    )
    if (scrim == 0f && !shown) return

    Box(modifier.fillMaxSize()) {
        Box(
            Modifier
                .fillMaxSize()
                .graphicsLayer { alpha = scrim }
                .background(palette.surfaces.scrim)
                .clickable(
                    indication = null,
                    interactionSource = remember { MutableInteractionSource() },
                    onClick = onDismiss,
                ),
        )
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .graphicsLayer { translationY = size.height * slide }
                .padding(start = 10.dp, end = 10.dp, bottom = 10.dp)
                .navigationBarsPadding()
                .fillMaxWidth()
                .heightIn(max = 640.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            groups.forEach { group ->
                Column(
                    Modifier
                        .fillMaxWidth()
                        .padding(bottom = 8.dp)
                        .clip(RoundedCornerShape(ZephyrRadius.lg))
                        .background(palette.surfaces.floating),
                ) {
                    if (group.title != null) {
                        Text(
                            text = group.title,
                            style = ZephyrTextStyles.chip,
                            color = palette.onFloatingMuted,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 10.dp, start = 16.dp, end = 16.dp),
                        )
                        Box(Modifier.fillMaxWidth().height(1.dp).background(palette.surfaces.outlineSoft))
                    }
                    group.items.forEachIndexed { index, item ->
                        val color = when {
                            item.danger -> palette.status.error
                            else -> palette.onBackground
                        }
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 50.dp)
                                .clickable(enabled = item.enabled, role = Role.Button) {
                                    item.onClick()
                                    onDismiss()
                                }
                                .padding(horizontal = 14.dp, vertical = 6.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = item.label,
                                style = if (item.cancel) ZephyrTextStyles.sheetItem.copy(fontWeight = FontWeight.Bold) else ZephyrTextStyles.sheetItem,
                                color = color,
                                textAlign = TextAlign.Center,
                            )
                            if (item.subtitle != null) {
                                Text(
                                    text = item.subtitle,
                                    style = ZephyrTextStyles.caption,
                                    color = palette.onFloatingSubtle,
                                    textAlign = TextAlign.Center,
                                )
                            }
                        }
                        if (index != group.items.lastIndex) {
                            Box(Modifier.fillMaxWidth().height(1.dp).background(palette.surfaces.outlineSoft))
                        }
                    }
                }
            }
        }
    }
}

/** Demo `.toast`: chrome pill, 300ms ease-out, above the island. */
@Composable
fun ZephyrToast(
    message: String?,
    modifier: Modifier = Modifier,
    onDismiss: () -> Unit = {},
) {
    val visible = !message.isNullOrBlank()
    val motion = ZephyrTheme.motion
    val palette = ZephyrTheme.palette
    val alpha by animateFloatAsState(
        targetValue = if (visible) 1f else 0f,
        animationSpec = tween(motion.scale(ZephyrMotionTokens.TOAST_MS), easing = ZephyrMotionTokens.easeOut),
        label = "toastAlpha",
    )
    val lift by animateFloatAsState(
        targetValue = if (visible) 0f else 20f,
        animationSpec = tween(motion.scale(ZephyrMotionTokens.TOAST_MS), easing = ZephyrMotionTokens.easeOut),
        label = "toastLift",
    )
    LaunchedEffect(message) {
        if (message.isNullOrBlank()) return@LaunchedEffect
        delay(2_200)
        onDismiss()
    }
    if (alpha == 0f && !visible) return
    Box(
        modifier
            .padding(bottom = 110.dp)
            .graphicsLayer {
                this.alpha = alpha
                translationY = lift
            }
            .clip(RoundedCornerShape(22.dp))
            .background(palette.surfaces.floating)
            .padding(horizontal = 18.dp, vertical = 11.dp),
    ) {
        Text(
            text = message.orEmpty(),
            style = ZephyrTextStyles.body.copy(fontWeight = FontWeight.SemiBold),
            color = palette.onBackground,
            maxLines = 2,
        )
    }
}

class ZephyrToastHostState {
    var message: String? = null
        private set

    fun show(text: String) {
        message = text
    }

    fun clear() {
        message = null
    }
}

/**
 * Confirmation that looks like the demo action sheet, not a Material dialog.
 * Kept as `AlertDialog` so existing call sites only change the import.
 *
 * The platform Dialog is WRAP_CONTENT. Stretching it to MATCH_PARENT and
 * measuring against the *window* (not the wrap height) is what keeps the
 * cancel group on screen for SSH / RDP / VNC host-key prompts.
 */
@Composable
fun AlertDialog(
    onDismissRequest: () -> Unit,
    confirmButton: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    dismissButton: (@Composable () -> Unit)? = null,
    title: (@Composable () -> Unit)? = null,
    text: (@Composable () -> Unit)? = null,
) {
    val palette = ZephyrTheme.palette
    val sheetColor = Color(AlertDialogLayout.sheetArgb(palette.dark))
    Dialog(
        onDismissRequest = onDismissRequest,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        val composeView = LocalView.current
        val configuration = LocalConfiguration.current
        val screenWidthDp = configuration.screenWidthDp
        val screenHeightDp = configuration.screenHeightDp.toFloat()
        SideEffect {
            val window = (composeView.parent as? DialogWindowProvider)?.window ?: return@SideEffect
            window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            window.setBackgroundDrawableResource(android.R.color.transparent)
            window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        }
        BoxWithConstraints(
            modifier = modifier
                .width(screenWidthDp.dp)
                .height(screenHeightDp.dp)
                .background(palette.surfaces.scrim)
                .imePadding()
                .clickable(
                    indication = null,
                    interactionSource = remember { MutableInteractionSource() },
                    onClick = onDismissRequest,
                ),
            contentAlignment = Alignment.BottomCenter,
        ) {
            val windowHeightDp = maxOf(screenHeightDp, maxHeight.value)
            val availableHeight = AlertDialogLayout.availableHeightDp(windowHeightDp).dp
            Column(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = availableHeight)
                    .padding(start = 10.dp, end = 10.dp, bottom = 10.dp)
                    .navigationBarsPadding()
                    .clickable(indication = null, interactionSource = remember { MutableInteractionSource() }) {},
            ) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .weight(1f, fill = false)
                        .clip(RoundedCornerShape(ZephyrRadius.lg))
                        .background(sheetColor),
                ) {
                    if (title != null) {
                        Box(
                            Modifier.fillMaxWidth().padding(top = 16.dp, start = 20.dp, end = 20.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            ProvideContentColor(palette.onBackground, title)
                        }
                    }
                    if (text != null) {
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .weight(1f, fill = false)
                                .verticalScroll(rememberScrollState())
                                .padding(horizontal = 20.dp, vertical = 8.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            ProvideContentColor(palette.onFloatingMuted, text)
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 50.dp)
                            .clickable(role = Role.Button) { /* confirm button owns the click */ },
                        contentAlignment = Alignment.Center,
                    ) {
                        ProvideContentColor(palette.status.error, confirmButton)
                    }
                }
                if (dismissButton != null) {
                    Spacer(Modifier.height(8.dp))
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(ZephyrRadius.lg))
                            .background(sheetColor)
                            .heightIn(min = 50.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        ProvideContentColor(palette.onBackground, dismissButton)
                    }
                }
            }
        }
    }
}

@Composable
fun BoxScope.DemoToastHost(message: String?, onDismiss: () -> Unit) {
    ZephyrToast(message = message, modifier = Modifier.align(Alignment.BottomCenter), onDismiss = onDismiss)
}
