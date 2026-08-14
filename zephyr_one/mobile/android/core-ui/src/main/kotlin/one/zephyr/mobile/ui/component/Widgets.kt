package one.zephyr.mobile.ui.component

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import one.zephyr.mobile.ui.icon.ZephyrIcons
import one.zephyr.mobile.ui.theme.ProvideContentColor
import one.zephyr.mobile.ui.theme.ZephyrMotionTokens
import one.zephyr.mobile.ui.theme.ZephyrRadius
import one.zephyr.mobile.ui.theme.ZephyrTextStyles
import one.zephyr.mobile.ui.theme.ZephyrTheme
import one.zephyr.mobile.ui.theme.resolvedContentColor

@Composable
fun Text(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = Color.Unspecified,
    fontSize: TextUnit = TextUnit.Unspecified,
    fontWeight: FontWeight? = null,
    fontFamily: FontFamily? = null,
    letterSpacing: TextUnit = TextUnit.Unspecified,
    textAlign: TextAlign? = null,
    overflow: TextOverflow = TextOverflow.Clip,
    maxLines: Int = Int.MAX_VALUE,
    minLines: Int = 1,
    style: TextStyle = ZephyrTextStyles.body,
) {
    val fallback = resolvedContentColor(ZephyrTheme.palette.onBackground)
    val resolved = style.merge(
        TextStyle(
            color = if (color == Color.Unspecified) fallback else color,
            fontSize = fontSize,
            fontWeight = fontWeight,
            fontFamily = fontFamily,
            letterSpacing = letterSpacing,
            textAlign = textAlign ?: TextAlign.Unspecified,
        ),
    )
    BasicText(
        text = text,
        modifier = modifier,
        style = resolved,
        overflow = overflow,
        maxLines = maxLines,
        minLines = minLines,
    )
}

@Composable
fun Text(
    text: androidx.compose.ui.text.AnnotatedString,
    modifier: Modifier = Modifier,
    color: Color = Color.Unspecified,
    overflow: TextOverflow = TextOverflow.Clip,
    maxLines: Int = Int.MAX_VALUE,
    minLines: Int = 1,
    softWrap: Boolean = true,
    style: TextStyle = ZephyrTextStyles.body,
) {
    val fallback = resolvedContentColor(ZephyrTheme.palette.onBackground)
    val resolved = if (color == Color.Unspecified) {
        style.merge(TextStyle(color = fallback))
    } else {
        style.merge(TextStyle(color = color))
    }
    BasicText(
        text = text,
        modifier = modifier,
        style = resolved,
        overflow = overflow,
        maxLines = maxLines,
        minLines = minLines,
        softWrap = softWrap,
    )
}

@Composable
fun Icon(
    imageVector: ImageVector,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    tint: Color = Color.Unspecified,
) {
    val resolved = if (tint == Color.Unspecified) {
        resolvedContentColor(ZephyrTheme.palette.onBackground)
    } else {
        tint
    }
    Image(
        painter = rememberVectorPainter(imageVector),
        contentDescription = contentDescription,
        modifier = modifier,
        contentScale = ContentScale.Fit,
        colorFilter = ColorFilter.tint(resolved),
    )
}

@Composable
fun Surface(
    modifier: Modifier = Modifier,
    shape: androidx.compose.ui.graphics.Shape = RoundedCornerShape(0.dp),
    color: Color = ZephyrTheme.palette.surfaces.content,
    contentColor: Color = ZephyrTheme.palette.onBackground,
    border: androidx.compose.foundation.BorderStroke? = null,
    content: @Composable () -> Unit,
) {
    Box(
        modifier = modifier
            .clip(shape)
            .background(color)
            .then(if (border != null) Modifier.border(border, shape) else Modifier),
    ) {
        ProvideContentColor(contentColor, content)
    }
}

@Composable
fun Chip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val palette = ZephyrTheme.palette
    val interaction = remember { MutableInteractionSource() }
    Box(
        modifier = modifier
            .pressScale(ZephyrMotionTokens.CHIP_PRESS_SCALE, enabled, interaction)
            .heightIn(min = 28.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(if (selected) palette.brand.accent else palette.surfaces.elevated)
            .clickable(
                enabled = enabled,
                role = Role.Button,
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = 13.dp, vertical = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = if (selected) Color.White else palette.onFloatingMuted,
            style = ZephyrTextStyles.chip,
            maxLines = 1,
        )
    }
}

