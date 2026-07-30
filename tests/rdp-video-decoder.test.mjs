import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

async function browserModule(path) {
    const source = await fs.readFile(new URL(path, import.meta.url), 'utf8');
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const { RdpAvc420Decoder, h264CodecFromAnnexB } = await browserModule('../public/rdp-video-decoder.js');

class FakeChunk { constructor(init) { Object.assign(this, init); } }
class FakeDecoder {
    static async isConfigSupported(config) { return { supported: true, config }; }
    constructor(callbacks) { this.callbacks = callbacks; this.decodeQueueSize = 0; this.inputs = []; }
    configure(config) { this.config = config; }
    decode(chunk) { this.inputs.push(chunk); this.decodeQueueSize++; }
    output(index = 0) { const chunk = this.inputs[index]; this.decodeQueueSize--; this.callbacks.output({ timestamp: chunk.timestamp, close() {} }); }
    reset() { this.decodeQueueSize = 0; }
    close() {}
}

test('Annex-B SPS selects actual H.264 profile and level', () => {
    const high = new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x33, 1]);
    const main = new Uint8Array([0, 0, 1, 0x67, 0x4d, 0x40, 0x29, 1]);
    assert.equal(h264CodecFromAnnexB(high), 'avc1.640033');
    assert.equal(h264CodecFromAnnexB(main), 'avc1.4D4029');
});

test('decoder reconfigures from SPS instead of forcing Baseline', () => {
    const decoder = new RdpAvc420Decoder({ Decoder: FakeDecoder, Chunk: FakeChunk });
    decoder.decode({ surfaceId: 1, frameId: 1, stream1: { key: true, data: new Uint8Array([0, 0, 1, 0x67, 0x4d, 0x40, 0x29, 0, 0, 1, 0x65]) } });
    assert.equal(decoder.decoders.get('1:1').decoder.config.codec, 'avc1.4D4029');
});

test('AVC420 decoder preserves dirty-region metadata with output frames', () => {
    const regions = [{ left: 5, top: 6, right: 30, bottom: 40 }];
    const outputs = [];
    const decoder = new RdpAvc420Decoder({ Decoder: FakeDecoder, Chunk: FakeChunk, onFrame: (_frame, event) => outputs.push(event.stream1.regions) });
    decoder.decode({ surfaceId: 3, frameId: 1, stream1: { key: false, regions, data: new Uint8Array([1]) } });
    decoder.decoders.get('3:1').decoder.output(0);
    assert.deepEqual(outputs, [regions]);
});

test('AVC420 decoder preserves every compressed input in order', () => {
    const outputs = [];
    const decoder = new RdpAvc420Decoder({ Decoder: FakeDecoder, Chunk: FakeChunk, onFrame: (_frame, event, token) => outputs.push([event.frameId, token]) });
    const base = { surfaceId: 3, stream1: { key: false, data: new Uint8Array([1]) } };
    const tokens = [1, 2, 3].map((frameId) => decoder.decode({ ...base, frameId }));
    const state = decoder.decoders.get('3:1');
    assert.equal(state.decoder.inputs.length, 3);
    assert.deepEqual(state.decoder.inputs.map((chunk) => chunk.timestamp), tokens);
    state.decoder.output(0);
    state.decoder.output(1);
    state.decoder.output(2);
    assert.deepEqual(outputs.map(([frameId]) => frameId), [1, 2, 3]);
});

test('queue saturation fails explicitly instead of dropping a delta chunk', () => {
    const decoder = new RdpAvc420Decoder({ Decoder: FakeDecoder, Chunk: FakeChunk, maxQueue: 1 });
    const event = { surfaceId: 1, frameId: 1, stream1: { key: false, data: new Uint8Array([1]) } };
    decoder.decode(event);
    assert.throws(() => decoder.decode({ ...event, frameId: 2 }), /queue exceeded/);
    const state = decoder.decoders.get('1:1');
    assert.equal(state.decoder.inputs.length, 1, 'saturated input must not be reported as accepted');
});

