import test from 'node:test';import assert from 'node:assert/strict';import {WasmBridge} from '../public/vendor/wterm-fork/core/index.js';
test('OSC 4/10/11 enqueue color queries',async()=>{const b=await WasmBridge.load();b.init(80,24);b.writeString('\x1b]4;1;?;196;?\x07\x1b]10;?\x07\x1b]11;?\x07');
assert.deepEqual(b.takeColorQueries(),[{kind:4,index:1},{kind:4,index:196},{kind:10,index:0},{kind:11,index:0}]);assert.deepEqual(b.takeColorQueries(),[]);});
