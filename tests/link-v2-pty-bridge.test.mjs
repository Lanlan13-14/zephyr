import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {PrimaryPtyHandoff}=require('../link-pty-handoff');
const {createLinkPtyBridge}=require('../link-v2-pty-bridge');

test('PTY bridge requires loopback token, fixed lane and live enabled signing binding',async()=>{
    let revision=1,revoked=false,status='active';
    const sessions=new Map();
    const handoff=new PrimaryPtyHandoff({sessions,authorize(){},capture(){},writeInput(){},resize(){}});
    const bridge=createLinkPtyBridge({handoff,adminToken:'test-pty-bridge-token-123456',resolveAuth:id=>{
        if(revoked)throw Object.assign(new Error('revoked'),{code:'client_revoked',status:403});
        return {user:{userId:'alice',status},device:{binding_revision:revision,signing_public_jwk:'{"kty":"EC"}'}};
    }});
    const auth=bridge.authFor('device-1');
    const session={id:'s',protocol:'SSH',connectionId:'c',userId:'alice',sessionEpoch:1};
    sessions.set('s',session);handoff.enable(session,auth);
    const request=async({token='test-pty-bridge-token-123456',kind=11,body={op:'handoff.list'}}={})=>{
        let status=200,data;const response={status(value){status=value;return this;},json(value){data=value;return this;}};
        await bridge.handle({get:()=>token,body:{deviceId:'device-1',kind,body}},response);
        return {status,data};
    };
    assert.equal((await request({token:'bad'})).status,401);
    assert.equal((await request({kind:15})).status,400);
    assert.equal((await request({body:{op:'handoff.list',userId:'bob'}})).data.error.code,'invalid_request');
    assert.equal((await request()).data.body.sessions.length,1);
    revision=2;assert.throws(()=>auth.assertLive(),error=>error.code==='binding_expired');
    const fresh=bridge.authFor('device-1');assert.notEqual(auth.leaseId,fresh.leaseId);
    status='suspended';assert.equal((await request()).status,403);
    status='active';revoked=true;assert.equal((await request()).data.error.code,'client_revoked');
});

test('PTY bridge rechecks binding after asynchronous snapshot capture',async()=>{
    let release,revoked=false;
    const gate=new Promise(resolve=>release=resolve),session={id:'s',protocol:'SSH',connectionId:'c',userId:'u',sessionEpoch:1,outputSequence:0,pty:{cols:80,rows:24}};
    const handoff=new PrimaryPtyHandoff({sessions:new Map([['s',session]]),authorize(){},capture:async()=>{await gate;return {data:'screen',cols:80,rows:24,outputSequence:0};},writeInput(){},resize(){}});
    const bridge=createLinkPtyBridge({handoff,adminToken:'test-pty-bridge-token',resolveAuth:()=>{
        if(revoked)throw Object.assign(new Error('revoked'),{code:'client_revoked',status:403});
        return {user:{userId:'u',status:'active'},device:{binding_revision:1,signing_public_jwk:'key'}};
    }});
    const owner={userId:'u',leaseId:'original',assertLive(){}};handoff.enable(session,owner);
    let result;const response={status(){return this;},json(value){result=value;}};
    const running=bridge.handle({get:()=> 'test-pty-bridge-token',body:{deviceId:'device',kind:11,body:{op:'handoff.prepare',sessionId:'s'}}},response);
    revoked=true;release();await running;
    assert.equal(result.error.code,'client_revoked');assert.equal(handoff.pending.size,0);assert.equal(session.sessionEpoch,1);
});
