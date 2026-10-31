import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createDatabase}=require('../sqlite-driver');
const {createLinkAiBridge,approvalProofPayload}=require('../link-v2-ai-bridge');
const {KIND}=require('../link-v2-codec');
function fixture(t,options={}) {
  const db=createDatabase(':memory:');t.after(()=>db.close());
  const {privateKey,publicKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  let now=1000,revoked=false,owner='alice',revision=1,calls=0,decisions=0;
  const device={device_id:'d1',binding_revision:revision,signing_public_jwk:JSON.stringify(publicKey.export({format:'jwk'}))};
  const pending={approvalId:'call1',callId:'call1',tool:'terminal.exec',inputHash:'a'.repeat(64),arguments:{command:'rm target'},risk:'high'};
  const runtime={databaseGeneration:'generation1',enabled:true,
    async getRunSnapshot(user,runId,afterSeq) {return {ok:true,run:{id:runId,userId:user.userId,sessionId:'ses1',status:'waiting_permission'},events:[{seq:1,eventType:'tool.pending'}],nextSeq:1,hasMore:false,approval:{...pending}};},
    async abortRun(){return {ok:true};},
    async decidePermission(user,runId,body){decisions++;assert.equal(body.tool,pending.tool);assert.equal(body.inputHash,pending.inputHash);assert.equal(body.scope,'once');return {ok:true};},
  };
  const bridge=createLinkAiBridge({runtime,storage:{rawDb:()=>db},adminToken:'test-internal-token',clock:()=>now,
    resolveAuth(id){if(revoked||id!=='d1')throw Object.assign(new Error(),{code:'device_revoked',status:403});return {user:{userId:owner},device};},
    startCanonical:async(user,payload,assertLive)=>{calls++;assertLive();assert.equal(payload.autoConfirm,false);assert.deepEqual(payload.mcpServers,[]);return {runId:'run1',sessionId:'ses1',conversationId:payload.conversationId};},...options});
  bridge.setProviderResolver(()=>({apiKey:'server-only-key'}));
  const dispatch={op:'ai.command.dispatch',requestId:'req1',conversationId:'conv1',prompt:'do task',executionTarget:'remote_host'};
  return {db,bridge,runtime,pending,dispatch,privateKey,calls:()=>calls,decisions:()=>decisions,
    revoke:()=>{revoked=true;},owner:v=>{owner=v;},advance:v=>{now=v;},rebind:()=>device.binding_revision++};
}
test('KindAI dispatch executes canonical service once and returns no tickets or keys',async t=>{
  const f=fixture(t);const [a,b]=await Promise.all([f.bridge.dispatch('d1',f.dispatch),f.bridge.dispatch('d1',f.dispatch)]);
  assert.deepEqual(a,b);assert.equal(f.calls(),1);assert.equal(a.runId,'run1');
  assert.doesNotMatch(JSON.stringify(a),/ticket|apiKey|server-only/);
  assert.equal((await f.bridge.dispatch('d1',{op:'ai.stream.event',requestId:'req1',afterSeq:-1})).events[0].seq,1);
  f.revoke();await assert.rejects(f.bridge.dispatch('d1',f.dispatch),{code:'device_revoked'});
});
test('new runtime generation refuses same persisted request instead of duplicate dispatch',async t=>{
  const f=fixture(t);await f.bridge.dispatch('d1',f.dispatch);f.runtime.databaseGeneration='g2';
  await assert.rejects(f.bridge.dispatch('d1',f.dispatch),{code:'ai_run_generation_expired'});assert.equal(f.calls(),1);
});
test('foreign bindings cannot query the original run and invalid targets do not execute',async t=>{
  const f=fixture(t);await f.bridge.dispatch('d1',f.dispatch);f.owner('bob');
  await assert.rejects(f.bridge.dispatch('d1',{op:'ai.command.result',requestId:'req1'}),{code:'ai_request_not_found'});
  f.owner('alice');
  await assert.rejects(f.bridge.dispatch('d1',{...f.dispatch,requestId:'bad',executionTarget:'local_cell'}),{code:'invalid_request'});
  await assert.rejects(f.bridge.dispatch('d1',{...f.dispatch,requestId:'bad',context:{transport:'RDP',connectionId:'c'}}),{code:'unsupported_execution_target'});
  await assert.rejects(f.bridge.dispatch('d1',{...f.dispatch,permissionMode:'yolo'}),{code:'invalid_request'});assert.equal(f.calls(),1);
});
function decision(f,preview,changes={}) {
  const body={op:'ai.approval.decision',requestId:'req1',approvalId:preview.approvalId,inputHash:preview.inputHash,
    approve:true,expiresAt:preview.expiresAt,challenge:preview.challenge,...changes};
  body.proof=crypto.sign('sha256',approvalProofPayload({...body,deviceId:'d1',runId:'run1'}),
    {key:f.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
  return body;
}
test('approval requires current device signature and exact tool input and is single use',async t=>{
  const f=fixture(t);await f.bridge.dispatch('d1',f.dispatch);
  const preview=(await f.bridge.dispatch('d1',{op:'ai.command.result',requestId:'req1'})).approval;
  assert.equal(preview.arguments.command,'rm target');
  const body=decision(f,preview);
  await assert.rejects(f.bridge.dispatch('d1',{...body,proof:Buffer.alloc(64).toString('base64')}),{code:'approval_required'});
  await f.bridge.dispatch('d1',body);assert.equal(f.decisions(),1);
  await assert.rejects(f.bridge.dispatch('d1',body),{code:'approval_required'});
});
test('command change, expiration and request field forgery never resume execution',async t=>{
  const f=fixture(t);await f.bridge.dispatch('d1',f.dispatch);
  const preview=(await f.bridge.dispatch('d1',{op:'ai.command.result',requestId:'req1'})).approval;
  const body=decision(f,preview);f.pending.inputHash='b'.repeat(64);
  await assert.rejects(f.bridge.dispatch('d1',body),{code:'approval_required'});
  f.advance(preview.expiresAt+1);
  await assert.rejects(f.bridge.dispatch('d1',body),{code:'approval_required'});
  await assert.rejects(f.bridge.dispatch('d1',{...body,runId:'forged-run'}),{code:'invalid_request'});
  assert.equal(f.decisions(),0);
});
test('internal handler requires shared token and KindAI lane, not caller identity',async t=>{
  const f=fixture(t);
  let status=200,data;
  const res={status(code){status=code;return this;},json(value){data=value;return this;}};
  await f.bridge.handle({get:()=>'',body:{deviceId:'d1',kind:KIND.AI,body:f.dispatch}},res);
  assert.equal(status,401);assert.equal(f.calls(),0);
  await f.bridge.handle({get:()=>'test-internal-token',body:{deviceId:'d1',kind:KIND.SYNC_OP,body:f.dispatch}},res);
  assert.equal(status,400);assert.equal(f.calls(),0);
});
