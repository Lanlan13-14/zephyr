import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const root=new URL('../',import.meta.url);
const read=file=>readFileSync(new URL(file,root),'utf8');
const {pack,unpack,KIND}=require('../link-v2-codec');
const cbor=require('../link-v2-cbor');

test('KindAI production is wired to the canonical executor and not the builtin status ack',()=>{
  const server=read('server.js'),proxy=read('link-v2-go-proxy.js'),go=read('zephyr-link/cmd/zephyr-link-server/main.go');
  assert.match(server,/linkInternalApp\.post\('\/internal\/link\/ai', databaseMaintenanceGate/);
  assert.match(server,/await handleCanonicalAiRun\(\{user,body,linkAiStrict:true,assertLive\},reply\)/);
  assert.match(server,/strictLinkApproval: req\.linkAiStrict === true/);
  assert.match(server,/autoConfirm: !req\.linkAiStrict &&/);
  assert.match(server,/aiBridgeUrlReady: linkInternalReady/);
  assert.match(proxy,/ZEPHYR_LINK_AI_BRIDGE: this\.aiBridgeUrl/);
  assert.match(go,/node\.RegisterAIBridge/);
});

test('strict approval survives persisted pause and cannot use old generic permission endpoint',()=>{
  const go=read('zephyr-ai/internal/server/server.go');
  assert.match(go,/st\.StrictLinkApproval && body\.InputHash == ""/);
  assert.match(go,/body\.CallID != waiting\.ID/);
  assert.match(go,/body\.Tool != waiting\.Name/);
  assert.match(go,/s\.store\.ConsumeRunResume\(runID, st\)/);
  assert.match(read('zephyr-ai/internal/agent/resume.go'),/StrictLinkApproval/);
  assert.match(read('zephyr-ai/internal/agent/loop.go'),/StrictLinkApproval:\s*cfg\.StrictLinkApproval/);
});

test('KindAI CBOR request roundtrips without provider key or caller account',()=>{
  const input={op:'ai.command.dispatch',requestId:'req1',conversationId:'conv1',prompt:'pwd',executionTarget:'remote_host'};
  const packed=pack({kind:KIND.AI,body:input}),frame=unpack(packed);
  assert.equal(frame.kind,KIND.AI);assert.deepEqual(frame.body,input);
  assert.equal(cbor.encode(input).toString('hex'),cbor.encode({...input}).toString('hex'));
});

test('independent op schema and frozen canonical CBOR vectors cover every implemented operation',()=>{
  const schema=JSON.parse(read('docs/zephyr-link/contracts/ai-rpc-host-v1.schema.json'));
  const {vectors}=JSON.parse(read('docs/zephyr-link/contracts/ai-rpc-host-v1.golden.json'));
  const ops=new Set();
  for(const vector of vectors){
    ops.add(vector.body.op);
    assert.equal(cbor.encode(vector.body).toString('hex'),vector.bodyHex,vector.name);
    assert.deepEqual(unpack(pack({kind:vector.kind,body:vector.body})).body,vector.body);
    assert.deepEqual(unpack(Buffer.from(vector.hex,'hex')).body,vector.body);
  }
  assert.equal(ops.size,6);assert.equal(schema.oneOf.length,5);
});
