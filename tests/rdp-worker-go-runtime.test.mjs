import fs from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

async function workerSource() { return fs.readFile(new URL('../public/rdp-worker.js', import.meta.url), 'utf8'); }

test('Worker resolves Go runtime through globalThis', async () => {
    const source = await workerSource();
    assert.ok(source.includes('const GoRuntime = globalThis.Go'));
    assert.ok(source.includes('new GoRuntime()'));
    assert.equal(source.includes('new Go()'), false);
});

test('page path also resolves Go runtime through globalThis', async () => {
    const source = await fs.readFile(new URL('../public/rdp-wasm-client.js', import.meta.url), 'utf8');
    assert.ok(source.includes('const GoRuntime = globalThis.Go'));
    assert.equal(source.includes('new Go()'), false);
});
