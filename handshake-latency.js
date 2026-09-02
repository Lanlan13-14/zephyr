'use strict';

/* Handshake latency helpers for the monitor panel.
 *
 * The number shown as 连接延迟 MUST come from the same wall-clock as
 * 编辑 → 测试连接 (`testSSHConnection` → `createRoutedSSHConnection`):
 * TCP + jump hosts + auth. These helpers only decide *when* to refresh
 * and *whether* a probe result is usable — they never invent an RTT from
 * the live-session stats exec.
 */

function acceptHandshakeLatency(probe) {
    if (!probe || probe.ok !== true) return null;
    const ms = Number(probe.durationMs);
    if (!Number.isFinite(ms)) return null;
    return Math.max(0, Math.round(ms));
}

function shouldRefreshHandshakeLatency({ lastMs, lastAt, running, now, intervalMs } = {}) {
    if (running) return false;
    const interval = Number(intervalMs);
    if (!Number.isFinite(interval) || interval < 0) return false;
    if (lastMs == null) return true;
    return (Number(now) - Number(lastAt || 0)) >= interval;
}

module.exports = {
    acceptHandshakeLatency,
    shouldRefreshHandshakeLatency,
};