@Composable
fun FilterChip(
    selected: Boolean,
    onClick: () -> Unit,
    label: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val palette = ZephyrTheme.palette
    val interaction = remember { MutableInteractionSource() }
    val content = if (selected) Color.White else palette.onFloatingMuted
    Box(
        modifier = modifier
            .pressScale(ZephyrMotionTokens.CHIP_PRESS_SCALE, enabled, interaction)
            .heightIn(min = 28.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(if (selected) palette.brand.accent else palette.surfaces.elevated)
            .clickable(
                enabled = enabled,
                role = Role.Button,
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = 13.dp, vertical = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        ProvideContentColor(content, label)
    }
}

@Composable
fun AssistChip(
    onClick: () -> Unit,
    label: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    FilterChip(selected = false, onClick = onClick, label = label, modifier = modifier, enabled = enabled)
}

@Composable
fun SegmentedControl(
    options: List<String>,
    selectedIndex: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = ZephyrTheme.palette
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(9.dp))
            .background(palette.surfaces.elevated)
            .padding(2.dp),
    ) {
        options.forEachIndexed { index, label ->
            val on = index == selectedIndex
            Box(
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(7.dp))
                    .background(if (on) palette.surfaces.content else Color.Transparent)
                    .clickable(role = Role.Button) { onSelect(index) }
                    .padding(vertical = 5.dp, horizontal = 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = label,
                    style = ZephyrTextStyles.chip.copy(fontWeight = FontWeight.SemiBold),
                    color = if (on) palette.onBackground else palette.onFloatingMuted,
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
fun ZephyrToggle(
    checked: Boolean,
    onCheckedChange: ((Boolean) -> Unit)?,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val palette = ZephyrTheme.palette
    val track = if (checked) palette.status.success else palette.status.offline
    Box(
        modifier = modifier
            .size(width = 46.dp, height = 28.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(if (enabled) track else track.copy(alpha = 0.45f))
            .clickable(enabled = enabled && onCheckedChange != null, role = Role.Switch) {
                onCheckedChange?.invoke(!checked)
            },
    ) {
        Box(
            modifier = Modifier
                .align(Alignment.CenterStart)
                .padding(start = if (checked) 20.dp else 3.dp)
                .size(23.dp)
                .clip(CircleShape)
                .background(Color.White),
        )
    }
}

@Composable
fun Switch(
    checked: Boolean,
    onCheckedChange: ((Boolean) -> Unit)?,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    ZephyrToggle(checked, onCheckedChange, modifier, enabled)
}

@Composable
fun ZephyrCheckbox(
    checked: Boolean,
    onCheckedChange: ((Boolean) -> Unit)?,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val palette = ZephyrTheme.palette
    Box(
        modifier = modifier
            .size(22.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(if (checked) palette.brand.accent else palette.surfaces.elevated)
            .border(
                width = 1.dp,
                color = if (checked) palette.brand.accent else palette.surfaces.outline,
                shape = RoundedCornerShape(6.dp),
            )
            .clickable(enabled = enabled && onCheckedChange != null, role = Role.Checkbox) {
                onCheckedChange?.invoke(!checked)
            },
        contentAlignment = Alignment.Center,
    ) {
        if (checked) {
            Icon(ZephyrIcons.Check, contentDescription = null, tint = Color.White, modifier = Modifier.size(14.dp))
        }
    }
}

@Composable
fun Checkbox(
    checked: Boolean,
    onCheckedChange: ((Boolean) -> Unit)?,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    ZephyrCheckbox(checked, onCheckedChange, modifier, enabled)
}

@Composable
fun GroupCard(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val palette = ZephyrTheme.palette
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(ZephyrRadius.md))
            .background(palette.surfaces.content)
            .border(1.dp, palette.surfaces.outlineSoft, RoundedCornerShape(ZephyrRadius.md)),
        content = content,
    )
}

@Composable
fun SettingsRow(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    value: String? = null,
    showChevron: Boolean = false,
    selected: Boolean = false,
    showDivider: Boolean = true,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val palette = ZephyrTheme.palette
    Column(modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 50.dp)
                .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(title, style = ZephyrTextStyles.row, color = palette.onBackground)
                if (subtitle != null) {
                    Text(
                        subtitle,
                        style = ZephyrTextStyles.hint,
                        color = palette.onFloatingSubtle,
                        modifier = Modifier.padding(top = 2.dp),
                    )
                }
            }
            if (value != null) {
                Text(value, style = ZephyrTextStyles.chip, color = palette.onFloatingMuted)
                Spacer(Modifier.width(6.dp))
            }
            if (selected) {
                Icon(ZephyrIcons.Check, contentDescription = null, tint = palette.brand.accent, modifier = Modifier.size(18.dp))
            }
            if (trailing != null) trailing()
            if (showChevron) {
                Icon(ZephyrIcons.Chevron, contentDescription = null, tint = palette.onFloatingSubtle, modifier = Modifier.size(16.dp))
            }
        }
        if (showDivider) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(palette.surfaces.outlineSoft))
        }
    }
}

