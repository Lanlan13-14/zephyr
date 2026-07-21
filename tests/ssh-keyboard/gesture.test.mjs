import test from 'node:test';
import assert from 'node:assert/strict';
import { createGestureClassifier, GestureKind } from '../../public/ssh-keyboard/gesture.js';

test('clean tap opens path: short press no move', () => {
    const g = createGestureClassifier();
    g.pointerDown({ x: 10, y: 10, time: 0 });
    g.pointerMove({ x: 12, y: 11, time: 50 }); // <10px
    const r = g.pointerUp({ x: 12, y: 11, time: 120 });
    assert.equal(r.kind, GestureKind.TAP);
    assert.equal(r.suppressOpen, false);
    assert.equal(g.mayOpenFromLastResult(), true);
});

test('pan does not open', () => {
    const g = createGestureClassifier();
    g.pointerDown({ x: 0, y: 0, time: 0 });
    g.pointerMove({ x: 0, y: 40, time: 80 });
    const r = g.pointerUp({ x: 0, y: 50, time: 160 });
    assert.equal(r.kind, GestureKind.PAN);
    assert.equal(r.suppressOpen, true);
    assert.equal(g.mayOpenFromLastResult(), false);
});

test('fling suppresses subsequent tap window', () => {
    const g = createGestureClassifier({ flingVelocityPxPerMs: 0.4, flingSuppressMs: 300 });
    g.pointerDown({ x: 0, y: 0, time: 1000 });
    g.pointerMove({ x: 0, y: 30, time: 1020 });
    g.pointerMove({ x: 0, y: 80, time: 1040 });
    const r = g.pointerUp({ x: 0, y: 120, time: 1050 });
    assert.equal(r.kind, GestureKind.FLING);
    assert.equal(g.isFlingActive(1100), true);
    // synthetic tap during fling suppress
    g.pointerDown({ x: 5, y: 5, time: 1100 });
    const tap = g.pointerUp({ x: 5, y: 5, time: 1200 });
    assert.equal(tap.kind, GestureKind.TAP);
    // suppressOpen true because fling window still active at pointerUp time uses Date.now —
    // force check via mayOpenFromLastResult with explicit at
    assert.equal(g.mayOpenFromLastResult({ at: 1100 }), false);
});

test('pinch never opens', () => {
    const g = createGestureClassifier();
    g.pointerDown({ x: 0, y: 0, time: 0, pointerCount: 2 });
    g.pointerMove({ x: 10, y: 10, time: 40, pointerCount: 2 });
    const r = g.pointerUp({ x: 10, y: 10, time: 80, pointerCount: 1 });
    assert.equal(r.kind, GestureKind.PINCH);
    assert.equal(r.suppressOpen, true);
});

test('longpress never opens', () => {
    const g = createGestureClassifier({ longPressMs: 500 });
    g.pointerDown({ x: 0, y: 0, time: 0 });
    g.pointerMove({ x: 1, y: 1, time: 520 });
    const r = g.pointerUp({ x: 1, y: 1, time: 560 });
    assert.equal(r.kind, GestureKind.LONGPRESS);
    assert.equal(r.suppressOpen, true);
});

test('selection blocks mayOpen even for tap', () => {
    const g = createGestureClassifier();
    g.pointerDown({ x: 0, y: 0, time: 0 });
    g.pointerUp({ x: 0, y: 0, time: 100 });
    assert.equal(g.mayOpenFromLastResult({ hasSelection: true }), false);
    assert.equal(g.mayOpenFromLastResult({ hasSelection: false }), true);
});

test('cancel yields cancelled', () => {
    const g = createGestureClassifier();
    g.pointerDown({ x: 0, y: 0, time: 0 });
    const r = g.pointerCancel({ time: 30 });
    assert.equal(r.kind, GestureKind.CANCELLED);
    assert.equal(r.suppressOpen, true);
});
