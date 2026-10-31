import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PrimaryPtyHandoff } = require('../link-pty-handoff');
const { dispatchPty } = require('../link-v2-pty-bridge');
const { createTerminalSnapshot } = require('../terminal-snapshot');
const { Terminal } = require('@xterm/headless');
function fixture() {
    let now = 1000, denied = false, captured;
    const writes = [], sizes = [], notices = [];
    const session = { id: 'pty-1', protocol: 'SSH', connectionId: 'conn-1', userId: 'alice',
        sessionEpoch: 1, outputSequence: 0, pty: {cols:80,rows:24}, attachedWs:new Set(), connectionConfig:{name:'Work'} };
    const auth = (leaseId, userId = 'alice') => ({leaseId,userId, assertLive() { if (denied) throw Object.assign(new Error('revoked'),{code:'revoked'}); }});
    const handoff = new PrimaryPtyHandoff({sessions:new Map([[session.id,session]]),
        authorize() {}, capture:async () => captured || {data:'screen',outputSequence:session.outputSequence,cols:80,rows:24},
        writeInput:(_s,bytes) => writes.push(Buffer.from(bytes)), resize:(_s,c,r) => sizes.push([c,r]),clock:()=>now});
    const source=auth('socket:1'); source.transferred=event=>notices.push(event);
    handoff.enable(session,source);
    const target=auth('device:2');
    return {handoff,session,source,target,auth,writes,sizes,notices, revoke(){denied=true;},advance(){now+=31000;},capture(value){captured=value;}};
}
const commitBody = p => ({prepareId:p.prepareId,snapshotHash:p.snapshot.snapshotHash,appliedSequence:p.snapshot.outputSequence});
async function take(f, auth=f.target) { const p=await f.handoff.prepare(auth,'pty-1'); return f.handoff.commit(auth,commitBody(p)); }

test('renderer acknowledgement precedes single-winner epoch CAS and commit replay',async()=>{
    const f=fixture(), p=await f.handoff.prepare(f.target,'pty-1'), other=f.auth('device:3');
    const q=await f.handoff.prepare(other,'pty-1');
    assert.equal(f.session.handoff.owner,'socket:1');
    assert.throws(()=>f.handoff.commit(f.target,{...commitBody(p),snapshotHash:'forged'}),e=>e.code==='snapshot_not_applied');
    const result=f.handoff.commit(f.target,commitBody(p));
    assert.equal(result.sessionEpoch,2);
    assert.equal(f.session.handoff.owner,'device:2');
    assert.deepEqual(f.handoff.commit(f.target,commitBody(p)),result);
    assert.equal(f.notices.length,1);
    assert.throws(()=>f.handoff.commit(other,commitBody(q)),e=>e.code==='handoff_conflict');
    assert.throws(()=>f.handoff.assertSocket(f.source,f.session,undefined),e=>e.code==='stale_owner');
    assert.throws(()=>f.handoff.assertSocket(f.source,f.session,2),e=>e.code==='stale_owner');
    assert.throws(()=>f.handoff.enable(f.session,f.source),e=>e.code==='stale_owner');
});

test('cross-user, expired prepare, revoked binding and changed geometry fail closed',async()=>{
    const f=fixture();
    await assert.rejects(f.handoff.prepare(f.auth('evil','bob'),'pty-1'),e=>e.code==='session_not_found');
    assert.deepEqual(f.handoff.list(f.auth('evil','bob')).sessions,[]);
    const p=await f.handoff.prepare(f.target,'pty-1'); f.session.pty.cols=81;
    assert.throws(()=>f.handoff.commit(f.target,commitBody(p)),e=>e.code==='snapshot_required');
    f.session.pty.cols=80; f.advance();
    assert.throws(()=>f.handoff.commit(f.target,commitBody(p)),e=>e.code==='handoff_expired');
    const q=await f.handoff.prepare(f.target,'pty-1'); f.revoke();
    assert.throws(()=>f.handoff.commit(f.target,commitBody(q)),e=>e.code==='revoked');
    assert.equal(f.session.sessionEpoch,1);
});

