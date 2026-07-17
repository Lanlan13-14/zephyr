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
