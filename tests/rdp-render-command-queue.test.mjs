import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderedRenderCommandQueue } from '../public/rdp-render-command-queue.js';

test('later bitmap waits for earlier asynchronous video command', () => {
    const applied = [];
    const queue = new OrderedRenderCommandQueue();
    const video = queue.reserve('video');
    queue.enqueue(() => applied.push('close-video'), 'bitmap');
    assert.deepEqual(applied, []);
    video.resolve(() => applied.push('video'));
    assert.deepEqual(applied, ['video', 'close-video']);
});

test('out-of-order decoder completion still applies protocol order', () => {
    const applied = [];
    const queue = new OrderedRenderCommandQueue();
    const first = queue.reserve('video-1');
    const second = queue.reserve('video-2');
    second.resolve(() => applied.push(2));
    assert.deepEqual(applied, []);
    first.resolve(() => applied.push(1));
    assert.deepEqual(applied, [1, 2]);
});

test('skipped bad video releases later surface commands', () => {
    const applied = [];
    const queue = new OrderedRenderCommandQueue();
    const video = queue.reserve('bad-video');
    queue.enqueue(() => applied.push('newer-bitmap'));
    video.skip();
    assert.deepEqual(applied, ['newer-bitmap']);
    assert.equal(queue.stats.skipped, 1);
});

test('queue fails explicitly instead of growing without bound', () => {
    const queue = new OrderedRenderCommandQueue({ maxDepth: 8 });
    queue.reserve('blocker');
    for (let i = 0; i < 7; i++) queue.enqueue(() => {}, `queued-${i}`);
    assert.throws(() => queue.enqueue(() => {}, 'overflow'), /exceeded 8/);
});

test('dispose runs after delayed apply and on clear', () => {
    const disposed = [];
    const queue = new OrderedRenderCommandQueue();
    const first = queue.reserve('first');
    const second = queue.reserve('second');
    second.resolve(() => {}, () => disposed.push('second'));
    first.resolve(() => {}, () => disposed.push('first'));
    assert.deepEqual(disposed, ['first', 'second']);
    const blocker = queue.reserve('blocker');
    const pending = queue.reserve('pending');
    pending.resolve(() => {}, () => disposed.push('pending'));
    queue.clear();
    assert.deepEqual(disposed, ['first', 'second', 'pending']);
    blocker.resolve(() => {});
    assert.equal(queue.depth, 0);
});
