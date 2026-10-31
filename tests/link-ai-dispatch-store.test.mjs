import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createDatabase } = require('../sqlite-driver');
const { LinkAIDispatchStore, digest } = require('../link-ai-dispatch-store');
const live = () => {};
function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'link-ai-receipts-'));
  const filename = path.join(dir,'state.db');
  const db = createDatabase(filename);
  t.after(() => { db.close(); fs.rmSync(dir,{recursive:true,force:true}); });
  return {db,filename};
}
function request(store,overrides={}) {
  return store.dispatch({scope:'["u","dev","binding1"]',requestId:'req1',generation:'g1',input:{prompt:'private-prompt',apiKey:'not-for-disk'},
    assertLive:live,execute:async()=>({runId:'run1',sessionId:'ses1',ticket:'never-on-disk'}),...overrides});
}

test('SQLite receipt deduplicates concurrent and restarted store requests without storing content', async t => {
  const {db} = database(t), store = new LinkAIDispatchStore(db);
  let calls=0, release;
  const gate = new Promise(resolve=>{release=resolve;});
  const execute=async()=>{calls++;await gate;return {runId:'run1',sessionId:'ses1',ticket:'secret-ticket'};};
  const first=request(store,{execute}), second=request(store,{execute});
  release();
  assert.deepEqual(await first,await second);
  assert.equal(calls,1);
  const reopened=new LinkAIDispatchStore(db);
  assert.equal((await request(reopened,{execute:()=>assert.fail('duplicate side effect')})).runId,'run1');
  const stored=db.prepare('SELECT * FROM link_ai_dispatch').all();
  assert.doesNotMatch(JSON.stringify(stored),/private-prompt|not-for-disk|secret-ticket/);
  assert.equal(stored[0].state,'completed');
});

test('changed content conflicts and new runtime generation cannot reopen a prior request', async t=>{
  const {db}=database(t),store=new LinkAIDispatchStore(db);
  await request(store);
  await assert.rejects(request(store,{input:{prompt:'changed'}}),{code:'idempotency_conflict'});
  await assert.rejects(request(store,{generation:'g2',execute:()=>assert.fail('generation replay')}),{code:'ai_run_generation_expired'});
  assert.throws(()=>store.query('["u","dev","binding1"]','req1','g2'),{code:'ai_run_generation_expired'});
  assert.equal(digest({b:2,a:1}),digest({a:1,b:2}));
});

test('ambiguous network failure is persisted uncertain and never automatically redispatched',async t=>{
  const {db}=database(t),store=new LinkAIDispatchStore(db);
  let calls=0;
  await assert.rejects(request(store,{execute:async()=>{calls++;throw new Error('connection reset after execution');}}));
  await assert.rejects(request(new LinkAIDispatchStore(db),{execute:()=>assert.fail('uncertain replay')}),{code:'ai_dispatch_uncertain'});
  const receipt=store.query('["u","dev","binding1"]','req1','g1');
  assert.equal(receipt.state,'uncertain');assert.equal(receipt.retryDispatch,false);assert.equal(calls,1);
});

test('revoked retry never receives an earlier cached receipt',async t=>{
  const {db}=database(t),store=new LinkAIDispatchStore(db);await request(store);
  await assert.rejects(request(store,{assertLive:()=>{throw Object.assign(new Error(),{code:'device_revoked'});}}),{code:'device_revoked'});
});