@Composable
fun FieldRow(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    mono: Boolean = false,
    singleLine: Boolean = true,
    placeholder: String = "",
    visualTransformation: VisualTransformation = VisualTransformation.None,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    showDivider: Boolean = true,
) {
    val palette = ZephyrTheme.palette
    Column(modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = label,
                style = ZephyrTextStyles.caption,
                color = palette.onFloatingMuted,
                modifier = Modifier.width(72.dp),
            )
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = singleLine,
                textStyle = (if (mono) ZephyrTextStyles.mono else ZephyrTextStyles.body).copy(color = palette.onBackground),
                cursorBrush = SolidColor(palette.brand.accent),
                visualTransformation = visualTransformation,
                keyboardOptions = keyboardOptions,
                modifier = Modifier.weight(1f),
                decorationBox = { inner ->
                    Box {
                        if (value.isEmpty() && placeholder.isNotEmpty()) {
                            Text(placeholder, style = ZephyrTextStyles.body, color = palette.onFloatingSubtle)
                        }
                        inner()
                    }
                },
            )
        }
        if (showDivider) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(palette.surfaces.outlineSoft))
        }
    }
}

@Composable
fun OutlinedTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    readOnly: Boolean = false,
    label: (@Composable () -> Unit)? = null,
    placeholder: (@Composable () -> Unit)? = null,
    supportingText: (@Composable () -> Unit)? = null,
    isError: Boolean = false,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    singleLine: Boolean = false,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else Int.MAX_VALUE,
    textStyle: TextStyle = ZephyrTextStyles.body,
) {
    val palette = ZephyrTheme.palette
    Column(modifier) {
        if (label != null) {
            Box(Modifier.padding(bottom = 6.dp)) { label() }
        }
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            readOnly = readOnly,
            singleLine = singleLine,
            minLines = minLines,
            maxLines = maxLines,
            textStyle = textStyle.merge(TextStyle(color = palette.onBackground)),
            cursorBrush = SolidColor(if (isError) palette.status.error else palette.brand.accent),
            visualTransformation = visualTransformation,
            keyboardOptions = keyboardOptions,
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(ZephyrRadius.sm))
                .background(palette.surfaces.elevated)
                .padding(horizontal = 12.dp, vertical = 10.dp),
            decorationBox = { inner ->
                Box {
                    if (value.isEmpty() && placeholder != null) placeholder()
                    inner()
                }
            },
        )
        if (supportingText != null) {
            Box(Modifier.padding(top = 4.dp)) { supportingText() }
        }
    }
}

@Composable
fun PrimaryButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    ghost: Boolean = false,
    content: @Composable RowScope.() -> Unit,
) {
    val palette = ZephyrTheme.palette
    val interaction = remember { MutableInteractionSource() }
    val contentColor = when {
        !enabled -> palette.onFloatingSubtle
        ghost -> palette.onFloatingMuted
        else -> Color.White
    }
    Box(
        modifier = modifier
            .pressScale(0.97f, enabled, interaction)
            .height(42.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(
                when {
                    !enabled -> palette.surfaces.elevated
                    ghost -> palette.surfaces.elevated
                    else -> palette.brand.accent
                },
            )
            .clickable(
                enabled = enabled,
                role = Role.Button,
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        ProvideContentColor(contentColor) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
                content = content,
            )
        }
    }
}

@Composable
fun Button(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable RowScope.() -> Unit,
) {
    PrimaryButton(onClick = onClick, modifier = modifier, enabled = enabled, content = content)
}

@Composable
fun OutlinedButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable RowScope.() -> Unit,
) {
    PrimaryButton(onClick = onClick, modifier = modifier, enabled = enabled, ghost = true, content = content)
}

@Composable
fun TextButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable RowScope.() -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val color = if (enabled) ZephyrTheme.palette.brand.accent else ZephyrTheme.palette.onFloatingSubtle
    ProvideContentColor(color) {
        Row(
            modifier = modifier
                .pressScale(0.97f, enabled, interaction)
                .clip(RoundedCornerShape(10.dp))
                .clickable(
                    enabled = enabled,
                    role = Role.Button,
                    interactionSource = interaction,
                    indication = null,
                    onClick = onClick,
                )
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center,
            content = content,
        )
    }
}

@Composable
fun IconButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    Box(
        modifier = modifier
            .size(38.dp)
            .pressScale(ZephyrMotionTokens.HEAD_PRESS_SCALE, enabled, interaction)
            .clip(CircleShape)
            .clickable(
                enabled = enabled,
                role = Role.Button,
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
        content = { content() },
    )
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text.uppercase(),
        style = ZephyrTextStyles.section,
        color = ZephyrTheme.palette.onFloatingSubtle,
        modifier = modifier.padding(start = 4.dp, top = 22.dp, bottom = 10.dp).semantics { heading() },
    )
}

