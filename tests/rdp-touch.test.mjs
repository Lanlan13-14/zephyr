import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../public/rdp-touch.js', import.meta.url), 'utf8');
const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const { RdpTouchController, applyPointerAcceleration } = mod;

Object.defineProperty(globalThis, 'navigator', { value: { vibrate() {} }, configurable: true });
let rafId = 0;
const rafCallbacks = new Map();
globalThis.requestAnimationFrame = (cb) => { const id = ++rafId; rafCallbacks.set(id, cb); return id; };
globalThis.cancelAnimationFrame = (id) => rafCallbacks.delete(id);

class MockCanvas {
    constructor() {
        this.width = 1000;
        this.height = 800;
        this.style = {};
        this.handlers = new Map();
        this.captured = new Set();
    }
    addEventListener(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(fn); }
    removeEventListener(type, fn) { this.handlers.get(type)?.delete(fn); }
    fire(type, event) { for (const fn of this.handlers.get(type) || []) fn(event); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 800 }; }
    setPointerCapture(id) { this.captured.add(id); }
    releasePointerCapture(id) { this.captured.delete(id); }
}

const point = (x, y) => ({ clientX: x, clientY: y });
const touchEvent = (touches, changedTouches = touches) => ({ touches, changedTouches, preventDefault() {} });

function fixture(options = {}) {
    const canvas = new MockCanvas();
    const events = { move: [], down: [], up: [], wheel: [], hwheel: [], combo: [] };
    const controller = new RdpTouchController({
        canvas,
        getConnected: () => true,
        canvasCoords: ({ clientX, clientY }) => ({ x: clientX, y: clientY }),
        sendMouseMove: (x, y) => events.move.push([x, y]),
        sendMouseDown: (b, x, y) => events.down.push([b, x, y]),
        sendMouseUp: (b, x, y) => events.up.push([b, x, y]),
        sendMouseWheel: (d) => events.wheel.push(d),
        sendMouseHWheel: (d) => events.hwheel.push(d),
        sendKeyCombo: (g) => events.combo.push(g),
        ...options,
    });
    return { canvas, events, controller };
}

test('single tap is immediate and double tap is exactly two clicks', () => {
    const { canvas, events, controller } = fixture();
    canvas.fire('touchstart', touchEvent([point(100, 120)]));
    canvas.fire('touchend', touchEvent([], [point(100, 120)]));
    assert.equal(events.down.length, 1);
    canvas.fire('touchstart', touchEvent([point(101, 121)]));
    canvas.fire('touchend', touchEvent([], [point(101, 121)]));
    assert.equal(events.down.length, 2, 'double tap must not generate a third click');
    controller.destroy();
});

test('double tap pairs by screen distance under remote-coordinate scaling', () => {
    // Simulate a phone-scale mapping: one CSS pixel becomes ~4 remote pixels.
    // A real finger drift of 20 CSS pixels used to become 80 remote pixels and
    // fail the old remote-pixel double-tap threshold.
    const canvas = new MockCanvas();
    const events = { move: [], down: [], up: [], wheel: [], hwheel: [], combo: [] };
    const controller = new RdpTouchController({
        canvas,
        getConnected: () => true,
        canvasCoords: ({ clientX, clientY }) => ({ x: clientX * 4, y: clientY * 4 }),
        sendMouseMove: (x, y) => events.move.push([x, y]),
        sendMouseDown: (b, x, y) => events.down.push([b, x, y]),
        sendMouseUp: (b, x, y) => events.up.push([b, x, y]),
        sendMouseWheel: (d) => events.wheel.push(d),
        sendMouseHWheel: (d) => events.hwheel.push(d),
        sendKeyCombo: (g) => events.combo.push(g),
    });
    canvas.fire('touchstart', touchEvent([point(100, 120)]));
    canvas.fire('touchend', touchEvent([], [point(100, 120)]));
    assert.equal(events.down.length, 1);
    canvas.fire('touchstart', touchEvent([point(120, 135)]));
    canvas.fire('touchend', touchEvent([], [point(120, 135)]));
    assert.equal(events.down.length, 2, 'screen-space double tap must still pair');
    controller.destroy();
});

test('small screen jitter does not promote a tap into a drag', () => {
    const { canvas, events, controller } = fixture();
    canvas.fire('touchstart', touchEvent([point(100, 100)]));
    // 8 CSS pixels used to exceed the old remote-pixel drag threshold under
    // typical phone scale. Screen-space threshold must keep this a pending tap.
    canvas.fire('touchmove', touchEvent([point(108, 104)]));
    assert.equal(controller._state?.type, 'pending');
    assert.equal(controller._state?.moved, false);
    assert.equal(events.down.length, 0, 'sub-threshold screen motion must not start a drag');
    controller.destroy();
});

