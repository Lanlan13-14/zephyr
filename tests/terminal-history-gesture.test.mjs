import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalHistoryGesture } from '../public/terminal-history-gesture.js';

function harness({ min = -500, max = 0, start = 0 } = {}) {
    let position = start;
    let clock = 0;
    let nextId = 1;
    const frames = new Map();
    const calls = [];
    const events = [];
    const gesture = createTerminalHistoryGesture({
        getRowHeight: () => 20,
        now: () => clock,
        requestFrame: (fn) => { const id = nextId++; frames.set(id, fn); return id; },
        cancelFrame: (id) => frames.delete(id),
        scrollLines: (lines, reason) => {
            const before = position;
            position = Math.max(min, Math.min(max, position + lines));
            const moved = position - before;
            calls.push({ lines, moved, reason });
            return moved;
        },
        onGestureStart: (reason) => events.push(`start:${reason}`),
        onGestureEnd: (reason) => events.push(`end:${reason}`),
    });
    const step = (ms = 16) => {
        clock += ms;
        const batch = [...frames.entries()];
        frames.clear();
        batch.forEach(([, fn]) => fn(clock));
    };
    return { gesture, step, calls, events, get position() { return position; }, get frames() { return frames.size; } };
}

test('sub-row drag accumulates instead of feeling stuck', () => {
    const h = harness({ min: -500, max: 500 });
    h.gesture.start(200, 0);
    assert.equal(h.gesture.move(193, 16).lines, 0);
    assert.equal(h.gesture.move(186, 32).lines, 0);
    assert.equal(h.gesture.move(179, 48).lines, 1);
    assert.equal(h.position, 1, 'upward finger advances viewport toward newer positive rows');
    const moved = h.calls.reduce((sum, x) => sum + Math.abs(x.moved), 0);
    assert.equal(moved, 1);
});

test('downward drag scrolls deep into older history with native touch direction', () => {
    const h = harness({ min: -500, max: 500, start: 0 });
    h.gesture.start(180, 0);
    const result = h.gesture.move(300, 40);
    assert.equal(result.moved, true);
    assert.ok(result.lines <= -6, `expected at least 6 older rows, got ${result.lines}`);
    assert.ok(h.position <= -6);
});

test('fast release continues with inertial fling and decays', () => {
    const h = harness({ min: -1000, max: 1000 });
    h.gesture.start(300, 0);
    h.gesture.move(220, 16);
    const before = h.position;
    h.gesture.end();
    assert.ok(h.frames > 0, 'fling should schedule a frame');
    for (let i = 0; i < 80 && h.frames; i++) h.step(16);
    assert.notEqual(h.position, before, 'fling should add travel after release');
    assert.equal(h.frames, 0, 'fling must settle');
    assert.ok(h.events.some((x) => x.startsWith('end:fling-')));
});

test('boundary stops fling and clears accumulated pressure', () => {
    const h = harness({ min: -3, max: 3, start: 0 });
    h.gesture.start(300, 0);
    h.gesture.move(100, 16);
    h.gesture.end();
    for (let i = 0; i < 10 && h.frames; i++) h.step(16);
    assert.equal(Math.abs(h.position), 3);
    assert.equal(h.frames, 0);
});

test('tap below threshold does not lock scrolling or fling', () => {
    const h = harness();
    h.gesture.start(100, 0);
    const result = h.gesture.move(98, 20);
    assert.equal(result.moved, false);
    h.gesture.end();
    assert.deepEqual(h.events, ['end:touch-tap']);
    assert.equal(h.frames, 0);
});
