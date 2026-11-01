import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
// Execute production functions in isolation; no regex/source-shape assertions.
const original=readFileSync(new URL('../public/liquid-glass-nav.js',import.meta.url),'utf8');
function harness(theme,accent) {
  const attrs={'data-theme':theme,'data-color-scheme':'frost'};
  const vars={'--bg':theme==='light'?'#f5f5f7':'#101114','--accent':accent};
  const calls=[];
  const ctx={setTransform(){},clearRect(){calls.push(['clear']);},fillRect(...r){calls.push(['fill',this.fillStyle,...r]);},save(){},restore(){},scale(){},translate(){},drawImage(...args){calls.push(['image',...args]);},createLinearGradient(){throw new Error('Invented ambient gradient');}};
  const canvas={width:0,height:0,getContext:()=>ctx};
  const root={getAttribute:k=>attrs[k],style:{getPropertyValue:k=>vars[k]||''}};
  const host={dataset:{currentUrl:''}};
  const window={LiquidGlassWebGL:{LiquidGlassRenderer:function(){}},innerWidth:1200,innerHeight:800};
  const document={documentElement:root,readyState:'loading',addEventListener(){},getElementById:()=>host,createElement:()=>canvas};
  const anchor='  function visibleTabs(containerEl, selector) {';
  assert.equal(original.split(anchor).length,2,'test instrumentation anchor is unique');
  const instrumented=original.replace(anchor,'  window.testBackdrop = { render: renderBackdropSliceCanvas, signature: buildBgSignature };\n'+anchor);
  class Image {set src(value){this.complete=true;this.naturalWidth=1200;this.naturalHeight=800;this.onload();}}
  vm.runInNewContext(instrumented,{window,document,Image,getComputedStyle:()=>({getPropertyValue:k=>vars[k]||''})});
  return {api:window.testBackdrop,vars,attrs,host,window,calls,rect:{left:80,top:150,width:240,height:380}};
}
for(const theme of ['light','dark']) test(`${theme}: actual fallback function is base-only across accents`,()=>{
  for(const accent of ['#1a73e8','#b85c22','#3f8f82','#448e96']) {
    const h=harness(theme,accent);h.api.render(h.rect);
    assert.deepEqual(h.calls,[['clear'],['fill',theme==='light'?'rgb(245,245,247)':'rgb(16,17,20)',0,0,120,190]]);
    const before=h.api.signature(h.rect);h.vars['--bg']='#4d535b';assert.notEqual(h.api.signature(h.rect),before);
    const base=h.api.signature(h.rect);h.vars['--accent']='#ff00ff';assert.equal(h.api.signature(h.rect),base);
    h.window.innerWidth=1300;assert.notEqual(h.api.signature(h.rect),base);
  }
});
for(const theme of ['light','dark']) test(`${theme}: loaded wallpaper still draws viewport slice then removes cleanly`,()=>{
  const h=harness(theme,'#b85c22');h.attrs['data-global-wallpaper']='1';h.host.dataset.currentUrl='wallpaper';h.vars['--z-global-bg-opacity']='.65';
  h.api.render(h.rect); // First load starts and publishes the image for next refresh.
  h.calls.length=0;h.api.render(h.rect);
  assert.equal(h.calls.filter(c=>c[0]==='image').length,1);
  assert.equal(h.calls.filter(c=>c[0]==='fill').length,2,'base and scrim retained');
  h.attrs['data-global-wallpaper']='0';h.calls.length=0;h.api.render(h.rect);
  assert.equal(h.calls.filter(c=>c[0]==='image').length,0);assert.equal(h.calls.filter(c=>c[0]==='fill').length,1);
});
