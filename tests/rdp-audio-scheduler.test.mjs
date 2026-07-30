import test from 'node:test';
import assert from 'node:assert/strict';
import { RdpAudioScheduler } from '../public/rdp-audio-scheduler.js';

class FakeSource {
    constructor() { this.startedAt = null; this.stopped = 0; this.disconnected = 0; this.onended = null; }
    connect() {}
    disconnect() { this.disconnected++; }
    start(at) { this.startedAt = at; }
    stop() { this.stopped++; }
}

class FakeContext {
    constructor() { this.currentTime = 10; this.state = 'running'; this.destination = {}; this.created = []; }
    createBufferSource() { const source = new FakeSource(); this.created.push(source); return source; }
}

test('audio scheduler chains chunks with a small target cushion', () => {
    const context = new FakeContext();
    const scheduler = new RdpAudioScheduler();
    scheduler.setContext(context);
    const first = scheduler.schedule({ duration: 0.04 });
    const second = scheduler.schedule({ duration: 0.04 });
    assert.ok(Math.abs(first.startedAt - 10.055) < 1e-9);
    assert.ok(Math.abs(second.startedAt - 10.095) < 1e-9);
    assert.ok(Math.abs(scheduler.nextAt - 10.135) < 1e-9);
});

test('audio scheduler stops stale queued sources on burst resync', () => {
    const context = new FakeContext();
    const scheduler = new RdpAudioScheduler();
    scheduler.setContext(context);
    const stale = scheduler.schedule({ duration: 0.25 });
    context.currentTime = 10.01;
    const fresh = scheduler.schedule({ duration: 0.04 });
    assert.equal(stale.stopped, 1, 'stale WebAudio node must not keep playing after resync');
    assert.equal(fresh.startedAt, 10.065);
    assert.ok(scheduler.nextAt - context.currentTime < 0.1);
});

test('explicit audio reset stops every queued source', () => {
    const context = new FakeContext();
    const scheduler = new RdpAudioScheduler();
    scheduler.setContext(context);
    const first = scheduler.schedule({ duration: 0.04 });
    const second = scheduler.schedule({ duration: 0.04 });
    scheduler.reset();
    assert.equal(first.stopped, 1);
    assert.equal(second.stopped, 1);
    assert.equal(scheduler.sources.size, 0);
});