@Composable
fun Slider(
    value: Float,
    onValueChange: (Float) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    valueRange: ClosedFloatingPointRange<Float> = 0f..1f,
    onValueChangeFinished: (() -> Unit)? = null,
) {
    val palette = ZephyrTheme.palette
    val fraction = ((value - valueRange.start) / (valueRange.endInclusive - valueRange.start)).coerceIn(0f, 1f)
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(28.dp)
            .pointerInput(enabled, valueRange) {
                if (!enabled) return@pointerInput
                detectTapGestures { offset ->
                    val width = size.width.toFloat().coerceAtLeast(1f)
                    val next = (offset.x / width).coerceIn(0f, 1f)
                    onValueChange(valueRange.start + (valueRange.endInclusive - valueRange.start) * next)
                    onValueChangeFinished?.invoke()
                }
            }
            .pointerInput(enabled, valueRange) {
                if (!enabled) return@pointerInput
                detectHorizontalDragGestures(
                    onDragEnd = { onValueChangeFinished?.invoke() },
                    onDragCancel = { onValueChangeFinished?.invoke() },
                    onHorizontalDrag = { change, _ ->
                        change.consume()
                        val width = size.width.toFloat().coerceAtLeast(1f)
                        val next = (change.position.x / width).coerceIn(0f, 1f)
                        onValueChange(valueRange.start + (valueRange.endInclusive - valueRange.start) * next)
                    },
                )
            },
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(5.dp)
                .clip(RoundedCornerShape(3.dp))
                .background(palette.surfaces.elevated),
        )
        Box(
            Modifier
                .fillMaxWidth(fraction)
                .height(5.dp)
                .clip(RoundedCornerShape(3.dp))
                .background(palette.brand.accent),
        )
        Box(
            Modifier.fillMaxWidth(fraction).height(28.dp),
            contentAlignment = Alignment.CenterEnd,
        ) {
            Box(
                Modifier
                    .size(18.dp)
                    .clip(CircleShape)
                    .background(Color.White)
                    .border(1.dp, palette.surfaces.outline, CircleShape),
            )
        }
    }
}

@Composable
fun LinearProgress(
    progress: Float,
    modifier: Modifier = Modifier,
    color: Color = ZephyrTheme.palette.brand.accent,
    track: Color = ZephyrTheme.palette.surfaces.elevated,
) {
    Box(
        modifier
            .fillMaxWidth()
            .height(5.dp)
            .clip(RoundedCornerShape(3.dp))
            .background(track),
    ) {
        Box(
            Modifier
                .fillMaxWidth(progress.coerceIn(0f, 1f))
                .height(5.dp)
                .background(color),
        )
    }
}

@Composable
fun LinearProgressIndicator(
    progress: () -> Float,
    modifier: Modifier = Modifier,
    color: Color = ZephyrTheme.palette.brand.accent,
    trackColor: Color = ZephyrTheme.palette.surfaces.elevated,
) {
    LinearProgress(progress(), modifier, color, trackColor)
}

@Composable
fun LinearProgressIndicator(
    progress: Float,
    modifier: Modifier = Modifier,
    color: Color = ZephyrTheme.palette.brand.accent,
    trackColor: Color = ZephyrTheme.palette.surfaces.elevated,
) {
    LinearProgress(progress, modifier, color, trackColor)
}

@Composable
fun Spinner(modifier: Modifier = Modifier, color: Color = ZephyrTheme.palette.brand.accent, size: Dp = 22.dp) {
    val turn = rememberInfiniteTransition(label = "spin")
    val angle by turn.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(800, easing = LinearEasing), RepeatMode.Restart),
        label = "spinAngle",
    )
    Box(
        modifier
            .size(size)
            .rotate(angle)
            .drawBehind {
                drawArc(
                    color = color,
                    startAngle = 0f,
                    sweepAngle = 270f,
                    useCenter = false,
                    style = Stroke(width = size.toPx() * 0.14f, cap = StrokeCap.Round),
                )
            },
    )
}

@Composable
fun CircularProgressIndicator(
    modifier: Modifier = Modifier,
    color: Color = ZephyrTheme.palette.brand.accent,
) {
    Spinner(modifier = modifier, color = color)
}

@Composable
fun HorizontalDivider(
    modifier: Modifier = Modifier,
    color: Color = ZephyrTheme.palette.surfaces.outlineSoft,
) {
    Box(modifier.fillMaxWidth().height(1.dp).background(color))
}

@Composable
fun Card(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    GroupCard(modifier = modifier, content = content)
}