test('distance-only two-finger pinch cannot zoom or scroll', () => {
    const { canvas, events, controller } = fixture();
    canvas.fire('touchstart', touchEvent([point(100, 100)]));
    canvas.fire('touchstart', touchEvent([point(100, 100), point(200, 100)]));
    canvas.fire('touchmove', touchEvent([point(50, 100), point(250, 100)]));
    canvas.fire('touchend', touchEvent([]));
    assert.deepEqual(events.wheel, []);
    assert.deepEqual(events.hwheel, []);
    assert.equal(controller._state, null);
    controller.destroy();
});

test('two-finger centroid motion sends both wheel axes and starts fling', () => {
    const { canvas, events, controller } = fixture();
    canvas.fire('touchstart', touchEvent([point(100, 100)]));
    canvas.fire('touchstart', touchEvent([point(100, 100), point(200, 100)]));
    controller._state.lastMoveTime -= 20;
    canvas.fire('touchmove', touchEvent([point(120, 130), point(220, 130)]));
    assert.equal(events.wheel.length, 1);
    assert.equal(events.hwheel.length, 1);
    canvas.fire('touchend', touchEvent([]));
    assert.notEqual(controller._flingRAF, null);
    controller.destroy();
});

test('relative mode taps and drags from virtual cursor', () => {
    const { canvas, events, controller } = fixture({ relativeMode: true, relativeSensitivity: 1 });
    canvas.fire('touchstart', touchEvent([point(900, 700)]));
    canvas.fire('touchend', touchEvent([], [point(900, 700)]));
    assert.deepEqual(events.down[0], [0, 500, 400]);
    canvas.fire('touchstart', touchEvent([point(10, 10)]));
    controller._state.startTime -= 20;
    canvas.fire('touchmove', touchEvent([point(30, 10)]));
    assert.ok(events.move.at(-1)[0] > 500);
    controller.destroy();
});

test('three-finger swipe emits shortcut but never zoom', () => {
    const { canvas, events, controller } = fixture();
    canvas.fire('touchstart', touchEvent([point(100, 200)]));
    canvas.fire('touchstart', touchEvent([point(100, 200), point(150, 200)]));
    canvas.fire('touchstart', touchEvent([point(100, 200), point(150, 200), point(200, 200)]));
    canvas.fire('touchmove', touchEvent([point(100, 140), point(150, 140), point(200, 140)]));
    canvas.fire('touchend', touchEvent([]));
    assert.deepEqual(events.combo, ['3up']);
    controller.destroy();
});

test('pen input maps to one precise mouse press lifecycle', () => {
    const { canvas, events, controller } = fixture();
    canvas.fire('pointerdown', { pointerType: 'pen', pointerId: 7, button: 0, buttons: 1, clientX: 40, clientY: 50, preventDefault() {} });
    canvas.fire('pointermove', { pointerType: 'pen', pointerId: 7, clientX: 45, clientY: 55, preventDefault() {} });
    canvas.fire('pointerup', { pointerType: 'pen', pointerId: 7, clientX: 45, clientY: 55, preventDefault() {} });
    assert.deepEqual(events.down, [[0, 40, 50]]);
    assert.deepEqual(events.up, [[0, 45, 55]]);
    assert.equal(events.move.length, 2);
    controller.destroy();
});

test('touchcancel releases a drag without generating a click', () => {
    const { canvas, events, controller } = fixture();
    canvas.fire('touchstart', touchEvent([point(20, 20)]));
    canvas.fire('touchmove', touchEvent([point(60, 20)]));
    assert.equal(events.down.length, 1);
    canvas.fire('touchcancel', touchEvent([]));
    assert.equal(events.up.length, 1);
    assert.equal(controller._state, null);
    controller.destroy();
});

test('acceleration is precise when slow and faster when velocity rises', () => {
    const slow = applyPointerAcceleration(2, 20, 1);
    const medium = applyPointerAcceleration(8, 20, 1);
    const fast = applyPointerAcceleration(30, 10, 1);
    assert.equal(slow, 1.2);
    assert.equal(medium, 9.6);
    assert.equal(fast, 60);
});

test('destroy removes all listeners and animation callbacks', () => {
    const { canvas, controller } = fixture();
    controller._startFling(1, 1);
    controller.destroy();
    for (const handlers of canvas.handlers.values()) assert.equal(handlers.size, 0);
    assert.equal(controller._flingRAF, null);
});
