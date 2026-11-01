import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteToolDispatcher, selectRemoteToolTargets } from '../public/remote-exec-tool-dispatch.js';
const session=(id,status='connected')=>({id,status,loaded:true});
test('tool target selection defaults to all ready owners, focused scope never falls back',()=>{
 const a=session('a'),b=session('b'),c=session('c','connecting'),d=session('d');d.loaded=false;
 const map=new Map([a,b,c,d].map(s=>[s.id,s]));
 assert.deepEqual(selectRemoteToolTargets(map,'b').map(s=>s.id),['a','b']);
 assert.deepEqual(selectRemoteToolTargets(map,'b',true),[b]);
 assert.deepEqual(selectRemoteToolTargets(map,null,true),[]);
 assert.deepEqual(selectRemoteToolTargets(map,'c',true),[]);
});
test('click snapshots exact targets, suppresses broadcast and waits for authenticated ACKs',async()=>{
 const a=session('a'),b=session('b'),sessions=new Map([[a.id,a],[b.id,b]]),messages=[],results=[];
 let active='b',visible=true;
 const dispatch=createRemoteToolDispatcher({getSessions:()=>sessions,getActiveId:()=>active,isActive:()=>visible,postMessage:(s,m)=>{messages.push([s,m]);return true;},onResult:r=>results.push(r)});
 const flight=dispatch.send('remote-exec-shortcut',{shortcut:{keys:['Ctrl','C']}},{focusOnly:true});
 assert.equal(messages.length,1);assert.equal(messages[0][0],b);assert.equal(messages[0][1].suppressBroadcast,true);
 active='a';sessions.delete('b');
 const ack={type:'remote-exec-shortcut-sent',requestId:messages[0][1].requestId};
 assert.equal(dispatch.acknowledge(a,ack),false);
 assert.equal(dispatch.acknowledge({...b},ack),false);
 assert.equal(dispatch.acknowledge(b,{...ack,type:'remote-exec-tool-command-sent'}),false);
 assert.equal(dispatch.acknowledge(b,ack),true);
 assert.deepEqual(await flight,{sent:1,failed:0,total:1});assert.equal(results.length,1);
 visible=false;await dispatch.send('remote-exec-shortcut',{});assert.equal(messages.length,1);
 dispatch.destroy();
});
test('all-target action is dispatched once per session; closed/offline targets are never queued',async()=>{
 const a=session('a'),b=session('b'),c=session('c','disconnected'),msgs=[];
 const d=createRemoteToolDispatcher({getSessions:()=>[a,b,c],getActiveId:()=>null,isActive:()=>true,postMessage:(s,m)=>{msgs.push([s,m]);return s!==b;}});
 const flight=d.send('remote-exec-tool-command',{command:'echo hi',appendEnter:true});
 assert.deepEqual(msgs.map(([s])=>s.id),['a','b']);
 d.acknowledge(a,{type:'remote-exec-tool-command-sent',requestId:msgs[0][1].requestId});
 assert.deepEqual(await flight,{sent:1,failed:1,total:2});d.destroy();
});
test('unacknowledged injection reports failure and late ACK cannot duplicate success',async()=>{
 const a=session('a'),messages=[];let timer;
 const d=createRemoteToolDispatcher({getSessions:()=>[a],getActiveId:()=>a.id,isActive:()=>true,postMessage:(s,m)=>{messages.push(m);return true;},setTimer:fn=>{timer=fn;return 1;},clearTimer:()=>{}});
 const flight=d.send('remote-exec-shortcut',{shortcut:{keys:['Enter']}});timer();
 assert.deepEqual(await flight,{sent:0,failed:1,total:1});
 assert.equal(d.acknowledge(a,{...messages[0],type:'remote-exec-shortcut-sent'}),false);d.destroy();
});
test('explicit target IDs intersect scope and readiness rather than promoting to all',async()=>{
 const a=session('a'),b=session('b');let count=0;
 const d=createRemoteToolDispatcher({getSessions:()=>[a,b],getActiveId:()=>b.id,isActive:()=>true,postMessage:()=>{count++;return false;}});
 assert.deepEqual(await d.send('remote-exec-tool-command',{}, {focusOnly:true,targetIds:['a']}),{sent:0,failed:0,total:0});
 assert.equal(count,0);d.destroy();
});
