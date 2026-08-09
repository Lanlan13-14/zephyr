package one.zephyr.mobile.ui.format

/**
 * Relative timestamps for list rows.
 *
 * Pure and injected with "now" rather than reading the clock, so the wording is unit testable. A
 * DateFormat-based absolute string is deliberately the fallback rather than the default: on a list
 * of hosts the user cares about "3 分钟前", not the exact second.
 *
 * MOBILE_EXPERIENCE.md 6 wants states to be legible without colour, so these strings also carry the
 * whole meaning for a screen reader.
 */
object RelativeTime {

    const val MINUTE_MS = 60_000L
    const val HOUR_MS = 60 * MINUTE_MS
    const val DAY_MS = 24 * HOUR_MS

    /** Below this a timestamp reads as "刚刚"; a 40-second-old event is not worth a number. */
    const val JUST_NOW_MS = 60_000L

    /** Past this, a relative string stops being useful and an absolute date is clearer. */
    const val ABSOLUTE_AFTER_DAYS = 30

    fun format(nowMs: Long, thenMs: Long): String {
        val delta = nowMs - thenMs
        // A future timestamp means clock skew between device and server. Reporting "刚刚" is honest
        // enough and avoids rendering "-3 分钟前".
        if (delta < JUST_NOW_MS) return JUST_NOW
        val minutes = delta / MINUTE_MS
        if (minutes < 60) return minutes.toString() + MINUTES_SUFFIX
        val hours = delta / HOUR_MS
        if (hours < 24) return hours.toString() + HOURS_SUFFIX
        val days = delta / DAY_MS
        if (days <= ABSOLUTE_AFTER_DAYS) return days.toString() + DAYS_SUFFIX
        return absolute(thenMs)
    }

    /**
     * Absolute fallback in the device's own locale and zone.
     *
     * java.text is used rather than java.time because minSdk is 26 and DateTimeFormatter's default
     * patterns differ across API levels; SimpleDateFormat with an explicit pattern is stable.
     */
    fun absolute(thenMs: Long): String {
        val format = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.getDefault())
        return format.format(java.util.Date(thenMs))
    }

    const val JUST_NOW = "刚刚"
    const val MINUTES_SUFFIX = " 分钟前"
    const val HOURS_SUFFIX = " 小时前"
    const val DAYS_SUFFIX = " 天前"
}
