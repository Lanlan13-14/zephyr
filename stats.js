const STAT_COMMAND = [
  'cat /proc/stat || true',
  "printf '\n__END_CPU__\n'",
  'cat /proc/meminfo || true',
  "printf '\n__END_MEM__\n'",
  'df -kP -x tmpfs -x devtmpfs -x squashfs -x overlay || true',
  "printf '\n__END_DISK__\n'",
  'cat /proc/diskstats || true',
  "printf '\n__END_DISKSTATS__\n'",
  'cat /proc/net/dev || true',
  "printf '\n__END_NET__\n'",
  "if command -v curl >/dev/null 2>&1; then curl -4 -fsS --connect-timeout 3 --max-time 5 https://api.ipify.org || curl -4 -fsS --connect-timeout 3 --max-time 5 https://ifconfig.me/ip || true; else true; fi",
  "printf '\n__END_IP4__\n'",
  "if command -v curl >/dev/null 2>&1; then curl -6 -fsS --connect-timeout 3 --max-time 5 https://api64.ipify.org || curl -6 -fsS --connect-timeout 3 --max-time 5 https://ifconfig.co/ip || true; else true; fi",
  "printf '\n__END_IP6__\n'",
  'cat /proc/cpuinfo || true',
  "printf '\n__END_CPUINFO__\n'",
  'uname -srmo 2>/dev/null || true',
  "printf '\n__END_UNAME__\n'",
  'ps -eo pid=,user=,pcpu=,pmem=,stat=,comm=,args= --sort=-pcpu 2>/dev/null | head -n 61 || true',
  "printf '\n__END_PROC__\n'",
  'hostname 2>/dev/null || true'
].join(' && ');

function execRemote(sshClient, command) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    sshClient.exec(`sh -lc ${JSON.stringify(command)}`, (err, stream) => {
      if (err) return finish(reject, err);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { stream.close?.(); } catch {}
        try { stream.destroy?.(); } catch {}
        finish(reject, new Error('Remote stats command timeout'));
      }, 15000);
      stream.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      stream.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      stream.on('error', (streamErr) => {
        clearTimeout(timer);
        finish(reject, streamErr);
      });
      stream.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && stdout.trim().length === 0) {
          return finish(reject, new Error(`Remote command failed: ${stderr.trim() || `exit ${code}`}`));
        }
        finish(resolve, stdout);
      });
    });
  });
}

function splitSections(raw) {
  const parts = raw.split('\n__END_CPU__\n');
  const cpu = parts[0] || '';
  const rest1 = parts[1] || '';
  const [mem, rest2] = rest1.split('\n__END_MEM__\n');
  const [disk, rest3] = (rest2 || '').split('\n__END_DISK__\n');
  const [diskstats, rest4] = (rest3 || '').split('\n__END_DISKSTATS__\n');
  const [net, rest5] = (rest4 || '').split('\n__END_NET__\n');
  const [ip4, rest6] = (rest5 || '').split('\n__END_IP4__\n');
  const [ip6, rest7] = (rest6 || '').split('\n__END_IP6__\n');
  const [cpuinfo, rest8] = (rest7 || '').split('\n__END_CPUINFO__\n');
  const [unameInfo, rest9] = (rest8 || '').split('\n__END_UNAME__\n');
  const [processes, hostname] = (rest9 || '').split('\n__END_PROC__\n');
  return { cpu, mem, disk, diskstats, net, ip4, ip6, cpuinfo, unameInfo, processes, hostname };
}

function parseCpuStat(raw) {
  const line = raw.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (parts[3] || 0) + (parts[4] || 0);
  const total = parts.reduce((sum, value) => sum + (Number(value) || 0), 0);
  return { idle, total };
}

function parseMemory(raw) {
  const result = { memUsed: 0, memTotal: 0, swapUsed: 0, swapTotal: 0 };
  raw.split('\n').forEach((line) => {
    if (line.startsWith('MemTotal')) result.memTotal = Number(line.split(/\s+/)[1]) / 1024;
    if (line.startsWith('MemAvailable')) result.memUsed = result.memTotal - (Number(line.split(/\s+/)[1]) / 1024);
    if (line.startsWith('SwapTotal')) result.swapTotal = Number(line.split(/\s+/)[1]) / 1024;
    if (line.startsWith('SwapFree')) result.swapUsed = result.swapTotal - (Number(line.split(/\s+/)[1]) / 1024);
  });
  if (result.memUsed < 0) result.memUsed = 0;
  if (result.swapUsed < 0) result.swapUsed = 0;
  return result;
}

