import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const mod = await import(path.join(root, 'public/vendor/rdp-render/rdp_render_wasm.js'));
const wasmBytes = fs.readFileSync(path.join(root, 'public/vendor/rdp-render/rdp_render_wasm_bg.wasm'));
await mod.default({ module_or_path: wasmBytes });

assert.deepEqual(Array.from(mod.bgra_to_rgba(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))), [3, 2, 1, 4, 7, 6, 5, 8]);
assert.deepEqual(Array.from(mod.bgr24_to_bgra(new Uint8Array([1, 2, 3]))), [1, 2, 3, 255]);
assert.deepEqual(Array.from(mod.rgb565_to_bgra(new Uint8Array([0x00, 0xf8]))), [0, 0, 255, 255]);

const c = new mod.FrameCompositor(4, 3);
assert.equal(c.blit_tile(1, 1, 2, 1, new Uint8Array([10, 11, 12, 13, 20, 21, 22, 23])), true);
assert.deepEqual(Array.from(c.take_dirty()), [1, 1, 2, 1]);
assert.deepEqual(Array.from(c.take_dirty()), []);
assert.deepEqual(Array.from(c.get_dirty_pixels(1, 1, 2, 1)), [10, 11, 12, 13, 20, 21, 22, 23]);
assert.equal(c.blit_tile(3, 2, 3, 2, new Uint8Array(3 * 2 * 4).fill(9)), true);
assert.deepEqual(Array.from(c.take_dirty()), [3, 2, 1, 1]);

console.log('rdp-render-wasm smoke ok');
