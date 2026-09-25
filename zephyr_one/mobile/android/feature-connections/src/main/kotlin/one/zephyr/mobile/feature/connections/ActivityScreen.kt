package one.zephyr.mobile.feature.connections

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import one.zephyr.mobile.model.ActivityEvent
import one.zephyr.mobile.ui.chrome.PushedPageHeader
import one.zephyr.mobile.ui.component.Surface
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.island.islandContentBottomInset
import one.zephyr.mobile.ui.theme.ZephyrTheme
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/** Time window for the activity page. Mirrors the main end's range tabs. */
enum class ActivityRange { TODAY, WEEK, MONTH, ALL }

/**
 * The main end's activity page, drawn with One's own surfaces.
 *
 * The mobile projection replaces the original message with a fixed label, so the
 * page shows that label together with the category, outcome, protocol and time the
 * projection does keep. Nothing here invents an actor or a source address the
 * device never received.
 */
@Composable
fun ActivityScreen(
    events: List<ActivityEvent>,
    nowMs: Long,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var range by remember { mutableStateOf(ActivityRange.WEEK) }
    val shown = remember(events, range, nowMs) { events.filter { it.occurredAt in rangeWindow(range, nowMs) } }
    val palette = ZephyrTheme.palette
    Column(modifier.fillMaxSize()) {
        PushedPageHeader(title = "活动记录", onBack = onBack)
        Text(
            text = "ACTIVITY",
            color = palette.brand.accent,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.sp,
            modifier = Modifier.padding(start = 20.dp, top = 6.dp),
        )
        Text(
            text = "查看连接、账户与系统操作的详细记录。",
            color = palette.onFloatingMuted,
            fontSize = 13.sp,
            modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 2.dp, bottom = 12.dp),
        )
        RangeTabs(selected = range, onSelect = { range = it })
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("${shown.size} 条记录", color = palette.onBackground, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
            Text(range.label, color = palette.onFloatingSubtle, fontSize = 12.sp)
        }
        if (shown.isEmpty()) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 28.dp)) {
                Text("此时间范围内没有活动", color = palette.onBackground, fontWeight = FontWeight.SemiBold)
                Text("尝试扩大时间范围查看更早的记录。", color = palette.onFloatingMuted, fontSize = 13.sp)
            }
        } else {
            LazyColumn(
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = islandContentBottomInset()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(shown, key = { it.id }) { event -> ActivityCard(event) }
            }
        }
    }
}

@Composable
private fun RangeTabs(selected: ActivityRange, onSelect: (ActivityRange) -> Unit) {
    val palette = ZephyrTheme.palette
    Row(
        Modifier
            .padding(horizontal = 16.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(palette.surfaces.content)
            .horizontalScroll(rememberScrollState())
            .padding(6.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        ActivityRange.entries.forEach { range ->
            val on = range == selected
            Box(
                Modifier
                    .clip(RoundedCornerShape(12.dp))
                    .background(if (on) palette.brand.accent.copy(alpha = 0.16f) else Color.Transparent)
                    .clickable { onSelect(range) }
                    .padding(horizontal = 14.dp, vertical = 8.dp),
            ) {
                Text(
                    range.label,
                    color = if (on) palette.brand.accent else palette.onFloatingMuted,
                    fontSize = 13.sp,
                    fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium,
                )
            }
        }
    }
}

@Composable
private fun ActivityCard(event: ActivityEvent) {
    val palette = ZephyrTheme.palette
    val failed = event.outcome.contains("失败") || event.outcome.contains("拒绝") || event.outcome.contains("错误")
    val mark = if (failed) palette.status.error else palette.status.warning
    Surface(color = palette.surfaces.content, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.size(9.dp).clip(CircleShape).background(mark))
                Text(
                    event.message.ifBlank { "未知活动" },
                    color = palette.onBackground,
                    fontWeight = FontWeight.Bold,
                    fontSize = 15.sp,
                    modifier = Modifier.weight(1f),
                )
            }
            if (event.outcome.isNotBlank()) {
                Spacer(Modifier.height(6.dp))
                Text(
                    event.outcome,
                    color = if (failed) palette.status.error else palette.status.success,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background((if (failed) palette.status.error else palette.status.success).copy(alpha = 0.14f))
                        .padding(horizontal = 8.dp, vertical = 2.dp),
                )
            }
            Text(
                formatStamp(event.occurredAt),
                color = palette.onFloatingMuted,
                fontSize = 13.sp,
                modifier = Modifier.padding(top = 8.dp),
            )
            Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                MetaCell("事件类型", event.category.ifBlank { "操作" }, Modifier.weight(1f))
                MetaCell("协议", event.protocol?.ifBlank { "—" } ?: "—", Modifier.weight(1f))
            }
            if (!event.target.isNullOrBlank()) {
                MetaCell("目标地址", event.target, Modifier.padding(top = 8.dp))
            }
            Text(
                "事件 ID  ${event.id}",
                color = palette.onFloatingSubtle,
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
                modifier = Modifier.padding(top = 12.dp),
            )
        }
    }
}

@Composable
private fun MetaCell(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(label, color = ZephyrTheme.palette.onFloatingSubtle, fontSize = 12.sp)
        Text(value, color = ZephyrTheme.palette.onBackground, fontSize = 14.sp, fontWeight = FontWeight.Medium)
    }
}

private val ActivityRange.label: String
    get() = when (this) {
        ActivityRange.TODAY -> "今天"
        ActivityRange.WEEK -> "近 7 天"
        ActivityRange.MONTH -> "近 30 天"
        ActivityRange.ALL -> "全部"
    }

internal fun rangeWindow(range: ActivityRange, nowMs: Long): LongRange {
    val start = Calendar.getInstance().apply {
        timeInMillis = nowMs
        set(Calendar.HOUR_OF_DAY, 0)
        set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
    }
    val from = when (range) {
        ActivityRange.TODAY -> start.timeInMillis
        ActivityRange.WEEK -> start.timeInMillis - 6L * DAY_MS
        ActivityRange.MONTH -> start.timeInMillis - 29L * DAY_MS
        ActivityRange.ALL -> 0L
    }
    return from..Long.MAX_VALUE
}

private fun formatStamp(epochMs: Long): String =
    if (epochMs <= 0L) "—" else SimpleDateFormat("yyyy/M/d HH:mm:ss", Locale.CHINA).format(Date(epochMs))

private const val DAY_MS = 24L * 60L * 60L * 1000L