test('decoder state is isolated by surface', () => {
    const decoder = new RdpAvc420Decoder({ Decoder: FakeDecoder, Chunk: FakeChunk });
    for (const surfaceId of [1, 2]) decoder.decode({ surfaceId, frameId: surfaceId, stream1: { key: true, data: new Uint8Array([surfaceId]) } });
    assert.equal(decoder.decoders.size, 2);
    decoder.resetSurface(1);
    assert.equal(decoder.decoders.has('1:1'), false);
    assert.equal(decoder.decoders.has('2:1'), true);
});

test('AVC444 combiner matches BT.709 limited-range reference samples', async () => {
    const { combineAvc444Planes } = await browserModule('../public/rdp-video-decoder.js');
    const main = { Y: new Uint8Array([16, 235, 81, 145]), U: new Uint8Array([128]), V: new Uint8Array([128]), yStride: 4, uStride: 1, vStride: 1, fullRange: false };
    const aux = { Y: new Uint8Array([128, 128, 128, 128]), U: new Uint8Array([128, 128]), V: new Uint8Array([128, 128]), yStride: 4, uStride: 2, vStride: 2 };
    const out = combineAvc444Planes(main, aux, 4, 1);
    assert.deepEqual([...out.slice(0, 4)], [0, 0, 0, 255]);
    assert.deepEqual([...out.slice(4, 8)], [255, 255, 255, 255]);
});

test('AVC444 LC2 placement follows the Go reference odd/even rules', async () => {
    const { combineAvc444Planes } = await browserModule('../public/rdp-video-decoder.js');
    const main = { Y: new Uint8Array(8).fill(128), U: new Uint8Array([10, 20]), V: new Uint8Array([30, 40]), yStride: 4, uStride: 2, vStride: 2, fullRange: true };
    const aux = { Y: new Uint8Array([50, 60, 70, 80, 51, 61, 71, 81]), U: new Uint8Array([90, 100]), V: new Uint8Array([110, 120]), yStride: 4, uStride: 2, vStride: 2 };
    const out = combineAvc444Planes(main, aux, 4, 2);
    assert.equal(out.length, 32);
    assert.notDeepEqual([...out.slice(0, 4)], [...out.slice(4, 8)], 'odd columns must use auxiliary Y chroma');
    assert.notDeepEqual([...out.slice(16, 20)], [...out.slice(24, 28)], 'odd rows must use split auxiliary U/V chroma');
});

test('AVC444 corruption guards reject blank and saturated chroma', async () => {
    const { avc444AuxLooksCorrupt, avc444MainLooksCorrupt } = await browserModule('../public/rdp-video-decoder.js');
    const aux = (value) => ({
        width: 16, height: 4,
        Y: new Uint8Array(16 * 4).fill(value), U: new Uint8Array(8 * 2).fill(value), V: new Uint8Array(8 * 2).fill(value),
        yStride: 16, uStride: 8, vStride: 8,
    });
    const main = (u, v) => ({
        width: 16, height: 4,
        U: new Uint8Array(8 * 2).fill(u), V: new Uint8Array(8 * 2).fill(v), uStride: 8, vStride: 8,
    });
    assert.equal(avc444AuxLooksCorrupt(aux(128)), false);
    assert.equal(avc444AuxLooksCorrupt(aux(0)), true);
    assert.equal(avc444AuxLooksCorrupt(aux(255)), true);
    assert.equal(avc444MainLooksCorrupt(main(128, 128)), false);
    assert.equal(avc444MainLooksCorrupt(main(0, 0)), true);
    assert.equal(avc444MainLooksCorrupt(main(255, 255)), true);
});

