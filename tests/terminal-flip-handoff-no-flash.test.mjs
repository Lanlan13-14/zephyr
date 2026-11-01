import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const js=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/zephyr-terminal-spec.css',import.meta.url),'utf8');
const style=readFileSync(new URL('../public/style.css',import.meta.url),'utf8');
const a=js.indexOf('function animateTerminalWindowLayoutFrom(');
const b=js.indexOf('\nfunction resetTerminalWorkspaceKeyboard',a);
test('flip settle installs animations synchronously; ordinary layouts remain rAF batched',()=>{
  let installed=0,raf;
  const w={dataset:{window:'A'},style:{},classList:{add(){},remove(){},contains(){return false}},getBoundingClientRect:()=>({left:10,top:20,width:300,height:400}),animate(){installed++;return {finished:new Promise(()=>{}),cancel(){}}}};
  const ws={classList:{add(){},remove(){}},querySelectorAll:()=>[w]};
  const context=vm.createContext({$:()=>ws,window:{cancelAnimationFrame(){},requestAnimationFrame(fn){raf=fn;return 1},clearTimeout(){},setTimeout(){return 1}},terminalWindowRestRadius:()=>14,buildTerminalMorphFrames:()=>[],TERMINAL_MORPH_DURATION:560,TERMINAL_MORPH_EASING:'linear',scheduleTerminalLayoutStabilize(){},Promise});
  vm.runInContext(js.slice(a,b),context);
  const before=new Map([['A',{left:0,top:0,width:900,height:700}]]);
  context.animateTerminalWindowLayoutFrom(before,{reason:'card-flip-settle'});
  assert.equal(installed,2,'geometry and cosmetics exist before the overlay can be removed');
  installed=0;context.animateTerminalWindowLayoutFrom(before);
  assert.equal(installed,0);assert.equal(typeof raf,'function');raf();assert.equal(installed,2);
});
test('settled sibling remains visible and no fixed containing block is introduced',()=>{
  assert.match(js,/pane\.classList\.add\('card-flip-sibling'\)/);
  assert.match(js,/querySelectorAll\('#terminalWorkspace > \.card-flip-sibling'\)[\s\S]{0,100}classList\.remove\('card-flip-sibling'\)/);
  assert.match(css,/terminal-window:not\(\.terminal-window-morphing\):not\(\.card-flip-sibling\)/);
  assert.match(css,/terminal-window\.card-flip-sibling\s*\{\s*opacity: 1 !important/);
  assert.match(style,/\.terminal-workspace\.terminal-layout-morphing\s*\{[^}]*contain: none/);
});
