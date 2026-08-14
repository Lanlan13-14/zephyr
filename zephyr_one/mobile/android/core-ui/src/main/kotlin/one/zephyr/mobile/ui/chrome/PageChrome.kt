package one.zephyr.mobile.ui.chrome

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import one.zephyr.mobile.ui.theme.ZephyrTheme

/**
 * Frozen page-head geometry from demo.html:
 * `padding: calc(env(safe-area-inset-top) + 14px) 16px 10px`.
 *
 * Every root and pushed screen must go through this rather than inventing its own top padding.
 * The previous screens only used a 14.dp top gap and ignored the status bar, so the title sat
 * under the system clock / battery on a real device.
 */
object PageChrome {
    val extraTop: Dp = 14.dp
    val extraBottom: Dp = 10.dp
    val horizontal: Dp = 16.dp
    val actionSize: Dp = 38.dp
    val actionIcon: Dp = 18.dp
    val titleSize = 23.sp
}

/** Status-bar inset plus the frozen 14.dp head padding. */
@Composable
fun Modifier.pageHeadInsets(includeBottom: Boolean = true): Modifier =
    statusBarsPadding()
        .padding(
            start = PageChrome.horizontal,
            end = PageChrome.horizontal,
            top = PageChrome.extraTop,
            bottom = if (includeBottom) PageChrome.extraBottom else 0.dp,
        )

/** Exposed for JVM tests that cannot read WindowInsets. */
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
            fontSize = PageChrome.titleSize,
            fontWeight = FontWeight.Bold,
            letterSpacing = (-0.4).sp,
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
        HeaderIconButton(description = backDescription, onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null, modifier = Modifier.size(PageChrome.actionIcon))
        }
        Text(
            text = title,
            color = ZephyrTheme.palette.onBackground,
            fontSize = PageChrome.titleSize,
            fontWeight = FontWeight.Bold,
            letterSpacing = (-0.4).sp,
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
    icon: ImageVector = Icons.Filled.Add,
    content: (@Composable () -> Unit)? = null,
) {
    Surface(
        modifier = Modifier
            .size(PageChrome.actionSize)
            .semantics { contentDescription = description }
            .clickable(role = Role.Button, onClick = onClick),
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
    HeaderIconButton(description = description, onClick = onClick, icon = Icons.Filled.Add)
}
