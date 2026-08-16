package one.zephyr.mobile.protocol.ssh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SshRemoteOpsTest {

    @Test
    fun dockerStatusDetectsInstalledSocketAndVersion() {
        val status = SshRemoteOps.parseDockerStatus(
            """
            __DOCKER_INSTALLED__=1
            Docker version 27.1.1, build 1234
            __DOCKER_SOCKET__=1
            """.trimIndent(),
        )
        assertTrue(status.installed)
        assertTrue(status.socket)
        assertEquals("Docker version 27.1.1, build 1234", status.version)
    }

    @Test
    fun dockerStatusDoesNotPretendInstalledWhenBinaryMissing() {
        val status = SshRemoteOps.parseDockerStatus("__DOCKER_INSTALLED__=0\n")
        assertFalse(status.installed)
        assertFalse(status.socket)
        assertEquals("", status.version)
    }

    @Test
    fun dockerJsonLinesBecomeContainersAndImages() {
        val containers = SshRemoteOps.parseDockerContainers(
            """
            {"ID":"abc123def456","Names":"/nginx","Image":"nginx:alpine","Status":"Up 3 hours","State":"running","Ports":"80/tcp","CreatedAt":"2026-08-01"}
            not-json
            {"ID":"deadbeef0001","Names":"worker","Image":"busybox","Status":"Exited (0)","State":"exited","Ports":"","CreatedAt":"2026-08-02"}
            """.trimIndent(),
        )
        assertEquals(2, containers.size)
        assertEquals("nginx", containers[0].name)
        assertTrue(containers[0].running)
        assertFalse(containers[1].running)
        assertEquals("abc123def456", containers[0].target)

        val images = SshRemoteOps.parseDockerImages(
            """{"ID":"sha256:0123456789abcdef","Repository":"nginx","Tag":"alpine","Size":"12MB","CreatedAt":"3 days ago"}""",
        )
        assertEquals("nginx:alpine", images.single().reference)
        assertEquals("0123456789ab", SshRemoteOps.shortId(images.single().id))
    }

    @Test
    fun dockerMirrorsAreReadFromDaemonJson() {
        val mirrors = SshRemoteOps.parseDockerMirrors(
            """
            {
              "log-driver": "json-file",
              "registry-mirrors": [
                "https://mirror.ccs.tencentyun.com",
                "https://docker.m.daocloud.io/"
              ]
            }
            """.trimIndent(),
        )
        assertEquals(
            listOf("https://mirror.ccs.tencentyun.com", "https://docker.m.daocloud.io/"),
            mirrors,
        )
        assertTrue(SshRemoteOps.isValidMirror("https://example.com/v2"))
        assertFalse(SshRemoteOps.isValidMirror("ftp://bad"))
    }

    @Test
    fun containerActionAndSignalsRefuseDangerousTargets() {
        assertEquals("docker start 'web'", SshRemoteOps.dockerContainerActionCommand(DockerContainerAction.START, "web"))
        assertEquals("docker rm -f 'web'", SshRemoteOps.dockerContainerActionCommand(DockerContainerAction.REMOVE, "web"))
        assertEquals("kill -s TERM 42", SshRemoteOps.processSignalCommand(42, ProcessSignal.TERM))
        try {
            SshRemoteOps.processSignalCommand(1, ProcessSignal.KILL)
            throw AssertionError("pid 1 must be rejected")
        } catch (_: IllegalArgumentException) {
        }
        val quoted = SshRemoteOps.shellQuote("it's")
        assertEquals("'it'\\''s'", quoted)
        assertTrue(SshRemoteOps.dockerPullCommand("nginx:alpine").contains("'nginx:alpine'"))
        val logs = SshRemoteOps.dockerLogsCommand("web")
        assertTrue(logs.contains("--timestamps"))
        assertTrue(logs.contains(" -f "))
        assertTrue(logs.contains("'web'"))
        assertFalse(SshRemoteOps.dockerLogsCommand("web", follow = false).contains(" -f"))
    }

    @Test
    fun mirrorsSetScriptEmbedsBase64PayloadAndKeepsExistingKeys() {
        val script = SshRemoteOps.dockerMirrorsSetCommand(listOf("https://mirror.example"))
        assertTrue(script.contains("registry-mirrors"))
        assertTrue(script.contains("base64.b64decode"))
        assertTrue(script.contains("sudo -n cp"))
        assertFalse(script.contains("https://mirror.example"))
    }

    @Test
    fun statsParserFillsHostCpuMemoryDiskNetAndProcesses() {
        val raw = buildStatsRaw(
            cpu = "cpu  100 20 30 850 0 0 0 0 0 0",
            mem = "MemTotal:        2000000 kB\nMemAvailable:     500000 kB\nSwapTotal:     1000000 kB\nSwapFree:       250000 kB",
            disk = "Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/sda1        104857600 52428800  52428800      50% /",
            diskstats = "   8       0 sda 0 0 0 0 0 0 200 0 0 0 0 0 0 400",
            net = "Inter-|   Receive                                                |  Transmit\n eth0: 12500000 0 0 0 0 0 0 0 2500000 0 0 0 0 0 0 0",
            ip4 = "203.0.113.10",
            ip6 = "2001:db8::1",
            cpuinfo = "processor\t: 0\nmodel name\t: Test CPU\ncpu MHz\t\t: 2400.000\nprocessor\t: 1",
            uname = "Linux 6.8.0 x86_64 GNU/Linux",
            processes = "  42 root      12.5  3.0 S sshd /usr/sbin/sshd -D\n   7 nobody     1.0  0.2 S nginx nginx: worker",
            hostname = "edge-01",
        )
        val first = SshRemoteOps.parseRemoteStats(raw, previous = null, nowMs = 1_000L)
        val firstCpu = SshRemoteOps.parseCpuStat("cpu  100 20 30 850 0 0 0 0 0 0")
        val laterCpuLine = "cpu  200 40 60 900 0 0 0 0 0 0"
        val laterCpu = SshRemoteOps.parseCpuStat(laterCpuLine)
        assertTrue("first /proc/stat tick must parse", first.sample.cpu != null && firstCpu != null)
        assertTrue("second /proc/stat tick must parse", laterCpu != null)
        assertEquals(firstCpu!!.total, first.sample.cpu!!.total)
        assertEquals(0.0, first.cpu.usagePercent, 0.001)
        assertEquals("edge-01", first.hostName)
        assertEquals("Linux 6.8.0 x86_64 GNU/Linux", first.os)
        assertEquals("Test CPU", first.cpu.model)
        assertEquals("2400 MHz", first.cpu.freq)
        assertEquals(2, first.cpu.cores)
        assertEquals(2000000.0 / 1024.0 - 500000.0 / 1024.0, first.memory.memUsedMb, 0.01)
        assertEquals(1, first.disks.size)
        assertEquals("/", first.disks.single().mountpoint)
        assertEquals(50, first.disks.single().percent)
        assertEquals("203.0.113.10", first.ipv4)
        assertEquals("2001:db8::1", first.ipv6)
        assertEquals(2, first.processes.size)
        assertEquals(42, first.processes[0].pid)
        assertEquals("sshd", first.processes[0].command)

        val later = SshRemoteOps.parseRemoteStats(
            buildStatsRaw(
                cpu = laterCpuLine,
                mem = "MemTotal:        2000000 kB\nMemAvailable:     500000 kB\nSwapTotal:     1000000 kB\nSwapFree:       250000 kB",
                disk = "Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/sda1        104857600 52428800  52428800      50% /",
                diskstats = "   8       0 sda 0 0 400 0 0 0 800 0 0 0 0 0 0 0",
                net = "Inter-|   Receive                                                |  Transmit\n eth0: 25000000 0 0 0 0 0 0 0 5000000 0 0 0 0 0 0 0",
                ip4 = "203.0.113.10",
                ip6 = "2001:db8::1",
                cpuinfo = "processor\t: 0\nmodel name\t: Test CPU\ncpu MHz\t\t: 2400.000\nprocessor\t: 1",
                uname = "Linux 6.8.0 x86_64 GNU/Linux",
                processes = "  42 root      12.5  3.0 S sshd /usr/sbin/sshd -D",
                hostname = "edge-01",
            ),
            previous = first.sample,
            nowMs = 3_000L,
        )
        val expectedCpu = SshRemoteOps.computeCpuUsage(laterCpu, firstCpu)
        assertEquals(expectedCpu, later.cpu.usagePercent, 0.01)
        assertTrue("second tick must show busy CPU, got ${later.cpu.usagePercent}", later.cpu.usagePercent > 1.0)
        assertTrue("rx ${later.network.rxMbps}", later.network.rxMbps > 0.0)
        assertTrue("tx ${later.network.txMbps}", later.network.txMbps > 0.0)
        assertTrue("disk write ${later.disks.single().writeKBps}", later.disks.single().writeKBps > 0.0)
    }

    @Test
    fun deletingTheRateSampleMustFailTheSecondTick() {
        val raw = buildStatsRaw(
            cpu = "cpu  100 0 0 100 0 0 0 0 0 0",
            mem = "MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB",
            disk = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1024 512 512 50% /",
            diskstats = "8 0 sda 0 0 0 0 0 0 0 0 0 0 0 0 0",
            net = "eth0: 100 0 0 0 0 0 0 0 100 0 0 0 0 0 0 0",
            ip4 = "1.1.1.1",
            ip6 = "",
            cpuinfo = "processor : 0\nmodel name : X",
            uname = "Linux",
            processes = "",
            hostname = "h",
        )
        val first = SshRemoteOps.parseRemoteStats(raw, previous = null, nowMs = 1_000L)
        val second = SshRemoteOps.parseRemoteStats(raw.replace("cpu  100 0 0 100", "cpu  180 0 0 120"), previous = first.sample, nowMs = 2_000L)
        assertTrue(second.cpu.usagePercent > 0.0)
        val withoutSample = SshRemoteOps.parseRemoteStats(raw.replace("cpu  100 0 0 100", "cpu  180 0 0 120"), previous = null, nowMs = 2_000L)
        assertEquals(0.0, withoutSample.cpu.usagePercent, 0.0)
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