function getDiskBaseName(filesystem) {
  if (!filesystem) return null;
  const name = filesystem.replace(/^\/dev\//, '').replace(/^mapper\//, '');
  if (/^nvme\d+n\d+p\d+$/.test(name)) return name.replace(/p\d+$/, '');
  if (/^mmcblk\d+p\d+$/.test(name)) return name.replace(/p\d+$/, '');
  return name.replace(/\d+$/, '');
}

function parseDisk(raw) {
  const lines = raw.trim().split('\n');
  if (lines.length <= 1) return { total: 0, used: 0, devices: [] };
  const devices = lines.slice(1).map((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) return null;
    const [filesystem, blocks, used, available, usePercent, mountpoint] = parts;
    const totalGB = Number(blocks) / 1024 / 1024;
    const usedGB = Number(used) / 1024 / 1024;
    const percent = parseInt(usePercent.replace('%', ''), 10) || 0;
    return {
      id: `disk-${filesystem.replace(/[^a-zA-Z0-9_-]/g, '')}-${mountpoint.replace(/[^a-zA-Z0-9_-]/g, '')}`,
      filesystem,
      mountpoint,
      diskName: getDiskBaseName(filesystem),
      usedGB: Number(usedGB.toFixed(1)),
      totalGB: Number(totalGB.toFixed(1)),
      percent,
      usageLabel: `${percent}%`,
      readKBps: 0,
      writeKBps: 0
    };
  }).filter(Boolean);
  return {
    devices,
    total: devices.reduce((sum, device) => sum + device.totalGB, 0),
    used: devices.reduce((sum, device) => sum + device.usedGB, 0)
  };
}

function parseDiskStats(raw) {
  const stats = {};
  raw.split('\n').forEach((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 14) return;
    const dev = parts[2];
    const reads = Number(parts[5]) || 0;
    const writes = Number(parts[9]) || 0;
    stats[dev] = { reads, writes };
  });
  return stats;
}

function computeDiskRates(current, diskStats, previousDiskStats = {}, elapsedSeconds) {
  const devices = current.devices.map((device) => {
    const stats = device.diskName ? diskStats[device.diskName] : null;
    const prevStats = device.diskName ? previousDiskStats[device.diskName] : null;
    const readDiff = Math.max(0, (stats?.reads || 0) - (prevStats?.reads || 0));
    const writeDiff = Math.max(0, (stats?.writes || 0) - (prevStats?.writes || 0));
    const readKBps = elapsedSeconds > 0 ? readDiff / 2 / elapsedSeconds : 0;
    const writeKBps = elapsedSeconds > 0 ? writeDiff / 2 / elapsedSeconds : 0;
    return {
      ...device,
      readKBps: Number(readKBps.toFixed(1)),
      writeKBps: Number(writeKBps.toFixed(1))
    };
  });
  return {
    devices,
    total: current.total,
    used: current.used
  };
}

function parseNet(raw) {
  const lines = raw.split('\n');
  let rx = 0;
  let tx = 0;
  lines.forEach((line) => {
    const cleaned = line.replace(':', ' ');
    const parts = cleaned.trim().split(/\s+/);
    if (parts.length < 17) return;
    const iface = parts[0];
    if (iface === 'lo' || iface.startsWith('docker') || iface.startsWith('veth') || iface.startsWith('br-')) return;
    rx += Number(parts[1]) || 0;
    tx += Number(parts[9]) || 0;
  });
  return { rx, tx };
}

function parseIp(raw) {
  const value = raw.trim();
  if (!value) return 'N/A';
  const lines = value.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // IPv4 pattern
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(trimmed)) {
      return trimmed;
    }
    // IPv6 pattern - look for valid IPv6
    if (/^[0-9a-f:]+$/.test(trimmed.toLowerCase())) {
      // Skip link-local (fe80::) and loopback (::1)
      if (!/^fe80:/i.test(trimmed) && trimmed !== '::1' && trimmed.includes(':')) {
        // Basic validation: IPv6 should have at least one colon
        return trimmed;
      }
    }
    // Parse line with potential mixed content
    const tokens = trimmed.split(/\s+/);
    for (const token of tokens) {
      const candidate = token.replace(/,$/, '').replace(/[;\|].*$/, '').split('/')[0].split('%')[0];
      // IPv4 check
      if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(candidate)) return candidate;
      // IPv6 check - must have colon and be valid hex
      if (candidate.includes(':') && /^[0-9a-f:.]+$/i.test(candidate)) {
        if (!/^fe80:/i.test(candidate) && candidate !== '::1' && candidate.length > 2) {
          return candidate;
        }
      }
    }
  }
  return 'N/A';
}

