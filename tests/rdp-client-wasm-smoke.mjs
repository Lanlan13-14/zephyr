import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const mod = await import(path.join(root, 'public/vendor/rdp-client/rdp_client_wasm.js'));
const wasmBytes = fs.readFileSync(path.join(root, 'public/vendor/rdp-client/rdp_client_wasm_bg.wasm'));
await mod.default({ module_or_path: wasmBytes });

assert.equal(typeof mod.rdp_connect, 'function');
assert.equal(typeof mod.rdp_disconnect, 'function');
assert.equal(typeof mod.rdp_mouse_move, 'function');
assert.equal(typeof mod.rdp_mouse_h_scroll, 'function');
assert.equal(typeof mod.rdp_resize_display, 'function');
console.log('rdp-client-wasm smoke ok');
