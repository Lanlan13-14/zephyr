package one.zephyr.mobile.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.sp

/**
 * Type roles measured from demo.html, not Material type scale.
 *
 * Root titles 23/700. Pushed titles 18/700. Section 12/600 uppercase.
 * Body 14. Card name 14.5/600. Host mono 11.5. Caption 11.5–12.5.
 */
object ZephyrTextStyles {

    private val noPad = PlatformTextStyle(includeFontPadding = false)
    private val line = LineHeightStyle(
        alignment = LineHeightStyle.Alignment.Center,
        trim = LineHeightStyle.Trim.None,
    )

    val rootTitle: TextStyle = TextStyle(
        fontSize = 23.sp,
        lineHeight = 28.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.sp,
        platformStyle = noPad,
        lineHeightStyle = line,
    )

    val pushedTitle: TextStyle = TextStyle(
        fontSize = 18.sp,
        lineHeight = 24.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.sp,
        platformStyle = noPad,
        lineHeightStyle = line,
    )

    val section: TextStyle = TextStyle(
        fontSize = 12.sp,
        lineHeight = 16.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.sp,
        platformStyle = noPad,
        lineHeightStyle = line,
    )

    val body: TextStyle = TextStyle(
        fontSize = 14.sp,
        lineHeight = 20.sp,
        fontWeight = FontWeight.Normal,
        platformStyle = noPad,
        lineHeightStyle = line,
    )

    val bodyStrong: TextStyle = body.copy(fontWeight = FontWeight.SemiBold)

    val cardName: TextStyle = TextStyle(
        fontSize = 14.5.sp,
        lineHeight = 20.sp,
        fontWeight = FontWeight.SemiBold,
        platformStyle = noPad,
        lineHeightStyle = line,
    )

    val row: TextStyle = TextStyle(
        fontSize = 14.sp,
        lineHeight = 20.sp,
        fontWeight = FontWeight.Normal,
        platformStyle = noPad,
        lineHeightStyle = line,
    )

    val caption: TextStyle = TextStyle(
        fontSize = 12.sp,
        lineHeight = 16.sp,
        fontWeight = FontWeight.Normal,
        platformStyle = noPad,
        lineHeightStyle = line,
    )

    val hint: TextStyle = TextStyle(
        fontSize = 11.5.sp,
        lineHeight = 15.sp,
        fontWeight = FontWeight.Normal,
        platformStyle = noPad,
        lineHeightStyle = line,
    )

    val chip: TextStyle = TextStyle(
        fontSize = 12.5.sp,
        lineHeight = 16.sp,
        fontWeight = FontWeight.Medium,
        platformStyle = noPad,
        lineHeightStyle = line,
    )

    val pill: TextStyle = TextStyle(
        fontSize = 12.sp,
        lineHeight = 16.sp,
        fontWeight = FontWeight.Medium,
        platformStyle = noPad,
        lineHeightStyle = line,
    )

    val islandLabel: TextStyle = TextStyle(
        fontSize = 10.sp,
        lineHeight = 12.sp,
        fontWeight = FontWeight.SemiBold,
        platformStyle = noPad,
        lineHeightStyle = line,
    )

    val stat: TextStyle = TextStyle(
        fontSize = 20.sp,
        lineHeight = 24.sp,
        fontWeight = FontWeight.Bold,
        platformStyle = noPad,
        lineHeightStyle = line,
    )

    val protocolMark: TextStyle = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontSize = 10.5.sp,
        lineHeight = 14.sp,
        fontWeight = FontWeight.ExtraBold,
        letterSpacing = 0.sp,
        platformStyle = noPad,
        lineHeightStyle = line,
    )

    val mono: TextStyle = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontSize = 13.5.sp,
        lineHeight = 18.sp,
        fontFeatureSettings = "tnum",
        platformStyle = noPad,
        lineHeightStyle = line,
    )

    val monoHost: TextStyle = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontSize = 11.5.sp,
        lineHeight = 15.sp,
        fontFeatureSettings = "tnum",
        platformStyle = noPad,
        lineHeightStyle = line,
    )

    val tabularNumeric: TextStyle = TextStyle(
        fontSize = 13.sp,
        lineHeight = 17.sp,
        fontFeatureSettings = "tnum",
        platformStyle = noPad,
        lineHeightStyle = line,
    )

    val monoCaption: TextStyle = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        fontFeatureSettings = "tnum",
        platformStyle = noPad,
        lineHeightStyle = line,
    )

    val sheetItem: TextStyle = TextStyle(
        fontSize = 15.sp,
        lineHeight = 20.sp,
        fontWeight = FontWeight.Normal,
        platformStyle = noPad,
        lineHeightStyle = line,
    )
}

@Composable
fun zephyrTypography(): ZephyrTextStyles = ZephyrTextStyles
