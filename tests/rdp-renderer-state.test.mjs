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
        cacheEntries: new Map(),
        canvas: {},
        width: 100,
        height: 100,
        diagnostics: { presents: 0 },
        onFramesPresented: null,
        raf: null,
        requestFrame(callback) { this.callback = callback; return 1; },
        gl: {
            FRAMEBUFFER: 1, COLOR_BUFFER_BIT: 2, TEXTURE_2D: 3, TEXTURE0: 4,
            SCISSOR_TEST: 5,
            bindFramebuffer() {}, viewport() {}, clearColor() {}, clear() {}, enable() {}, scissor() {}, disable() {}, deleteFramebuffer() {}, deleteTexture() {},
        },
    });
    compositor._drawTexture = () => {};
    return compositor;
}

test('renderer keeps the realtime framebuffer discardable and captures offscreen on demand', () => {
    assert.match(source, /preserveDrawingBuffer:\s*false/);
    assert.match(source, /capturePixels\(\)[\s\S]*?_ensureCaptureFramebuffer/);
});

test('texture draw hot path reuses cached shader state and vertex storage', () => {
    const start = source.indexOf('_drawTexture(texture');
    const end = source.indexOf('_requireSurface(', start);
    const draw = source.slice(start, end);
    assert.match(draw, /bufferSubData/);
    assert.doesNotMatch(draw, /getAttribLocation|getUniformLocation|new Float32Array|bufferData/);
});

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

test('trusted AVC420 metadata commits only its declared dirty region', () => {
    const compositor = schedulingFixture();
    compositor.surfaces.set(4, { width: 200, height: 200, framebuffer: {} });
    compositor.stagingTexture = {};
    compositor.stagingWidth = 200;
    compositor.stagingHeight = 200;
    compositor._ensureStaging = () => {};
    const draws = [];
    compositor._drawTexture = (...args) => draws.push(args);
    compositor.gl = {
        TEXTURE_2D: 1, RGBA: 2, UNSIGNED_BYTE: 3,
        bindTexture() {}, texSubImage2D() {},
    };
    const frame = { displayWidth: 200, displayHeight: 200 };
    const count = compositor.uploadVideoFrame(4, { left: 20, top: 30, right: 120, bottom: 130 }, frame, [
        { left: 10, top: 20, right: 40, bottom: 60 },
    ], { trustRegions: true });
    assert.equal(count, 1);
    assert.deepEqual(draws[0][4], { left: 10, top: 20, right: 40, bottom: 60, width: 30, height: 40 });
    assert.deepEqual(draws[0][6], { u0: 0.05, v0: 0.3, u1: 0.2, v1: 0.1 });
});

test('large VOR green key fill preserves the existing desktop surface', () => {
    const compositor = schedulingFixture();
    compositor.surfaces.set(4, { width: 100, height: 100, framebuffer: {} });
    let clears = 0;
    compositor.gl.clear = () => { clears += 1; };
    compositor.solidFill(4, { left: 0, top: 0, right: 100, bottom: 100 }, 0xFF00FF00);
    assert.equal(clears, 0);
    assert.equal(compositor.diagnostics.vorKeyFillsSuppressed, 1);
});

test('thin exact VOR key fill is transparent without hiding ordinary green UI', () => {
    const compositor = schedulingFixture();
    compositor.surfaces.set(4, { width: 100, height: 100, framebuffer: {} });
    let clears = 0;
    compositor.gl.clear = () => { clears += 1; };
    compositor.solidFill(4, { left: 10, top: 10, right: 90, bottom: 11 }, 0xFF00FF00);
    assert.equal(clears, 0);
    assert.equal(compositor.diagnostics.vorKeyFillsSuppressed, 1);
    compositor.solidFill(4, { left: 10, top: 20, right: 90, bottom: 21 }, 0xFF20C020);
    assert.equal(clears, 1);
});

test('RESET_GRAPHICS captures the last mapped desktop before deleting old surfaces', () => {
    const compositor = schedulingFixture();
    compositor.width = 100;
    compositor.height = 80;
    compositor.surfaces.set(4, { mapped: true, width: 100, height: 80, framebuffer: {} });
    let captured = 0;
    compositor._captureResetCarry = () => { captured += 1; return true; };
    compositor.reset(60, 80);
    assert.equal(captured, 1);
    assert.equal(compositor.width, 60);
    assert.equal(compositor.height, 80);
    assert.equal(compositor.surfaces.size, 0);
});

test('first surface mapped across the resized desktop is seeded from the transition base once', () => {
    const compositor = schedulingFixture();
    compositor.width = 60;
    compositor.height = 80;
    compositor.resetCarryTexture = { carry: true };
    compositor.resetCarryFramebuffer = {};
    compositor.resetCarryWidth = 100;
    compositor.resetCarryHeight = 80;
    const draws = [];
    compositor._drawTexture = (...args) => draws.push(args);
    let discarded = 0;
    compositor._discardResetCarry = () => {
        discarded += 1;
        compositor.resetCarryTexture = null;
    };
    const overlay = { id: 1, width: 20, height: 20, framebuffer: {}, mapped: true, outputX: 0, outputY: 0, outputWidth: 20, outputHeight: 20 };
    assert.equal(compositor._seedSurfaceFromResetCarry(overlay), false);
    // Raw dimensions can differ from MAP_SURFACE_SCALED output dimensions.
    const desktop = { id: 2, width: 50, height: 70, framebuffer: {}, mapped: false, outputX: 0, outputY: 0, outputWidth: 50, outputHeight: 70 };
    compositor.surfaces.set(2, desktop);
    compositor.mapSurface(2, 0, 0, 60, 80);
    assert.equal(draws.length, 1);
    assert.deepEqual(draws[0][4], { left: 0, top: 0, right: 50, bottom: 70, width: 50, height: 70 });
    assert.equal(discarded, 1);
    assert.equal(compositor.diagnostics.resetCarrySeeded, 1);
    assert.equal(compositor._seedSurfaceFromResetCarry(desktop), false);
});

