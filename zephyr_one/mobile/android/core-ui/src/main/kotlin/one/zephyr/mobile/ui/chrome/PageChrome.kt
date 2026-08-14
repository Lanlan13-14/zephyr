package one.zephyr.mobile.ui.chrome

import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import one.zephyr.mobile.ui.component.Icon
import one.zephyr.mobile.ui.component.Surface
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.component.pressScale
import one.zephyr.mobile.ui.icon.ZephyrIcons
import one.zephyr.mobile.ui.theme.ZephyrMotionTokens
import one.zephyr.mobile.ui.theme.ZephyrTextStyles
import one.zephyr.mobile.ui.theme.ZephyrTheme

/**
 * Frozen page-head geometry from demo.html:
 * `padding: calc(env(safe-area-inset-top) + 14px) 16px 10px`.
 *
 * Root h1 is 23/700. Pushed h1 is 18/700. Back button 36 circular, head-btn 38.
 */
object PageChrome {
    val extraTop: Dp = 14.dp
    val extraBottom: Dp = 10.dp
    val horizontal: Dp = 16.dp
    val actionSize: Dp = 38.dp
    val backSize: Dp = 36.dp
    val actionIcon: Dp = 18.dp
    val titleSize = 23.sp
    val pushedTitleSize = 18.sp
}

@Composable
fun Modifier.pageHeadInsets(includeBottom: Boolean = true): Modifier =
    statusBarsPadding()
        .padding(
            start = PageChrome.horizontal,
            end = PageChrome.horizontal,
            top = PageChrome.extraTop,
            bottom = if (includeBottom) PageChrome.extraBottom else 0.dp,
        )

fun pageHeadTopPaddingDp(statusBarDp: Float): Float = statusBarDp + PageChrome.extraTop.value

@Composable
fun RootPageHeader(
    title: String,
    modifier: Modifier = Modifier,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .pageHeadInsets()
            .heightIn(min = 38.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            text = title,
            color = ZephyrTheme.palette.onBackground,
            style = ZephyrTextStyles.rootTitle,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).semantics { heading() },
        )
        actions()
    }
}

@Composable
fun PushedPageHeader(
    title: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    backDescription: String = "返回",
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .pageHeadInsets()
            .heightIn(min = 38.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        HeaderIconButton(
            description = backDescription,
            onClick = onBack,
            size = PageChrome.backSize,
            pressScale = ZephyrMotionTokens.BACK_PRESS_SCALE,
        ) {
            Icon(ZephyrIcons.Back, contentDescription = null, modifier = Modifier.size(16.dp))
        }
        Text(
            text = title,
            color = ZephyrTheme.palette.onBackground,
            style = ZephyrTextStyles.pushedTitle,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).semantics { heading() },
        )
        actions()
    }
}

@Composable
fun HeaderIconButton(
    description: String,
    onClick: () -> Unit,
    icon: ImageVector = ZephyrIcons.Plus,
    size: Dp = PageChrome.actionSize,
    pressScale: Float = ZephyrMotionTokens.HEAD_PRESS_SCALE,
    content: (@Composable () -> Unit)? = null,
) {
    val interaction = remember { MutableInteractionSource() }
    Surface(
        modifier = Modifier
            .size(size)
            .pressScale(pressScale, true, interaction)
            .clip(CircleShape)
            .semantics { contentDescription = description }
            .clickable(
                role = Role.Button,
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            ),
        shape = CircleShape,
        color = ZephyrTheme.palette.surfaces.elevated,
        contentColor = ZephyrTheme.palette.brand.accent,
    ) {
        Box(contentAlignment = Alignment.Center) {
            if (content != null) content()
            else Icon(icon, contentDescription = null, modifier = Modifier.size(PageChrome.actionIcon))
        }
    }
}

@Composable
fun HeaderAddButton(description: String, onClick: () -> Unit) {
    HeaderIconButton(description = description, onClick = onClick, icon = ZephyrIcons.Plus)
}

@Composable
fun PushedPageActionBar(
    modifier: Modifier = Modifier,
    content: @Composable RowScope.() -> Unit,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(ZephyrTheme.palette.surfaces.floating),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(ZephyrTheme.palette.surfaces.outlineSoft),
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
            content = content,
        )
    }
}
