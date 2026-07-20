import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {WasmBridge} from '../public/vendor/wterm-fork/core/index.js';
async function col(s){const b=await WasmBridge.load();b.init(20,4);b.writeString(s);return b.getCursor().col;}
test('Unicode 15.1 W/F table drives cell width',async()=>{assert.equal(await col('A'),1);assert.equal(await col('你'),2);assert.equal(await col('Ａ'),2);assert.equal(await col('·'),1);assert.equal(await col('⌚'),2);});
test('generated table records official checksum',()=>{const s=fs.readFileSync(new URL('../wterm/src/unicode_width.zig',import.meta.url),'utf8');assert.match(s,/Unicode 15\.1/);assert.match(s,/b08191401dc125f4/);assert.match(s,/wide_ranges/);});
