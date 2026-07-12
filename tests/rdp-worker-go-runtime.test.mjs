import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGoRuntime, instantiateGoWasm } from '../public/rdp-wasm-runtime.js';

const worker = await fs.readFile(new URL('../public/rdp-worker.js', import.meta.url), 'utf8');
const client = await fs.readFile(new URL('../public/rdp-wasm-client.js', import.meta.url), 'utf8');

function response(bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), { ok = true, status = 200, mime = 'application/wasm' } = {}) {
    return {
        ok,
        status,
        clone() { return response(bytes, { ok, status, mime }); },
        async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
        headers: { get(name) { return name.toLowerCase() === 'content-type' ? mime : null; } },
    };
}

test('worker and page fallback share the lexical Go ESM loader', () => {
    assert.match(worker, /loadGoRuntime\(\{ pipeline: 'worker-gpu-v2' \}\)/);
    assert.match(client, /loadGoRuntime\(\{ pipeline: 'gpu-v2-page' \}\)/);
    for (const source of [worker, client]) {
        assert.doesNotMatch(source, /globalThis\.Go|\bnew Go\(\)|wasm_exec\.js/);
    }
});

test('Go runtime loader consumes the named export without a global side effect', async () => {
    const previous = globalThis.Go;
    delete globalThis.Go;
    try {
        class Go {}
        const runtime = await loadGoRuntime({ importer: async () => ({ Go }), pipeline: 'test' });
        assert.equal(runtime, Go);
        assert.equal(globalThis.Go, undefined);
    } finally {
        if (previous !== undefined) globalThis.Go = previous;
    }
});

test('Go runtime loader reports pipeline, URL and available exports', async () => {
    await assert.rejects(
        loadGoRuntime({ runtimeUrl: '/broken/runtime.mjs', importer: async () => ({ NotGo: class {} }), pipeline: 'gpu-v2-page' }),
        /ESM export 'Go'.*pipeline=gpu-v2-page.*url=\/broken\/runtime\.mjs.*exports=NotGo/,
    );
});

test('WASM loader reports HTTP failures before instantiation', async () => {
    class Go { constructor() { this.importObject = {}; } }
    await assert.rejects(
        instantiateGoWasm(Go, { wasmUrl: '/missing.wasm', fetchImpl: async () => response(undefined, { ok: false, status: 404 }), pipeline: 'worker-gpu-v2' }),
        /pipeline=worker-gpu-v2.*url=\/missing\.wasm.*status=404/,
    );
});

test('WASM loader falls back to bytes when streaming rejects a MIME type', async () => {
    class Go { constructor() { this.importObject = {}; } }
    const originalStreaming = WebAssembly.instantiateStreaming;
    WebAssembly.instantiateStreaming = async () => { throw new TypeError('bad MIME'); };
    try {
        const loaded = await instantiateGoWasm(Go, { fetchImpl: async () => response(undefined, { mime: 'application/octet-stream' }), pipeline: 'test' });
        assert.ok(loaded.result.instance instanceof WebAssembly.Instance);
    } finally {
        WebAssembly.instantiateStreaming = originalStreaming;
    }
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
