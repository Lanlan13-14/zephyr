import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {parseLoopbackListen}=require('../ai-host-listener');
test('accepts loopback listen addresses',()=>{
 assert.deepEqual(parseLoopbackListen('127.0.0.1:3080'),{host:'127.0.0.1',port:3080});
 assert.deepEqual(parseLoopbackListen('localhost:4000'),{host:'127.0.0.1',port:4000});
});
test('rejects wildcard and external hosts',()=>{
 assert.throws(()=>parseLoopbackListen('0.0.0.0:3080'),/loopback/);
 assert.throws(()=>parseLoopbackListen('10.0.0.2:3080'),/loopback/);
});
