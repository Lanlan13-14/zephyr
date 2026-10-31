import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {PrimaryPtyHandoff}=require('../link-pty-handoff');
const {dispatchPty}=require('../link-v2-pty-bridge');
const source=fs.readFileSync(new URL('../public/terminal-handoff.js',import.meta.url),'utf8');
const {createTerminalHandoff}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

test('browser does not commit until renderer finishes; old input is fenced through actual coordinator',async()=>{
    let rendered;const visible=new Promise(resolve=>rendered=resolve), events=[],timers=[];
    const session={id:'s',userId:'u',protocol:'SSH',connectionId:'c',pty:{cols:80,rows:24},sessionEpoch:1,outputSequence:0,attachedWs:new Set()};
    const auth=leaseId=>({leaseId,userId:'u',assertLive(){}}),original=auth('original'),target=auth('receiver');
    const handoff=new PrimaryPtyHandoff({sessions:new Map([['s',session]]),authorize(){},capture:async()=>({data:'SCREEN',cols:80,rows:24,outputSequence:0}),writeInput(){events.push('input');},resize(){}});
    handoff.enable(session,original);
    const browser=createTerminalHandoff({rpc:body=>dispatchPty(handoff,target,body),applySnapshot:async()=>{events.push('parse');await visible;events.push('render');},applyFrames:async()=>{},onTaken:()=>events.push('commit'),onError:error=>events.push(error.message),schedule:fn=>{timers.push(fn);return timers.length;},cancel(){}});
    const taking=browser.take('s');await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(events,['parse']);assert.equal(session.sessionEpoch,1);assert.equal(browser.active,false);
    rendered();await taking;assert.equal(session.sessionEpoch,2);assert.deepEqual(events,['parse','render','commit']);
    assert.throws(()=>handoff.assertSocket(original,session,undefined),error=>error.code==='stale_owner');
    assert.equal(browser.input(new TextEncoder().encode('a')),true);
    await new Promise(resolve=>setImmediate(resolve));assert.equal(events.at(-1),'input');
    browser.stop();assert.equal(browser.active,false);assert.equal(timers.length,1);
});

test('renderer failure and uncertain commit never get automatic takeover retry',async()=>{
    const calls=[],errors=[];
    const client=createTerminalHandoff({rpc:async body=>{calls.push(body.op);return {ok:true,prepareId:'p',snapshot:{snapshotHash:'h',outputSequence:0}};},applySnapshot:async()=>{throw new Error('draw failed');},applyFrames:async()=>{},onTaken(){throw new Error('must not happen');},onError:e=>errors.push(e.message)});
    await assert.rejects(client.take('s'),/draw failed/);
    assert.deepEqual(calls,['handoff.prepare','handoff.abort']);assert.deepEqual(errors,['draw failed']);
});

test('vendored real xterm consumption callback waits for ANSI parsing and preserves split UTF-8',async()=>{
    const {Terminal}=require('@xterm/headless');
    const mod=await import(pathToFileURL(new URL('../public/vendor/wterm-fork/core/xterm-bridge.js',import.meta.url).pathname).href);
    mod.setDefaultXtermTerminalCtor(Terminal);
    const bridge=await mod.XtermBridge.load({cols:80,rows:24});bridge.init(80,24);
    try {
        await bridge.writeConsumed(new Uint8Array([0xe4]));
        await bridge.writeConsumed(new Uint8Array([0xb8,0xad]));
        assert.equal(String.fromCodePoint(bridge.getCell(0,0).char),'中');
        await bridge.writeConsumed('\x1b[2;5H\x1b[31mR');
        assert.equal(String.fromCodePoint(bridge.getCell(1,4).char),'R');assert.equal(bridge.getCell(1,4).fg,1);
    } finally {bridge.dispose();}
});