function parseCPUInfo(raw) {
  let model = 'N/A';
  let freq = 'N/A';
  let cores = 0;
  raw.split('\n').forEach((line) => {
    if (line.startsWith('model name') && model === 'N/A') {
      model = line.split(':')[1]?.trim() || 'N/A';
    }
    if (line.startsWith('cpu MHz') && freq === 'N/A') {
      freq = Math.round(Number(line.split(':')[1]) || 0) + ' MHz';
    }
    if (line.startsWith('processor')) {
      cores += 1;
    }
  });
  if (cores === 0 && model !== 'N/A') cores = 1;
  return { model, freq, cores };
}

function parseProcesses(raw) {
  return raw.split('\n').map((line) => {
    const text = line.trim();
    if (!text) return null;
    const match = text.match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!match) return null;
    const [, pid, user, cpu, mem, stat, command, args] = match;
    return {
      pid: Number(pid) || 0,
      user,
      cpu: Number(Number(cpu).toFixed(1)) || 0,
      mem: Number(Number(mem).toFixed(1)) || 0,
      stat,
      command,
      args: String(args || command).slice(0, 500)
    };
  }).filter((p) => p && p.pid > 0);
}

function parseUname(raw) {
  return raw.trim() || 'N/A';
}

function computeCpuUsage(current, previous) {
  if (!current || !previous || typeof previous.idle !== 'number' || typeof previous.total !== 'number') return 0;
  const totalDiff = current.total - previous.total;
  const idleDiff = current.idle - previous.idle;
  if (totalDiff <= 0) return 0;
  return Number(((1 - idleDiff / totalDiff) * 100).toFixed(1));
}

function computeNetRates(current, previous, elapsedSeconds) {
  if (!previous || elapsedSeconds <= 0) return { rx: 0, tx: 0 };
  return {
    rx: Math.max(((current.rx - previous.rx) * 8) / elapsedSeconds / 1024 / 1024, 0),
    tx: Math.max(((current.tx - previous.tx) * 8) / elapsedSeconds / 1024 / 1024, 0)
  };
}

/* 纯 RTT 探针：exec 一个空命令，只测 SSH 通道环回（与"编辑 → 测试连接"
 * 的握手后环回口径一致），不含 stats 命令的远端执行/公网 IP 探测耗时。
 * 失败返回 null，调用方降级为不显示延迟，绝不拿采样总耗时冒充 RTT。 */
function probeLatency(sshClient) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 3000);
    try {
      sshClient.exec('true', (err, stream) => {
        if (err) { clearTimeout(timer); return finish(null); }
        stream.on('close', () => {
          clearTimeout(timer);
          finish(Math.max(0, Date.now() - startedAt));
        });
        stream.on('error', () => { clearTimeout(timer); finish(null); });
        try { stream.end?.(); } catch {}
      });
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

async function getRemoteStats(sshClient, previous = {}) {
  /* 探针与采样并行：探针只测环回，采样继续干重活。总墙钟时间不变。 */
  const [latencyMs, raw] = await Promise.all([
    probeLatency(sshClient),
    execRemote(sshClient, STAT_COMMAND),
  ]);
  const sections = splitSections(raw);
  const cpuStat = parseCpuStat(sections.cpu);
  const mem = parseMemory(sections.mem);
  const rawDisk = parseDisk(sections.disk);
  const diskStats = parseDiskStats(sections.diskstats);
  const netValues = parseNet(sections.net);
  const ipv4 = parseIp(sections.ip4);
  const ipv6 = parseIp(sections.ip6);
  const cpuInfo = parseCPUInfo(sections.cpuinfo);
  const processes = parseProcesses(sections.processes || '');
  const osInfo = parseUname(sections.unameInfo);
  const hostname = sections.hostname.trim() || 'N/A';
  const now = Date.now();
  const elapsed = previous.timestamp ? (now - previous.timestamp) / 1000 : 0;
  const disk = computeDiskRates(rawDisk, diskStats, previous.diskStats, elapsed);
  const cpuUsage = computeCpuUsage(cpuStat, previous.cpuStat);
  const net = computeNetRates(netValues, previous.netValues, elapsed);

  return {
    stats: {
      cpu: {
        usage: cpuUsage,
        model: cpuInfo.model,
        freq: cpuInfo.freq,
        cores: cpuInfo.cores
      },
      ...mem,
      disk,
      net,
      processes,
      ip: { ipv4, ipv6 },
      host: { hostname, os: osInfo },
      /* 连接延迟：纯 SSH 通道环回（空 exec 探针），口径对齐"编辑 → 测试连接"。
       * 与 stats 采样并行测，不含远端命令执行/公网 IP 探测耗时。探针失败
       * 时 ms 为 null，前端降级显示 --。 */
      latency: { ms: latencyMs, sampledAt: now }
    },
    state: {
      cpuStat,
      netValues,
      diskStats,
      timestamp: now
    }
  };
}

module.exports = { getRemoteStats };