test('a repeated graphics reset without mapped surfaces preserves the last valid carry', () => {
    const compositor = schedulingFixture();
    const carry = { carry: true };
    compositor.resetCarryTexture = carry;
    compositor.resetCarryFramebuffer = {};
    let discarded = 0;
    compositor._discardResetCarry = () => { discarded += 1; compositor.resetCarryTexture = null; };
    assert.equal(compositor._captureResetCarry(), false);
    assert.equal(discarded, 0);
    assert.equal(compositor.resetCarryTexture, carry);
});

test('DELETE_SURFACE captures a mapped desktop before Windows sends RESET_GRAPHICS', () => {
    const compositor = schedulingFixture();
    compositor.surfaces.set(4, { id: 4, mapped: true, width: 100, height: 100, texture: {}, framebuffer: {} });
    let captured = 0;
    compositor._captureResetCarry = () => { captured += 1; return true; };
    compositor.deleteSurface(4);
    assert.equal(captured, 1);
    assert.equal(compositor.surfaces.has(4), false);
});

test('invalid video dirty metadata falls back to a full upload instead of leaving ghosts', () => {
    const compositor = schedulingFixture();
    compositor.surfaces.set(4, { width: 100, height: 100, framebuffer: {} });
    compositor.stagingTexture = {};
    compositor.stagingWidth = 100;
    compositor.stagingHeight = 100;
    compositor._ensureStaging = () => {};
    const draws = [];
    compositor._drawTexture = (...args) => draws.push(args);
    compositor.gl = { TEXTURE_2D: 1, RGBA: 2, UNSIGNED_BYTE: 3, bindTexture() {}, texSubImage2D() {} };
    const count = compositor.uploadVideoFrame(4, { left: 0, top: 0, right: 100, bottom: 100 }, { displayWidth: 100, displayHeight: 100 }, [
        { left: 40, top: 40, right: 40, bottom: 80 },
    ]);
    assert.equal(count, 1);
    assert.deepEqual(draws[0][4], { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 });
});

test('AVC444 main-frame mode draws only trusted regions and keeps VOR key pixels hidden', () => {
    const compositor = schedulingFixture();
    compositor.surfaces.set(4, { width: 100, height: 100, framebuffer: {} });
    compositor.stagingTexture = {};
    compositor.stagingWidth = 100;
    compositor.stagingHeight = 100;
    compositor._ensureStaging = () => {};
    const draws = [];
    compositor._drawTexture = (...args) => draws.push(args);
    compositor.gl = { TEXTURE_2D: 1, RGBA: 2, UNSIGNED_BYTE: 3, bindTexture() {}, texSubImage2D() {} };
    const count = compositor.uploadVideoFrame(4, { left: 0, top: 0, right: 100, bottom: 100 }, { displayWidth: 100, displayHeight: 100 }, [
        { left: 10, top: 20, right: 40, bottom: 60 },
    ], { trustRegions: true });
    assert.equal(count, 1);
    assert.deepEqual(draws[0][4], { left: 10, top: 20, right: 40, bottom: 60, width: 30, height: 40 });
});

test('macroblock-padded decoded frame is cropped to the complete protocol surface', () => {
    const compositor = schedulingFixture();
    compositor.surfaces.set(4, { width: 100, height: 100, framebuffer: {} });
    compositor.stagingTexture = {};
    compositor.stagingWidth = 120;
    compositor.stagingHeight = 104;
    compositor._ensureStaging = () => {};
    const draws = [];
    compositor._drawTexture = (...args) => draws.push(args);
    compositor.gl = { TEXTURE_2D: 1, RGBA: 2, UNSIGNED_BYTE: 3, bindTexture() {}, texSubImage2D() {} };
    const count = compositor.uploadVideoFrame(4, { left: 0, top: 0, right: 100, bottom: 100 }, { displayWidth: 120, displayHeight: 104 }, [
        { left: 10, top: 10, right: 20, bottom: 20 },
    ]);
    assert.equal(count, 1);
    assert.deepEqual(draws[0][4], { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 });
    assert.deepEqual(draws[0][6], { u0: 0, v0: 100 / 104, u1: 100 / 120, v1: 0 });
});

test('decoded frame smaller than the target scales the complete source', () => {
    const compositor = schedulingFixture();
    compositor.surfaces.set(4, { width: 100, height: 100, framebuffer: {} });
    compositor.stagingTexture = {};
    compositor.stagingWidth = 80;
    compositor.stagingHeight = 80;
    compositor._ensureStaging = () => {};
    const draws = [];
    compositor._drawTexture = (...args) => draws.push(args);
    compositor.gl = { TEXTURE_2D: 1, RGBA: 2, UNSIGNED_BYTE: 3, bindTexture() {}, texSubImage2D() {} };
    const count = compositor.uploadVideoFrame(4, { left: 0, top: 0, right: 100, bottom: 100 }, { displayWidth: 80, displayHeight: 80 }, [
        { left: 10, top: 10, right: 20, bottom: 20 },
    ]);
    assert.equal(count, 1);
    assert.deepEqual(draws[0][4], { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 });
    assert.deepEqual(draws[0][6], { u0: 0, v0: 1, u1: 1, v1: 0 });
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