test('AVC444 dirty-region filter drops only corrupt tiles', async () => {
    const { filterAvc444Regions } = await browserModule('../public/rdp-video-decoder.js');
    const width = 256, height = 256, half = 128, quarter = 64;
    const aux = {
        width, height,
        Y: new Uint8Array(width * height).fill(128),
        U: new Uint8Array(half * half).fill(128),
        V: new Uint8Array(half * half).fill(128),
        yStride: width, uStride: half, vStride: half,
    };
    for (let y = 0; y < 128; y++) {
        aux.Y.fill(0, y * width, y * width + 64);
        aux.Y.fill(0, y * width + half, y * width + half + 64);
    }
    for (let y = 0; y < 64; y++) {
        for (const plane of [aux.U, aux.V]) {
            plane.fill(0, y * half, y * half + 32);
            plane.fill(0, y * half + quarter, y * half + quarter + 32);
        }
    }
    const result = filterAvc444Regions(aux, [{ left: 0, top: 0, right: width, bottom: height }], width, height, 128);
    assert.equal(result.rejected, 1);
    assert.deepEqual(result.regions, [
        { left: 128, top: 0, right: 256, bottom: 128 },
        { left: 0, top: 128, right: 128, bottom: 256 },
        { left: 128, top: 128, right: 256, bottom: 256 },
    ]);
});

test('AVC444 prepares concurrently but applies frames in surface order', async () => {
    const { RdpAvc444Decoder } = await browserModule('../public/rdp-video-decoder.js');
    const decoder = new RdpAvc444Decoder({ Decoder: FakeDecoder, Chunk: FakeChunk });
    const resolvers = new Map();
    const applied = [];
    decoder._prepare = (event) => new Promise((resolve) => resolvers.set(event.frameId, resolve));
    decoder._applyPrepared = (_prepared, event) => { applied.push(event.frameId); return true; };
    const first = decoder.decode({ surfaceId: 9, frameId: 1 });
    const second = decoder.decode({ surfaceId: 9, frameId: 2 });
    resolvers.get(2)({});
    await Promise.resolve();
    assert.deepEqual(applied, [], 'later decode completion must wait for the earlier surface update');
    resolvers.get(1)({});
    await Promise.all([first, second]);
    assert.deepEqual(applied, [1, 2]);
});

test('AVC444 LC0 primes auxiliary state but displays only the safe main frame', async () => {
    const { RdpAvc444Decoder } = await browserModule('../public/rdp-video-decoder.js');
    const uploads = [], combines = [];
    const frame = { closeCalls: 0, close() { this.closeCalls++; } };
    const decoder = new RdpAvc444Decoder({
        Decoder: FakeDecoder,
        Chunk: FakeChunk,
        onMainFrame: (outputFrame, event) => { uploads.push(event.frameId); outputFrame.close?.(); },
        onCombinedBitmap: (...args) => combines.push(args),
    });
    decoder._prepare = async () => ({
        lc: 0,
        main: { width: 16, height: 4, U: new Uint8Array(16).fill(128), V: new Uint8Array(16).fill(128), uStride: 8, vStride: 8 },
        mainFrame: frame,
    });
    await decoder.decode({ surfaceId: 5, frameId: 8, stream1: { key: true }, stream2: { regions: [] } });
    assert.deepEqual(uploads, [8]);
    assert.deepEqual(combines, []);
    assert.equal(frame.closeCalls, 1);
});

test('AVC444 main frames upload only from the ordered apply stage', async () => {
    const { RdpAvc444Decoder } = await browserModule('../public/rdp-video-decoder.js');
    const uploads = [];
    const frame = { closeCalls: 0, close() { this.closeCalls++; } };
    const decoder = new RdpAvc444Decoder({ Decoder: FakeDecoder, Chunk: FakeChunk, onMainFrame: (outputFrame, event) => { uploads.push(event.frameId); outputFrame.close?.(); } });
    decoder._prepare = async () => ({ lc: 1, main: { width: 2, height: 2, U: new Uint8Array([128]), V: new Uint8Array([128]), uStride: 1, vStride: 1 }, mainFrame: frame });
    await decoder.decode({ surfaceId: 4, frameId: 7, stream1: { key: true } });
    assert.deepEqual(uploads, [7]);
    assert.equal(frame.closeCalls, 1);
});
