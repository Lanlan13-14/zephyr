import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const source=app.slice(app.indexOf('async function playTerminalCardFlipOpen('),app.indexOf('\nasync function finishTerminalCardFlipOpenHandoff'));
function element(){const classes=new Set();return {style:{},classList:{add(...v){v.forEach(x=>classes.add(x))},remove(...v){v.forEach(x=>classes.delete(x))},toggle(k,v){v?classes.add(k):classes.delete(k)},contains:k=>classes.has(k)},setAttribute(){},dataset:{}};}
function setup(){
 const stage=element(),surface=element(),rotor=element(),scrim=element(),front=element(),back=element(),body=element(),card=element(),live=element();
 const state={cycle:0},written=[],calls=[],frames=[];let resolveEngine;const ready=new Promise(r=>resolveEngine=r);let angle=0,started=false,clock=0;
 const M={STANDARDS:{iosCardFlipOpen:15},stop(){},set(el,props){written.push([el,props]);Object.assign(el.style,props);if(el===rotor)angle=props.rotateY},to(el,props,options){calls.push([el,props,options]);started=true;return Promise.resolve()},value(){return angle}};
 const ctx=vm.createContext({document:{body,querySelector:s=>s.includes('rotor')?rotor:s.includes('front')?front:back},window:{setTimeout:r=>{r();return 1}},$:s=>({'#terminalCardFlipStage':stage,'#terminalCardFlipSurface':surface,'#terminalCardFlipScrim':scrim}[s]),terminalCardFlipMotion:state,
 paintTerminalCardFlipFront(){},paintTerminalCardFlipBack:()=>true,terminalCardFlipTargetRect:()=>({left:0,top:0,width:1000,height:700,topBound:0,fillStage:true}),placeTerminalCardFlipStage(){},placeTerminalCardFlipSurface(){},terminalCardSourceRadius:()=>12,
 sshKeyMotion:{_ensure:()=>ready},requestAnimationFrame:r=>frames.push(r),getTerminalWorkspaceStageMetrics:()=>({vw:0,vh:0,wsLeft:0,wsWidth:0}),syncTerminalSmartbarTop(){},syncTerminalShelfLineState(){},applySwitchViewCore(){},currentAppView:'dashboard',cardFlipStandards:()=>M.STANDARDS,performance:{now:()=>clock},Promise,console});
 vm.runInContext(source,ctx);
 const run=(options={})=>ctx.playTerminalCardFlipOpen(card,{originRect:{left:10,top:20,width:200,height:120},liveWindow:live,...options});
 const nextFrame=async()=>{const rs=frames.splice(0);rs.forEach(r=>r());await new Promise(r=>setImmediate(r));};
 return {stage,surface,rotor,scrim,card,M,state,written,calls,frames,run,resolveEngine,nextFrame,setAngle:v=>angle=v,setClock:v=>clock=v,isStarted:()=>started};
}
test('cold init never exposes the full stage before seeding source geometry',async()=>{
 const h=setup();const flight=h.run();
 assert.equal(h.stage.classList.contains('is-active'),false);
 assert.equal(h.surface.style.visibility,'hidden');assert.equal(h.scrim.style.visibility,'hidden');assert.notEqual(h.card.style.opacity,'0');
 assert.equal(h.written.length,0);
 h.resolveEngine(h.M);await new Promise(r=>setImmediate(r));
 assert.equal(h.stage.classList.contains('is-active'),true);assert.equal(h.surface.style.visibility,'visible');
 assert.ok(h.written.some(([el,p])=>el===h.surface&&p.scaleX===.2));assert.ok(h.written.some(([el,p])=>el===h.rotor&&p.rotateY===0));
 await h.nextFrame();assert.equal(h.isStarted(),true);
 // 700ms deadline fired, but the spring has not advanced: never force a snap.
 assert.equal(h.rotor.style.rotateY,0);assert.ok(h.frames.length>0);
 h.setAngle(-179.5);await h.nextFrame();assert.equal(await flight,true);assert.equal(h.rotor.style.rotateY,-180);
});
test('warm default direction still uses the existing standard',async()=>{
 const h=setup();h.resolveEngine(h.M);const flight=h.run();await new Promise(r=>setImmediate(r));await h.nextFrame();
 assert.ok(h.calls.some(([el,p])=>el===h.rotor&&p.rotateY===-180));h.setAngle(-180);await h.nextFrame();assert.equal(await flight,true);
});
test('reverse batch retains positive rotation and timeScale 1.5 after cold boot',async()=>{
 const h=setup();const flight=h.run({direction:'reverse',timeScale:1.5});
 assert.equal(h.stage.classList.contains('is-active'),false);
 h.resolveEngine(h.M);await new Promise(r=>setImmediate(r));await h.nextFrame();
 const rotation=h.calls.find(([el])=>el===h.rotor);
 assert.equal(rotation[1].rotateY,180);assert.equal(rotation[2].timeScale,1.5);assert.equal(rotation[2].standard,h.M.STANDARDS.iosCardFlipOpen);
 h.setAngle(179.5);await h.nextFrame();assert.equal(await flight,true);assert.equal(h.rotor.style.rotateY,180);
});
test('engine failure keeps unseeded overlay hidden and source untouched',async()=>{
 const h=setup();const flight=h.run();h.resolveEngine(null);
 assert.equal(await flight,false);assert.equal(h.stage.classList.contains('is-active'),false);
 assert.equal(h.surface.style.visibility,'hidden');assert.notEqual(h.card.style.opacity,'0');assert.equal(h.calls.length,0);
});
test('cancelled initialization cannot later reveal or animate the old cycle',async()=>{
 const h=setup();const flight=h.run();h.state.cycle++;
 h.resolveEngine(h.M);assert.equal(await flight,false);
 assert.equal(h.stage.classList.contains('is-active'),false);assert.equal(h.written.length,0);assert.equal(h.frames.length,0);
});
test('cancelled slow progress exits without forcing a stale final frame',async()=>{
 const h=setup();h.resolveEngine(h.M);const flight=h.run();await new Promise(r=>setImmediate(r));await h.nextFrame();
 h.state.cycle++;await h.nextFrame();assert.equal(await flight,false);assert.equal(h.rotor.style.rotateY,0);
});
test('stalled renderer has a bounded progress guard rather than hanging the transaction',async()=>{
 const h=setup();h.resolveEngine(h.M);const flight=h.run();await new Promise(r=>setImmediate(r));await h.nextFrame();
 assert.equal(h.rotor.style.rotateY,0);h.setClock(3501);await h.nextFrame();assert.equal(await flight,true);assert.equal(h.rotor.style.rotateY,-180);
});
test('initial app setup starts a non-blocking engine warmup before network setup',()=>{
 const init=app.slice(app.indexOf('async function init() {'));
 assert.ok(init.indexOf('void sshKeyMotion._ensure();')>0);
 assert.ok(init.indexOf('void sshKeyMotion._ensure();')<init.indexOf('await initI18n'));
});
