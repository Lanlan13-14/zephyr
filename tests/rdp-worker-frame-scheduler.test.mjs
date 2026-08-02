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

test('scheduler presents the first fallback frame immediately', () => {
    let scheduledDelay = -1;
    const scheduler = createWorkerFrameScheduler({
        performance,
        requestAnimationFrame: () => 17,
        cancelAnimationFrame() {},
        setTimeout(_callback, delay) { scheduledDelay = delay; return 23; },
        clearTimeout() {},
    });
    const id = scheduler.request(() => {});
    assert.equal(scheduledDelay, 0);
    scheduler.cancel(id);
});

test('scheduler presents the first 144 FPS frame immediately', () => {
    let scheduledDelay = -1;
    const scheduler = createWorkerFrameScheduler({
        performance: { now: () => 100 },
        setTimeout(_callback, delay) { scheduledDelay = delay; return 1; },
        clearTimeout() {},
    }, { targetFps: 144 });
    const id = scheduler.request(() => {});
    assert.equal(scheduledDelay, 0);
    assert.equal(scheduler.stats.targetFps, 144);
    scheduler.cancel(id);
});

test('scheduler target FPS can change during an active session', () => {
    const delays = [];
    const scheduler = createWorkerFrameScheduler({
        performance: { now: () => 100 },
        setTimeout(_callback, delay) { delays.push(delay); return delays.length; },
        clearTimeout() {},
    }, { targetFps: 30 });
    const first = scheduler.request(() => {});
    scheduler.cancel(first);
    scheduler.setTargetFps(120);
    const second = scheduler.request(() => {});
    scheduler.cancel(second);
    assert.equal(delays[0], 0);
    assert.equal(delays[1], 0);
    assert.equal(scheduler.stats.targetFps, 120);
});

test('scheduler subtracts render work from the next 144 FPS interval', () => {
    let current = 100;
    const timers = [];
    const scheduler = createWorkerFrameScheduler({
        performance: { now: () => current },
        setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
        clearTimeout() {},
    }, { targetFps: 144 });

    scheduler.request(() => {});
    assert.equal(timers[0].delay, 0);
    timers[0].callback();

    current += 2; // compositor/render queue consumed 2 ms of this frame budget
    scheduler.request(() => {});
    assert.ok(Math.abs(timers[1].delay - ((1000 / 144) - 2)) < 0.01, `delay=${timers[1].delay}`);
});

test('scheduler presents immediately after being idle longer than one interval', () => {
    let current = 100;
    const timers = [];
    const scheduler = createWorkerFrameScheduler({
        performance: { now: () => current },
        setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
        clearTimeout() {},
    }, { targetFps: 60 });

    scheduler.request(() => {});
    current += timers[0].delay;
    timers[0].callback();
    current += 100;
    scheduler.request(() => {});
    assert.equal(timers[1].delay, 0);
});

test('scheduler exposes actual callback cadence separately from target FPS', () => {
    let current = 100;
    const timers = [];
    const scheduler = createWorkerFrameScheduler({
        performance: { now: () => current },
        setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
        clearTimeout() {},
    }, { targetFps: 144 });

    scheduler.request(() => {});
    timers[0].callback();
    current += 10;
    scheduler.request(() => {});
    timers[1].callback();
    assert.equal(scheduler.stats.callbacks, 2);
    assert.ok(Math.abs(scheduler.stats.effectiveFps - 100) < 0.01);
    assert.equal(scheduler.stats.targetFps, 144);
});
