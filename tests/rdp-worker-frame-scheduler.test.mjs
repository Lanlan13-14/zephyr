import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerFrameScheduler } from '../public/rdp-worker-frame-scheduler.js';

function scopeWithTimers(extra = {}) {
    return { setTimeout, clearTimeout, performance, ...extra };
}

test('scheduler uses timer when Worker rAF is unavailable', async () => {
    const scheduler = createWorkerFrameScheduler(scopeWithTimers(), { fallbackMs: 5 });
    await new Promise((resolve) => scheduler.request(resolve));
    assert.equal(scheduler.stats.timerCallbacks, 1);
    assert.equal(scheduler.stats.rafCallbacks, 0);
});

test('scheduler watchdog presents when Worker rAF is suspended', async () => {
    const scheduler = createWorkerFrameScheduler(scopeWithTimers({ requestAnimationFrame: () => 77, cancelAnimationFrame: () => {} }), { fallbackMs: 5 });
    await new Promise((resolve) => scheduler.request(resolve));
    assert.equal(scheduler.stats.timerCallbacks, 1);
});

test('scheduler uses rAF exactly once when callback arrives', async () => {
    let callback;
    const scheduler = createWorkerFrameScheduler(scopeWithTimers({ requestAnimationFrame: (cb) => { callback = cb; return 12; }, cancelAnimationFrame: () => {} }), { fallbackMs: 30 });
    let calls = 0;
    scheduler.request(() => calls++);
    callback(123);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(calls, 1);
    assert.equal(scheduler.stats.rafCallbacks, 1);
    assert.equal(scheduler.stats.timerCallbacks, 0);
});

test('scheduler recovers when Worker rAF throws NotSupportedError', async () => {
    const scheduler = createWorkerFrameScheduler(scopeWithTimers({ requestAnimationFrame: () => { throw new Error('NotSupportedError'); } }), { fallbackMs: 5 });
    await new Promise((resolve) => scheduler.request(resolve));
    assert.equal(scheduler.stats.rafErrors, 1);
    assert.equal(scheduler.stats.timerCallbacks, 1);
});
