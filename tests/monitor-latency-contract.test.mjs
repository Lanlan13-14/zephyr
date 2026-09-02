import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* Monitor latency contract:
 * - stats.js annotates every sample with `latency.ms` measured as the SSH
 *   exec channel round-trip (same signal the "编辑 → 测试连接" durationMs uses,
 *   just reusing the 1s stats sample instead of a separate handshake).
 * - terminal.js renders a dedicated 连接延迟 block with a numeric value and a
 *   Chart.js line chart that keeps its Y axis visible (unlike the sparklines).
 */

const root = path.resolve(import.meta.dirname, '..');
const terminalJs = fs.readFileSync(path.join(root, 'public', 'terminal.js'), 'utf8');
const statsJs = fs.readFileSync(path.join(root, 'stats.js'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');

test('stats.js annotates samples with latency.ms from the exec round-trip', () => {
    assert.ok(/const startedAt = Date\.now\(\);/.test(statsJs), 'getRemoteStats must stamp startedAt before exec');
    assert.ok(/latency:\s*\{\s*ms:/.test(statsJs), 'stats payload must include latency.ms');
    assert.ok(/now - startedAt/.test(statsJs), 'latency.ms must be the exec round-trip duration');
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
