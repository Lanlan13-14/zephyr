import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSafeRdpSize } from '../public/rdp-resolution-policy.js';

test('named tiers are bounded standard resolutions at 16:9', () => {
    assert.deepEqual(computeSafeRdpSize({ resolution: '1080p', viewportWidth: 1600, viewportHeight: 900 }), { width: 1920, height: 1080 });
    assert.deepEqual(computeSafeRdpSize({ resolution: '2K', viewportWidth: 1600, viewportHeight: 900 }), { width: 2560, height: 1440 });
    assert.deepEqual(computeSafeRdpSize({ resolution: '4K', viewportWidth: 1600, viewportHeight: 900 }), { width: 3840, height: 2160 });
});

test('shallow viewport cannot turn 2K into an unsafe ultra-wide desktop', () => {
    const size = computeSafeRdpSize({ resolution: '2K', viewportWidth: 620, viewportHeight: 126 });
    assert.deepEqual(size, { width: 2560, height: 520 });
    assert.ok(size.width <= 2560);
    assert.ok(size.height <= 1440);
});

test('portrait orientation rotates the tier envelope and keeps the aspect', () => {
    const size = computeSafeRdpSize({ resolution: '2K', viewportWidth: 390, viewportHeight: 844 });
    assert.deepEqual(size, { width: 1182, height: 2560 });
});

test('auto uses physical viewport pixels with a protocol-safe minimum edge', () => {
    assert.deepEqual(computeSafeRdpSize({ resolution: 'auto', viewportWidth: 620, viewportHeight: 126, devicePixelRatio: 1 }), { width: 620, height: 200 });
});

test('stored 8K and legacy 8K values are capped to the supported 4K envelope', () => {
    assert.deepEqual(computeSafeRdpSize({ resolution: '8K', viewportWidth: 1600, viewportHeight: 900 }), { width: 3840, height: 2160 });
    assert.deepEqual(computeSafeRdpSize({ resolution: '7680x4320', viewportWidth: 1600, viewportHeight: 900 }), { width: 3840, height: 2160 });
});
