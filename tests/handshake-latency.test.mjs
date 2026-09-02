import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { acceptHandshakeLatency, shouldRefreshHandshakeLatency } = require('../handshake-latency.js');

test('acceptHandshakeLatency only keeps a successful handshake durationMs', () => {
    assert.equal(acceptHandshakeLatency({ ok: true, durationMs: 87.4 }), 87);
    assert.equal(acceptHandshakeLatency({ ok: true, durationMs: 0 }), 0);
    assert.equal(acceptHandshakeLatency({ ok: true, durationMs: -3 }), 0);
    assert.equal(acceptHandshakeLatency({ ok: false, durationMs: 12 }), null);
    assert.equal(acceptHandshakeLatency({ ok: true, durationMs: 'nope' }), null);
    assert.equal(acceptHandshakeLatency(null), null);
    assert.equal(acceptHandshakeLatency({ durationMs: 10 }), null);
});

test('shouldRefreshHandshakeLatency fires immediately when there is no sample yet', () => {
    assert.equal(shouldRefreshHandshakeLatency({
        lastMs: null, lastAt: 0, running: false, now: 1000, intervalMs: 5000,
    }), true);
});

test('shouldRefreshHandshakeLatency waits for the interval after a successful sample', () => {
    assert.equal(shouldRefreshHandshakeLatency({
        lastMs: 42, lastAt: 1000, running: false, now: 5999, intervalMs: 5000,
    }), false);
    assert.equal(shouldRefreshHandshakeLatency({
        lastMs: 42, lastAt: 1000, running: false, now: 6000, intervalMs: 5000,
    }), true);
});

test('shouldRefreshHandshakeLatency never overlaps an in-flight handshake', () => {
    assert.equal(shouldRefreshHandshakeLatency({
        lastMs: null, lastAt: 0, running: true, now: 99999, intervalMs: 5000,
    }), false);
});
