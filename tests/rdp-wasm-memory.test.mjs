import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../public/rdp-wasm-memory.js', import.meta.url), 'utf8');
const { WasmMemoryViewCache, createSynchronousBitmapUploader } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('linear-memory view refreshes after memory growth', () => {
    let memory = { buffer: new ArrayBuffer(16) };
    new Uint8Array(memory.buffer).set([1, 2, 3], 4);
    const cache = new WasmMemoryViewCache(() => memory);
    const first = cache.view(4, 3);
    assert.deepEqual([...first.bytes], [1, 2, 3]);
    memory = { buffer: new ArrayBuffer(32) };
    new Uint8Array(memory.buffer).set([4, 5, 6], 4);
    const second = cache.view(4, 3);
    assert.deepEqual([...second.bytes], [4, 5, 6]);
    assert.equal(second.generation, first.generation + 1);
});

test('out-of-bounds pixel pointers fail closed', () => {
    const cache = new WasmMemoryViewCache(() => ({ buffer: new ArrayBuffer(8) }));
    assert.throws(() => cache.view(7, 2), /outside linear memory/);
    assert.throws(() => cache.view(-1, 1), /outside linear memory/);
});

test('bitmap uploader consumes current view synchronously', () => {
    const memory = { buffer: new ArrayBuffer(8) };
    new Uint8Array(memory.buffer).set([9, 8, 7, 6], 0);
    const seen = [];
    const upload = createSynchronousBitmapUploader({ memoryProvider: () => memory, upload: (event) => seen.push([...event.data]) });
    upload({ pointer: 0, length: 4 });
    new Uint8Array(memory.buffer).fill(0);
    assert.deepEqual(seen, [[9, 8, 7, 6]]);
});
