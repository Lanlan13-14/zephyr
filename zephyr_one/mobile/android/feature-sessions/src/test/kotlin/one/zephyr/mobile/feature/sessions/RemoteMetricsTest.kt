package one.zephyr.mobile.feature.sessions

import one.zephyr.mobile.protocol.ssh.SshRemoteOps
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteMetricsTest {
    @Test
    fun parsesDesktopStatsSnapshot() {
        val raw = listOf(
            "cpu  100 20 30 850 0 0 0 0 0 0",
            SshRemoteOps.MARKER_CPU,
            "MemTotal:        1000000 kB",
            "MemAvailable:     420000 kB",
            "SwapTotal: 0 kB",
            "SwapFree: 0 kB",
            SshRemoteOps.MARKER_MEM,
            "Filesystem     1024-blocks     Used Available Capacity Mounted on",
            "/dev/sda1        1048576 860032 188544      82% /",
            SshRemoteOps.MARKER_DISK,
            "",
            SshRemoteOps.MARKER_DISKSTATS,
            "",
            SshRemoteOps.MARKER_NET,
            "",
            SshRemoteOps.MARKER_IP4,
            "",
            SshRemoteOps.MARKER_IP6,
            "processor : 0",
            SshRemoteOps.MARKER_CPUINFO,
            "Linux",
            SshRemoteOps.MARKER_UNAME,
            "",
            SshRemoteOps.MARKER_PROC,
            "host",
        ).joinToString("\n")
        val value = parseRemoteMetrics(raw)
        assertEquals(0, value.cpuPercent)
        assertEquals(58, value.memoryPercent)
        assertEquals(82, value.diskPercent)
    }

    @Test
    fun secondSampleProducesCpuUsage() {
        fun raw(cpu: String) = listOf(
            cpu,
            SshRemoteOps.MARKER_CPU,
            "MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB",
            SshRemoteOps.MARKER_MEM,
            "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1024 512 512 50% /",
            SshRemoteOps.MARKER_DISK,
            "",
            SshRemoteOps.MARKER_DISKSTATS,
            "",
            SshRemoteOps.MARKER_NET,
            "",
            SshRemoteOps.MARKER_IP4,
            "",
            SshRemoteOps.MARKER_IP6,
            "processor : 0",
            SshRemoteOps.MARKER_CPUINFO,
            "Linux",
            SshRemoteOps.MARKER_UNAME,
            "",
            SshRemoteOps.MARKER_PROC,
            "host",
        ).joinToString("\n")
        val first = SshRemoteOps.parseRemoteStats(raw("cpu  100 0 0 100 0 0 0 0 0 0"), previous = null, nowMs = 1_000L)
        val second = SshRemoteOps.parseRemoteStats(raw("cpu  180 0 0 120 0 0 0 0 0 0"), previous = first.sample, nowMs = 2_000L)
        val metrics = parseRemoteMetrics(second)
        assertTrue(metrics.cpuPercent > 0)
        assertEquals(50, metrics.diskPercent)
    }

    @Test
    fun garbageDoesNotInventABusyHost() {
        val value = parseRemoteMetrics("not a stats dump")
        assertEquals(0, value.cpuPercent)
        assertEquals(0, value.memoryPercent)
        assertEquals(0, value.diskPercent)
    }
}
