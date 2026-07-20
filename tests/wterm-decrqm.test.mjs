import test from 'node:test';import assert from 'node:assert/strict';import {WasmBridge} from '../public/vendor/wterm-fork/core/index.js';
test('DECRQM reports set reset and unsupported modes',async()=>{const b=await WasmBridge.load();b.init(80,24);
for(const [q,r] of [['\x1b[?7$p','\x1b[?7;1$y'],['\x1b[?1004$p','\x1b[?1004;2$y'],['\x1b[?9999$p','\x1b[?9999;0$y']]){b.writeString(q);assert.equal(b.getResponse(),r);}b.writeString('\x1b[?1004h\x1b[?1004$p');assert.equal(b.getResponse(),'\x1b[?1004;1$y');});
