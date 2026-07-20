import test from 'node:test';import assert from 'node:assert/strict';import {WasmBridge} from '../public/vendor/wterm-fork/core/index.js';
test('Kitty keyboard flags set add remove push pop query',async()=>{const b=await WasmBridge.load();b.init(80,24);
b.writeString('\x1b[?u');assert.equal(b.getResponse(),'\x1b[?0u');b.writeString('\x1b[=3;1u');assert.equal(b.kittyKeyboardFlags(),3);b.writeString('\x1b[=4;2u');assert.equal(b.kittyKeyboardFlags(),7);b.writeString('\x1b[=2;3u');assert.equal(b.kittyKeyboardFlags(),5);
b.writeString('\x1b[>8u');assert.equal(b.kittyKeyboardFlags(),8);b.writeString('\x1b[<u');assert.equal(b.kittyKeyboardFlags(),5);b.writeString('\x1b[?u');assert.equal(b.getResponse(),'\x1b[?5u');});
