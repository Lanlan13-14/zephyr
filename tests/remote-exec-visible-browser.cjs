// Run on the isolated test host with Playwright available via NODE_PATH.
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
 const sid = execFileSync('docker',['exec','zephyr-rdp-test','node','-e',`const D=require('/app/node_modules/better-sqlite3'); const db=new D('/app/data/zephyr.db'); const S=require('/app/session-store').SessionStore; const u=db.prepare('SELECT userId,username FROM users WHERE isSuperAdmin=1 LIMIT 1').get(); const s=new S(db,{idleTtlMs:60000,absoluteTtlMs:60000}); process.stdout.write(s.create({userId:u.userId,username:u.username}).sid);`],{encoding:'utf8'}).trim();
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']});
 try {
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addCookies([{name:'zephyr_sid',value:sid,url:'http://127.0.0.1:8089',httpOnly:true,sameSite:'Lax'}]);
 const page=await context.newPage(); page.setDefaultTimeout(6000); page.on('pageerror',e=>console.log('PAGEERROR',e.message));
 await page.goto('http://127.0.0.1:8089/app.html?desktop=1&v=20261101-batch-tools32',{waitUntil:'commit',timeout:12000});
 await page.waitForFunction(()=>document.documentElement.dataset.appBindEvents==='done',{},{timeout:12000});
 await page.locator('[data-view="remote"]').first().click({noWaitAfter:true});
 await page.waitForFunction(()=>document.querySelectorAll('#remoteServerList .server-check input').length>=2,{},{timeout:8000});
 await page.waitForTimeout(600);
 await page.locator('[data-view="remote"]').first().click({noWaitAfter:true});
 await page.waitForFunction(()=>document.querySelector('#view-remote').classList.contains('active'));
 const inspect=()=>page.evaluate(()=>{
 const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
 const dump=e=>{const s=getComputedStyle(e);return {tag:e.tagName,id:e.id,cls:e.className,rect:rect(e),display:s.display,visibility:s.visibility,opacity:s.opacity,position:s.position,z:s.zIndex,bg:s.backgroundColor,transform:s.transform,contain:s.contain,clip:s.clipPath,overflow:s.overflow,pointer:s.pointerEvents}};
 return {body:document.body.className,view:[...document.querySelectorAll('#view-remote,#view-remote .remote-layout,#view-remote .remote-sidebar,#view-remote .remote-stage-shell,#remoteStageContent,#remoteWorkspace,#remoteWorkspace > *,#remoteWorkspace iframe,.remote-exec-tools-layer')].map(dump),center:document.elementsFromPoint(850,400).map(dump).slice(0,9),checks:[...document.querySelectorAll('#remoteServerList input, #remoteServers input')].map(e=>({type:e.type,checked:e.checked})),buttons:[...document.querySelectorAll('#view-remote button')].map(e=>({id:e.id,text:e.innerText})).slice(0,20)};
 });
 console.log('INITIAL',JSON.stringify(await inspect()));
 await page.screenshot({path:'/tmp/remote-exec-empty-after.png'});
 console.log('LIST',await page.locator('#remoteServerList').evaluate(e=>{const dump=n=>{const s=getComputedStyle(n);return {cls:n.className,id:n.id,rect:n.getBoundingClientRect().toJSON(),display:s.display,visibility:s.visibility,height:s.height,flex:s.flex,overflow:s.overflow}};return JSON.stringify([e,e.parentElement,e.parentElement.parentElement,e.firstElementChild].map(dump))}));
 const checks=page.locator('#view-remote .server-check input[type=checkbox]'); console.log('CHECKCOUNT',await checks.count());
 for(let i=0;i<Math.min(2,await checks.count());i++) await page.locator('#view-remote .server-check').nth(i).click({noWaitAfter:true});
 await page.waitForTimeout(4200);
 console.log('TWO',JSON.stringify(await inspect()));
 await page.screenshot({path:'/tmp/remote-exec-visible-before.png'});
 if(process.env.PANEL_PROBE){
 await page.evaluate(()=>{
 window.__keptFrames=[...document.querySelectorAll('#remoteWorkspace iframe')].map(e=>({element:e,win:e.contentWindow}));
 window.__acks=[];const post=window.postMessage.bind(window);window.postMessage=function(data,...args){if(data?.type?.endsWith('-sent'))window.__acks.push({type:data.type,tabId:data.tabId});return post(data,...args)};
 window.__motions=[];for(const method of ['panelOpenWasm','panelCloseWasm','morph']){const fn=window.Motion[method].bind(window.Motion);window.Motion[method]=(...args)=>{window.__motions.push(method);return fn(...args)}};
 });
 await page.evaluate(()=>{window.__openFrames=[];const end=performance.now()+1000;const sample=()=>{const e=document.querySelector('#remoteExecShortcutsPanel');const r=e.getBoundingClientRect();window.__openFrames.push({x:r.x,y:r.y,w:r.width,h:r.height,m:e.classList.contains('z-panel-morphing')});if(performance.now()<end)requestAnimationFrame(sample)};requestAnimationFrame(sample)});
 await page.locator('#remoteShortcutBtn').click({noWaitAfter:true});
 await page.waitForTimeout(1100);
 console.log('OPEN_FRAMES',JSON.stringify(await page.evaluate(()=>window.__openFrames)));
 const style=await page.locator('#remoteExecShortcutsPanel').evaluate(e=>{
 const style=n=>{const s=getComputedStyle(n);return {radius:s.borderRadius,height:s.height,gap:s.gap,padding:s.padding,background:s.backgroundColor,font:s.fontSize,border:s.border}};
 const input=e.querySelector('input');const track=input.nextElementSibling;const thumb=getComputedStyle(track,'::after');
 return {panel:style(e),header:style(e.querySelector('.panel-titlebar')),grid:style(e.querySelector('.shortcut-grid')),key:style(e.querySelector('[data-shortcut-id]')),scope:{checked:input.checked,w:track.getBoundingClientRect().width,h:track.getBoundingClientRect().height,thumbW:thumb.width,thumbH:thumb.height,thumbTransform:thumb.transform}};
 });
 console.log('BATCH_STYLE',JSON.stringify(style));assert.equal(style.panel.radius,'22px');assert.equal(style.header.height,'42px');assert.equal(style.grid.gap,'7px');assert.equal(style.key.height,'32px');assert.equal(style.scope.checked,false);assert.equal(style.scope.w,44);assert.equal(style.scope.h,24);
 await page.locator('#remoteExecShortcutsPanel [data-shortcut-id]').filter({hasText:'Ctrl+L'}).click({noWaitAfter:true});
 await page.waitForTimeout(450);
 const acks=await page.evaluate(()=>window.__acks.filter(a=>a.type==='remote-exec-shortcut-sent'));console.log('REAL_ACKS',JSON.stringify(acks));assert.equal(new Set(acks.map(a=>a.tabId)).size,2);
 await page.locator('#remoteExecShortcutsPanel [data-action=pin]').click({noWaitAfter:true});await page.waitForTimeout(700);
 await page.locator('#remoteSnippetBtn').click({noWaitAfter:true});await page.waitForTimeout(650);
 await page.locator('#remoteExecSnippetsPanel [data-action=pin]').click({noWaitAfter:true});await page.waitForTimeout(700);
 const docked=await page.evaluate(()=>{
 const r=s=>document.querySelector(s).getBoundingClientRect().toJSON();const frames=[...document.querySelectorAll('#remoteWorkspace iframe')];return {sidebar:r('.remote-sidebar'),stage:r('.remote-stage-shell'),toolbar:r('#remoteStageToolbar'),dock:r('#remoteToolsDock'),shortcuts:r('#remoteExecShortcutsPanel'),snippets:r('#remoteExecSnippetsPanel'),frames:frames.map(e=>e.getBoundingClientRect().toJSON()),retained:frames.every((e,i)=>e===window.__keptFrames[i].element&&e.contentWindow===window.__keptFrames[i].win),motions:window.__motions};
 });console.log('DOCKED',JSON.stringify(docked));assert.equal(docked.retained,true);assert.ok(docked.toolbar.right<=docked.dock.left);assert.ok(docked.stage.right<=docked.dock.left);assert.ok(docked.shortcuts.bottom<=docked.snippets.top);assert.equal(docked.dock.top,docked.sidebar.top);assert.equal(docked.dock.bottom,docked.sidebar.bottom);
 await page.screenshot({path:'/tmp/remote-exec-docked-after.png'});
 await page.locator('#remoteExecShortcutsPanel .panel-more-btn').click({noWaitAfter:true});await page.waitForTimeout(650);assert.equal(await page.locator('.z-panel-more-popover').count(),1);console.log('MORE_ACTIONS',await page.locator('.z-panel-more-popover [data-more-action]').evaluateAll(es=>es.map(e=>e.dataset.moreAction)));await page.screenshot({path:'/tmp/remote-exec-more-after.png'});await page.keyboard.press('Escape');
 await page.locator('#remoteExecShortcutsPanel [data-action=close]').click({noWaitAfter:true});await page.waitForTimeout(650);
 await page.locator('#remoteExecSnippetsPanel [data-action=close]').click({noWaitAfter:true});await page.waitForTimeout(650);
 assert.equal(await page.locator('#remoteToolsDock').isHidden(),true);
 console.log('VISIBLE_PANEL_PASS');
 }
 } finally {await browser.close(); execFileSync('docker',['exec','-i','zephyr-rdp-test','node','-e',`const sid=require('fs').readFileSync(0,'utf8');const db=new (require('/app/node_modules/better-sqlite3'))('/app/data/zephyr.db');new(require('/app/session-store').SessionStore)(db,{}).revoke(sid,'remote-visible-probe-finished');`],{input:sid});}
})().catch(e=>{console.error(e);process.exitCode=1});
