import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../public/rdp-input-channel.js', import.meta.url), 'utf8');
const { OrderedRdpInputChannel } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function frameFixture() {
    let nextId = 0;
    const callbacks = new Map();
    return {
        requestFrame(callback) { const id = ++nextId; callbacks.set(id, callback); return id; },
        cancelFrame(id) { callbacks.delete(id); },
        fire() { const pending = [...callbacks.values()]; callbacks.clear(); for (const callback of pending) callback(16); },
        size() { return callbacks.size; },
    };
}

test('only consecutive mouse moves are coalesced', () => {
    const sent = [];
    const frame = frameFixture();
    const channel = new OrderedRdpInputChannel((event) => sent.push(event), { now: () => 1, requestFrame: frame.requestFrame, cancelFrame: frame.cancelFrame });
    channel.push('mouse-move', { x: 1 });
    channel.push('mouse-move', { x: 2 });
    assert.equal(sent.length, 0);
    assert.equal(frame.size(), 1);
    channel.push('mouse-down', { button: 0 });
    assert.deepEqual(sent.map((event) => [event.type, event.payload.x ?? event.payload.button]), [['mouse-move', 2], ['mouse-down', 0]]);
    assert.equal(frame.size(), 0);
});

test('pending mouse move is delivered on the next frame without a barrier', () => {
    const sent = [];
    const frame = frameFixture();
    const channel = new OrderedRdpInputChannel((event) => sent.push(event), { requestFrame: frame.requestFrame, cancelFrame: frame.cancelFrame });
    channel.push('mouse-move', { x: 10, y: 20 });
    channel.push('mouse-move', { x: 11, y: 21 });
    frame.fire();
    assert.deepEqual(sent.map((event) => [event.type, event.payload.x, event.payload.y]), [['mouse-move', 11, 21]]);
});

test('wheel axes and key/button barriers preserve sequence', () => {
    const sent = [];
    const channel = new OrderedRdpInputChannel((event) => sent.push(event));
    for (const [type, payload] of [['wheel', { delta: 1 }], ['hwheel', { delta: 2 }], ['key-down', { code: 'KeyA' }], ['key-up', { code: 'KeyA' }]]) channel.push(type, payload);
    assert.deepEqual(sent.map((event) => event.type), ['wheel', 'hwheel', 'key-down', 'key-up']);
    assert.deepEqual(sent.map((event) => event.sequence), [1, 2, 3, 4]);
});

test('native Unicode text is an ordering barrier', () => {
    const sent = [];
    const frame = frameFixture();
    const channel = new OrderedRdpInputChannel((event) => sent.push(event), { requestFrame: frame.requestFrame, cancelFrame: frame.cancelFrame });
    channel.push('mouse-move', { x: 20, y: 30 });
    channel.push('unicode-text', { text: '中文😀' });
    assert.deepEqual(sent.map((event) => event.type), ['mouse-move', 'unicode-text']);
    assert.equal(sent[1].payload.text, '中文😀');
});

test('releaseAll cancels pending move and releases held states', () => {
    const sent = [];
    const channel = new OrderedRdpInputChannel((event) => sent.push(event));
    channel.push('key-down', { code: 'ControlLeft' });
    channel.push('mouse-down', { button: 0 });
    channel.push('mouse-move', { x: 9, y: 9 });
    channel.releaseAll();
    assert.deepEqual(sent.map((event) => event.type), ['key-down', 'mouse-down', 'key-up', 'mouse-up']);
    assert.equal(sent.some((event) => event.type === 'mouse-move'), false);
});

test('layout version change is an ordering barrier', () => {
    const sent = [];
    const channel = new OrderedRdpInputChannel((event) => sent.push(event));
    channel.push('mouse-move', { x: 1 });
    channel.setLayoutVersion(2);
    channel.push('mouse-down', { button: 0 });
    assert.deepEqual(sent.map((event) => event.layoutVersion), [0, 2]);
});
