package one.zephyr.mobile.feature.sessions

import org.junit.Assert.assertEquals
import org.junit.Test

class RemoteMetricsTest {
    @Test
    fun parsesProcAndDfOutput() {
        val value = parseRemoteMetrics(
            """
            cpu  100 20 30 850 0 0 0 0 0 0
            1000000 420000
            82
            """.trimIndent(),
        )
        assertEquals(15, value.cpuPercent)
        assertEquals(58, value.memoryPercent)
        assertEquals(82, value.diskPercent)
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsIncompleteMetricsInsteadOfShowingZeros() {
        parseRemoteMetrics("cpu 1 2")
    }
}
