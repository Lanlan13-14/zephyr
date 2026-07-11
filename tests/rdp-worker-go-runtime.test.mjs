import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const worker = await fs.readFile(new URL('../public/rdp-worker.js', import.meta.url), 'utf8');
const client = await fs.readFile(new URL('../public/rdp-wasm-client.js', import.meta.url), 'utf8');

test('module Worker imports a lexical Go ESM class', () => {
    assert.match(worker, /import \{ Go as GoRuntime \} from '.\/vendor\/rdp-wasm\/wasm_exec\.mjs/);
    assert.match(worker, /new GoRuntime\(\)/);
    assert.doesNotMatch(worker, /globalThis\.Go|\bnew Go\(\)|import\('\.\/vendor\/rdp-wasm\/wasm_exec\.js/);
    assert.match(client, /globalThis\.Go/);
});

test('Go runtime converter emits an importable ESM class', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'go-esm-test-'));
    try {
        const input = join(dir, 'wasm_exec.js');
        const output = join(dir, 'wasm_exec.mjs');
        await fs.writeFile(input, '"use strict";\n(() => {\n globalThis.Go = class { constructor(){ this.importObject = {}; } };\n})();\n');
        const result = spawnSync(process.execPath, ['scripts/build-go-wasm-esm.mjs', input, output], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const module = await import(`file://${output}?v=${Date.now()}`);
        assert.equal(typeof module.Go, 'function');
        assert.ok(new module.Go().importObject);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
