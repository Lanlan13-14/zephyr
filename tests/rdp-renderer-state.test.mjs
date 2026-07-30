import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../public/rdp-renderer.js', import.meta.url), 'utf8');
const { RdpGpuSurfaceCompositor } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function schedulingFixture() {
    const compositor = Object.create(RdpGpuSurfaceCompositor.prototype);
    Object.assign(compositor, {
        contextLost: false,
        dirty: true,
        sealedFrames: new Set(),
        framePending: new Map(),
        presentedFrames: [],
        surfaces: new Map(),
        width: 100,
        height: 100,
        diagnostics: { presents: 0 },
        onFramesPresented: null,
        raf: null,
        requestFrame(callback) { this.callback = callback; return 1; },
        gl: {
            FRAMEBUFFER: 1, COLOR_BUFFER_BIT: 2, TEXTURE_2D: 3, TEXTURE0: 4,
            bindFramebuffer() {}, viewport() {}, clearColor() {}, clear() {}, deleteFramebuffer() {}, deleteTexture() {},
        },
    });
    compositor._drawTexture = () => {};
    return compositor;
}

test('sealed frame waits for all asynchronous video tokens', () => {
    const compositor = schedulingFixture();
    compositor.beginFrame(7);
    compositor.addFramePending(7);
    compositor.endFrame(7);
    assert.equal(compositor.present(), false);
    assert.deepEqual(compositor.presentedFrames, []);
    compositor.completeFramePending(7);
    assert.equal(compositor.present(), true);
    assert.deepEqual(compositor.presentedFrames, [7]);
});

test('skipped asynchronous frame retires pending token without dirtying pixels', () => {
    const compositor = schedulingFixture();
    compositor.dirty = false;
    compositor.beginFrame(12);
    compositor.addFramePending(12);
    compositor.endFrame(12);
    compositor.completeFramePending(12, { dirty: false });
    assert.equal(compositor.dirty, false);
    assert.equal(compositor.framePending.has(12), false);
});

test('later ready frame cannot bypass an earlier pending frame', () => {
    const compositor = schedulingFixture();
    compositor.beginFrame(1);
    compositor.addFramePending(1);
    compositor.endFrame(1);
    compositor.beginFrame(2);
    compositor.endFrame(2);
    assert.equal(compositor.present(), false);
    compositor.completeFramePending(1);
    assert.equal(compositor.present(), true);
    assert.deepEqual(compositor.presentedFrames, [1, 2]);
});

test('multiple tiles in one frame schedule only one present callback', () => {
    const compositor = schedulingFixture();
    compositor.beginFrame(8);
    compositor.dirty = true;
    compositor.dirty = true;
    compositor.endFrame(8);
    const first = compositor.raf;
    compositor.schedulePresent();
    assert.equal(compositor.raf, first);
});

test('open FrameMarker holds present until EndFrame seals the frame', () => {
    const compositor = schedulingFixture();
    compositor.beginFrame(9);
    compositor.dirty = true;
    assert.equal(compositor.present(), false, 'mid-frame present would tear the desktop');
    compositor.endFrame(9);
    assert.equal(compositor.present(), true);
    assert.deepEqual(compositor.presentedFrames, [9]);
});

test('framed draw events do not schedule present until EndFrame', () => {
    const compositor = schedulingFixture();
    let scheduled = 0;
    compositor.schedulePresent = () => { scheduled += 1; };
    compositor.uploadBitmap = () => { compositor.dirty = true; };
    compositor.beginFrame(11);
    compositor.handleEvent({ kind: 8, frameId: 11, surfaceId: 1, rect: { left: 0, top: 0, right: 1, bottom: 1 }, data: new Uint8Array(4), stride: 4 });
    assert.equal(scheduled, 0);
    compositor.endFrame(11);
    assert.equal(scheduled, 1);
});

test('video frame upload draws only protocol dirty regions', () => {
    const compositor = schedulingFixture();
    compositor.surfaces.set(4, { width: 200, height: 200, framebuffer: {} });
    compositor.stagingTexture = {};
    compositor.stagingWidth = 100;
    compositor.stagingHeight = 100;
    compositor._ensureStaging = () => {};
    const draws = [];
    compositor._drawTexture = (...args) => draws.push(args);
    compositor.gl = {
        TEXTURE_2D: 1, RGBA: 2, UNSIGNED_BYTE: 3,
        bindTexture() {}, texSubImage2D() {},
    };
    const frame = { displayWidth: 100, displayHeight: 100 };
    const count = compositor.uploadVideoFrame(4, { left: 20, top: 30, right: 120, bottom: 130 }, frame, [
        { left: 10, top: 20, right: 40, bottom: 60 },
    ]);
    assert.equal(count, 1);
    assert.deepEqual(draws[0][4], { left: 30, top: 50, right: 60, bottom: 90, width: 30, height: 40 });
    assert.deepEqual(draws[0][6], { u0: 0.1, v0: 0.4, u1: 0.4, v1: 0.8 });
});

test('bitmap region upload copies only dirty source rectangles', () => {
    const compositor = schedulingFixture();
    compositor.surfaces.set(3, { width: 32, height: 32 });
    const uploads = [];
    compositor.uploadBitmap = (...args) => uploads.push(args);
    const bytes = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const count = compositor.uploadBitmapRegions(3, { left: 10, top: 20, right: 18, bottom: 28 }, bytes, 32, [
        { left: 2, top: 1, right: 5, bottom: 3 },
    ], false);
    assert.equal(count, 1);
    assert.deepEqual(uploads[0][1], { left: 12, top: 21, right: 15, bottom: 23 });
    assert.equal(uploads[0][3], 12);
    assert.equal(uploads[0][4], false);
    assert.deepEqual([...uploads[0][2].slice(0, 12)], [...bytes.slice(40, 52)]);
    assert.deepEqual([...uploads[0][2].slice(12, 24)], [...bytes.slice(72, 84)]);
});

test('classic bitmap event uploads to the unified desktop surface', () => {
    const compositor = schedulingFixture();
    let uploaded = null;
    compositor.ensureDesktopSurface = () => ({ id: 0 });
    compositor.uploadBitmap = (...args) => { uploaded = args; };
    compositor.uploadClassicBitmap({ left: 3, top: 4, right: 5, bottom: 6 }, new Uint8Array(16), 8);
    assert.equal(uploaded[0], 0);
    assert.deepEqual(uploaded[1], { left: 3, top: 4, right: 5, bottom: 6 });
});

test('surface cache commands preserve independent cached content', () => {
    const compositor = schedulingFixture();
    compositor.cacheEntries = new Map([[7, { slot: 7, width: 2, height: 2, texture: {}, framebuffer: {} }]]);
    assert.equal(compositor.cacheEntries.get(7).width, 2);
    compositor.evictCache(7);
    assert.equal(compositor.cacheEntries.has(7), false);
});

test('surface definitions remain independent', () => {
    const compositor = schedulingFixture();
    compositor.surfaces.set(1, { id: 1, width: 10 });
    compositor.surfaces.set(2, { id: 2, width: 20 });
    assert.equal(compositor._requireSurface(1).width, 10);
    assert.equal(compositor._requireSurface(2).width, 20);
    assert.throws(() => compositor._requireSurface(3), /unknown RDP surface/);
});
