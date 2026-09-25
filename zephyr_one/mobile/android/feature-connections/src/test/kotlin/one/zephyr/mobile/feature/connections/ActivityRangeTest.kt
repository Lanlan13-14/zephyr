package one.zephyr.mobile.feature.connections

import java.util.Calendar
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ActivityRangeTest {

    private val noon = Calendar.getInstance().apply {
        set(2026, Calendar.SEPTEMBER, 25, 12, 0, 0)
        set(Calendar.MILLISECOND, 0)
    }.timeInMillis

    @Test
    fun `today starts at local midnight and excludes yesterday`() {
        val window = rangeWindow(ActivityRange.TODAY, noon)
        assertTrue(noon in window)
        assertFalse(noon - 13L * 60L * 60L * 1000L in window)
    }

    @Test
    fun `week covers six full days before today`() {
        val window = rangeWindow(ActivityRange.WEEK, noon)
        assertTrue(noon - 6L * 24L * 60L * 60L * 1000L in window)
        assertFalse(noon - 7L * 24L * 60L * 60L * 1000L in window)
    }

    @Test
    fun `all keeps the oldest row`() {
        assertTrue(1L in rangeWindow(ActivityRange.ALL, noon))
    }
}
