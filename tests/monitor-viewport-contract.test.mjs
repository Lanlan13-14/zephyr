import { test } from 'node:test';
import assert from 'node:assert/strict';

/* Stage 4 acceptance (FREEZE plan §2.3, §3.10): the monitor panel must not
 * rebuild its entire DOM on every stats tick. We verify the source contract
 * by static analysis of terminal.js: renderStats must NOT unconditionally
 * assign infoBody.innerHTML, and must NOT call initCharts() on every tick.
 * The skeleton path is the only place innerHTML is assigned. */

import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'terminal.js'), 'utf8');

test('renderStats does not rebuild innerHTML on every tick', () => {
    // Extract the renderStats function body (it was split into ensureStatsSkeleton + renderStats)
    const idx = src.indexOf('function renderStats(d)');
    assert.ok(idx > 0, 'renderStats must exist');
    const body = src.slice(idx, src.indexOf('function setTextStatName', idx));
    // renderStats itself must not assign infoBody.innerHTML directly
    assert.ok(!/infoBody\.innerHTML\s*=/.test(body), 'renderStats must not rebuild innerHTML');
    // initCharts must only run inside ensureStatsSkeleton, not renderStats
    assert.ok(!/initCharts\(\)/.test(body), 'renderStats must not re-init charts every tick');
});

test('ensureStatsSkeleton is the single innerHTML assignment site for stats', () => {
    const idx = src.indexOf('function ensureStatsSkeleton(d)');
    assert.ok(idx > 0, 'ensureStatsSkeleton must exist');
    const body = src.slice(idx, src.indexOf('function setTextStat', idx));
    assert.ok(/infoBody\.innerHTML\s*=/.test(body), 'skeleton owns the innerHTML build');
    assert.ok(/initCharts\(\)/.test(body), 'skeleton owns chart init');
    assert.ok(/dataset\.statsSkeleton\s*=\s*'1'/.test(body), 'skeleton marks itself built');
});

test('hideInfoModal tears down the skeleton so the next open starts fresh', () => {
    const idx = src.indexOf('function hideInfoModal()');
    assert.ok(idx > 0);
    const body = src.slice(idx, src.indexOf('function toggleInfoModal', idx));
    assert.ok(/destroyCharts\(\)/.test(body), 'hideInfoModal must destroy charts');
    assert.ok(/delete infoBody\.dataset\.statsSkeleton/.test(body), 'hideInfoModal must clear the skeleton flag');
});

test('term.viewport facade exposes stable read/follow/lock API', () => {
    const idx = src.indexOf('term.viewport =');
    assert.ok(idx > 0, 'viewport facade must be installed');
    const body = src.slice(idx, idx + 1200);
    assert.ok(/get atBottom/.test(body), 'atBottom getter');
    assert.ok(/state\(\)/.test(body), 'state() method');
    assert.ok(/follow\(/.test(body), 'follow() method');
    assert.ok(/lock\(/.test(body), 'lock() method');
    assert.ok(/unlock\(/.test(body), 'unlock() method');
    // facade must not re-export private method names - business code stays decoupled
    assert.ok(!/this\._scrollToBottom|this\._isScrolledToBottom/.test(body), 'facade must not leak private method names');
});
