import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('module Worker resolves Go runtime through globalThis', async () => {
    const worker = await fs.readFile(new URL('../public/rdp-worker.js', import.meta.url), 'utf8');
    assert.ok(worker.includes('const GoRuntime = globalThis.Go'));
    assert.ok(worker.includes('new GoRuntime()'));
    assert.equal(/\bnew Go\(\)/.test(worker), false);
    assert.ok(worker.includes("Go WASM runtime did not register globalThis.Go"));
});
