package one.zephyr.mobile.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.sp

/**
 * Five text roles from MOBILE_EXPERIENCE.md 4.2: page title, section title, body, caption, mono.
 *
 * Sizes are in sp so Android font scaling applies; nothing here fixes a pixel size, because the spec
 * forbids a layout that truncates at the largest accessibility font.
 */
object ZephyrTextStyles {


    /**
     * Monospace for host, port, fingerprint, command and path only.
     *
     * Tabular figures are requested via the font feature setting rather than a different family, so
     * latency and FPS readouts stop jittering while still falling back cleanly on devices whose
     * monospace font lacks the feature.
     */
    val mono: TextStyle = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontSize = 14.sp,
        fontFeatureSettings = "tnum",
        platformStyle = PlatformTextStyle(includeFontPadding = false),
        lineHeightStyle = LineHeightStyle(
            alignment = LineHeightStyle.Alignment.Center,
            trim = LineHeightStyle.Trim.None,
        ),
    )

    /** Numeric status values that must not reflow as they change. */
    val tabularNumeric: TextStyle = TextStyle(
        fontSize = 13.sp,
        fontFeatureSettings = "tnum",
    )

    /** Island labels: single line, never below the accessibility floor. */
    val islandLabel: TextStyle = TextStyle(
        fontSize = 12.sp,
        fontWeight = FontWeight.Medium,
    )

    /** Secondary explanatory text: empty-state reasons, timestamps, permission causes. */
    val caption: TextStyle = TextStyle(
        fontSize = 13.sp,
        fontWeight = FontWeight.Normal,
    )

    /**
     * Mono caption for the diagnostics line.
     *
     * requestId and error code are copy-paste evidence, so they are monospaced to make an
     * ambiguous character in a hand-transcribed id impossible to misread.
     */
    val monoCaption: TextStyle = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontSize = 12.sp,
        fontFeatureSettings = "tnum",
    )
}

@Composable
fun zephyrTypography(): Typography {
    val base = Typography()
    return remember {
        base.copy(
            headlineSmall = base.headlineSmall.copy(fontWeight = FontWeight.SemiBold),
            titleMedium = base.titleMedium.copy(fontWeight = FontWeight.SemiBold),
            bodyMedium = base.bodyMedium,
            labelMedium = base.labelMedium,
        )
    }
}
