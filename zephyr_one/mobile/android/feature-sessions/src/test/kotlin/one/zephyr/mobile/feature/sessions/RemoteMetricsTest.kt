package one.zephyr.mobile.feature.sessions

import one.zephyr.mobile.protocol.ssh.SshRemoteOps
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteMetricsTest {
    @Test
    fun parsesDesktopStatsSnapshot() {
        val snapshot = SshRemoteOps.parseRemoteStats(
            buildStatsRaw(
                cpu = "cpu  100 20 30 850 0 0 0 0 0 0",
                mem = "MemTotal:        1000000 kB\nMemAvailable:     420000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB",
                disk = "Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/sda1        1048576 860032 188544      82% /",
                diskstats = "",
                net = "",
                ip4 = "",
                ip6 = "",
                cpuinfo = "processor : 0",
                uname = "Linux",
                processes = "",
                hostname = "host",
            ),
        )
        val value = parseRemoteMetrics(snapshot)
        assertEquals(0, value.cpuPercent)
        assertEquals(snapshot.memory.memPercent.toInt(), value.memoryPercent)
        assertEquals(82, value.diskPercent)
        assertTrue(snapshot.memory.memTotalMb > 900.0)
        assertTrue(value.memoryPercent in 50..70)
    }

    @Test
    fun secondSampleProducesCpuUsage() {
        fun raw(cpu: String) = buildStatsRaw(
            cpu = cpu,
            mem = "MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB",
            disk = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1024 512 512 50% /",
            diskstats = "",
            net = "",
            ip4 = "",
            ip6 = "",
            cpuinfo = "processor : 0",
            uname = "Linux",
            processes = "",
            hostname = "host",
        )
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

    private fun buildStatsRaw(
        cpu: String,
        mem: String,
        disk: String,
        diskstats: String,
        net: String,
        ip4: String,
        ip6: String,
        cpuinfo: String,
        uname: String,
        processes: String,
        hostname: String,
    ): String = listOf(
        cpu, SshRemoteOps.MARKER_CPU,
        mem, SshRemoteOps.MARKER_MEM,
        disk, SshRemoteOps.MARKER_DISK,
        diskstats, SshRemoteOps.MARKER_DISKSTATS,
        net, SshRemoteOps.MARKER_NET,
        ip4, SshRemoteOps.MARKER_IP4,
        ip6, SshRemoteOps.MARKER_IP6,
        cpuinfo, SshRemoteOps.MARKER_CPUINFO,
        uname, SshRemoteOps.MARKER_UNAME,
        processes, SshRemoteOps.MARKER_PROC,
        hostname,
    ).joinToString("\n")
}
