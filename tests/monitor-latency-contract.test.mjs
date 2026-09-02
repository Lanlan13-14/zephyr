import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* Monitor latency contract:
 * Latency MUST be measured by the same path as 编辑 → 测试连接:
 * testSSHConnection → createRoutedSSHConnection wall-clock (TCP + jump +
 * auth). It must NEVER reuse the stats exec duration or an empty-exec
 * probe on the live session (those either inflate or silently fail).
 */

const root = path.resolve(import.meta.dirname, '..');
const terminalJs = fs.readFileSync(path.join(root, 'public', 'terminal.js'), 'utf8');
const statsJs = fs.readFileSync(path.join(root, 'stats.js'), 'utf8');
const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');

test('stats.js no longer measures latency itself (handshake lives in server.js)', () => {
    assert.ok(!/function probeLatency\(/.test(statsJs), 'empty-exec probe must be gone');
    assert.ok(!/latency:\s*\{/.test(statsJs), 'stats.js must not stamp latency.ms');
    assert.ok(!/sshClient\.exec\('true'/.test(statsJs), 'must not exec true on the live session');
});

test('server.js measures latency via testSSHConnection (same path as 编辑→测试连接)', () => {
    const idx = serverJs.indexOf('function startStatsPush()');
    assert.ok(idx > 0, 'startStatsPush must exist');
    const body = serverJs.slice(idx, idx + 3600);
    assert.ok(/const kickHandshakeLatency = \(\) =>/.test(body), 'handshake kick is extracted');
    assert.ok(/kickHandshakeLatency\(\);/.test(body), 'handshake starts immediately, not after stats exec');
    assert.ok(/testSSHConnection\(statsConnectionConfig/.test(body), 'must call testSSHConnection');
    assert.ok(/acceptHandshakeLatency\(probe\)/.test(body), 'must accept only a successful handshake durationMs');
    assert.ok(/shouldRefreshHandshakeLatency\(/.test(body), 'handshake is throttled by helper');
    assert.ok(/STATS_LATENCY_INTERVAL_MS/.test(body), 'handshake interval constant exists');
    assert.ok(/latency:\s*\{\s*ms: statsLatencyMs/.test(body), 'payload carries cached handshake ms');
});

test('connection config is captured on connect and restored on attach', () => {
    assert.ok(/statsConnectionConfig = conn;/.test(serverJs), 'connect stores config');
    assert.ok(/statsConnectionConfig = session\.connectionConfig/.test(serverJs), 'attach restores config');
});

test('monitor skeleton renders a dedicated latency block with a line canvas', () => {
    const idx = terminalJs.indexOf('function ensureStatsSkeleton(d)');
    assert.ok(idx > 0, 'ensureStatsSkeleton must exist');
    const body = terminalJs.slice(idx, terminalJs.indexOf('function setTextStat', idx));
    assert.ok(/连接延迟/.test(body), 'skeleton must label the latency block');
    assert.ok(/data-stat="latencyText"/.test(body), 'skeleton must include the latency value node');
    assert.ok(/id="latencyLine"/.test(body), 'skeleton must include the latency chart canvas');
});

test('renderStats updates latency text and appends to the latency line chart', () => {
    const idx = terminalJs.indexOf('function renderStats(d)');
    assert.ok(idx > 0, 'renderStats must exist');
    const body = terminalJs.slice(idx, terminalJs.indexOf('function setTextStatName', idx));
    assert.ok(/d\.latency\?\.ms/.test(body), 'renderStats must read latency.ms from the stats payload');
    assert.ok(/latencyText/.test(body), 'renderStats must update the latency value');
    assert.ok(/updateLine\('latencyLine', latencyMs\)/.test(body), 'renderStats must push samples into the latency chart');
});

test('latency chart keeps a visible Y axis (unlike hidden-axis sparklines)', () => {
    const idx = terminalJs.indexOf('function initCharts()');
    assert.ok(idx > 0, 'initCharts must exist');
    const body = terminalJs.slice(idx, terminalJs.indexOf('function updateDoughnut', idx));
    assert.ok(/latency-line-canvas/.test(body), 'latency canvas must be charted');
    assert.ok(/beginAtZero:\s*true/.test(body), 'latency Y axis must start at zero');
});

test('latency card styles exist and color-code by severity', () => {
    assert.ok(/\.latency-card/.test(styleCss), 'latency card style');
    assert.ok(/\.latency-chart-wrap/.test(styleCss), 'latency chart wrap style');
    assert.ok(/\.latency-value\[data-level="good"\]/.test(styleCss), 'good level color');
    assert.ok(/\.latency-value\[data-level="bad"\]/.test(styleCss), 'bad level color');
});