test('input consumes sequence before real write; replay cannot execute twice or alter bytes',async()=>{
    const f=fixture(), result=await take(f);
    const body={sessionId:'pty-1',sessionEpoch:result.sessionEpoch,inputSeq:1,data:Buffer.from('pwd\n').toString('base64')};
    assert.equal(f.handoff.input(f.target,body).ok,true);
    assert.equal(f.handoff.input(f.target,body).ok,true); assert.equal(f.writes.length,1);
    assert.throws(()=>f.handoff.input(f.target,{...body,data:Buffer.from('rm').toString('base64')}),e=>e.code==='input_conflict');
    assert.throws(()=>f.handoff.input(f.target,{...body,inputSeq:3}),e=>e.code==='input_sequence_gap');
    f.handoff.writeInput=()=>{throw new Error('uncertain after write');};
    assert.equal(f.handoff.input(f.target,{...body,inputSeq:2}).error.code,'input_uncertain');
    f.handoff.writeInput=()=>{throw new Error('must never be called again');};
    assert.equal(f.handoff.input(f.target,{...body,inputSeq:2}).error.code,'input_uncertain');
    assert.equal(f.writes[0].toString(),'pwd\n');
});

test('output preserves split UTF-8/control bytes and overflow demands fresh snapshot',async()=>{
    const f=fixture(), result=await take(f);
    for (const bytes of [Buffer.from([0xe4]),Buffer.from([0xb8,0xad,0x1b,0x00])]) {
        f.handoff.append(f.session,bytes,++f.session.outputSequence);
    }
    const page=f.handoff.read(f.target,{sessionId:'pty-1',sessionEpoch:result.sessionEpoch,afterSeq:0});
    assert.deepEqual(Buffer.concat(page.frames.map(v=>Buffer.from(v.data,'base64'))),Buffer.from([0xe4,0xb8,0xad,0x1b,0x00]));
    for(let i=0;i<10;i++)f.handoff.append(f.session,Buffer.alloc(65536),++f.session.outputSequence);
    assert.throws(()=>f.handoff.read(f.target,{sessionId:'pty-1',sessionEpoch:2,afterSeq:0}),e=>e.code==='snapshot_required');
    assert.ok(f.session.handoff.outputBytes<=512*1024);
});

test('strict operation shapes reject claimed user/device identity and invalid epochs',async()=>{
    const f=fixture();
    await assert.rejects(dispatchPty(f.handoff,f.target,{op:'handoff.list',deviceId:'forged'}),e=>e.code==='invalid_request');
    await take(f);
    await assert.rejects(dispatchPty(f.handoff,f.target,{op:'pty.read',sessionId:'pty-1',sessionEpoch:1,afterSeq:0}),e=>e.code==='stale_owner');
    assert.throws(()=>f.handoff.setSize(f.target,{sessionId:'pty-1',sessionEpoch:2,cols:1,rows:24}),e=>e.code==='invalid_size');
    f.handoff.setSize(f.target,{sessionId:'pty-1',sessionEpoch:2,cols:120,rows:40});
    assert.deepEqual(f.sizes,[[120,40]]);
});

test('real headless ANSI snapshot plus exact delta restores alternate screen, colors and cursor',async()=>{
    const f=fixture(), framebuffer=createTerminalSnapshot({cols:80,rows:24});
    const bytes=Buffer.from('\x1b[?1049h\x1b[2J\x1b[H\x1b[31mPRIMARY\x1b[0m\x1b[3;7Hcursor');
    await framebuffer.write(bytes,1); f.session.outputSequence=1;
    f.handoff.capture=()=>framebuffer.serialize();
    const prepared=await f.handoff.prepare(f.target,'pty-1');
    const target=new Terminal({cols:80,rows:24,allowProposedApi:true});
    const write=data=>new Promise(resolve=>target.write(data,resolve));
    try {
        await write(prepared.snapshot.data);
        const newer=Buffer.from('-new');
        await framebuffer.write(newer,2); f.session.outputSequence=2; f.handoff.append(f.session,newer,2);
        const committed=f.handoff.commit(f.target,commitBody(prepared));
        for(const frame of committed.frames)await write(Buffer.from(frame.data,'base64'));
        assert.equal(target.buffer.active.type,'alternate');
        assert.equal(target.buffer.active.getLine(0).translateToString(true),'PRIMARY');
        assert.equal(target.buffer.active.getLine(0).getCell(0).getFgColor(),1);
        assert.equal(target.buffer.active.getLine(2).translateToString(true),'      cursor-new');
        assert.equal(target.buffer.active.cursorX,16);
    } finally { target.dispose(); framebuffer.dispose(); }
});
