import test from 'node:test';import assert from 'node:assert/strict';import {WasmBridge} from '../public/vendor/wterm-fork/core/index.js';
test('OSC color set/reset events are ordered',async()=>{const b=await WasmBridge.load();b.init(80,24);
b.writeString('\x1b]4;1;#112233;2;rgb:f/0/8\x07\x1b]10;#abcdef\x07\x1b]11;rgb:1/2/3\x07\x1b]104;1;2\x07\x1b]110\x07\x1b]111\x07');const c=b.takeColorChanges();assert.deepEqual(c.map(x=>[x.kind,x.index,x.value]),[[4,1,'#112233'],[4,2,'rgb:f/0/8'],[10,0,'#abcdef'],[11,0,'rgb:1/2/3'],[104,1,''],[104,2,''],[110,0,''],[111,0,'']]);});
