import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectPageDiagnostics } from './helpers/cdp-harness.mjs';
const chromium=[process.env.CHROMIUM_BIN,'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'].filter(Boolean).find(existsSync);
assert.ok(chromium,'Chromium required');
const port=Number(process.env.TERMINAL_SHORTCUT_SETTINGS_PORT)||18786;
const profile=mkdtempSync(join(tmpdir(),'zephyr-shortcuts-'));
const server=spawn(process.execPath,['tests/static-smoke-server.mjs',String(port)],{detached:true,stdio:'ignore'});
const wait=ms=>new Promise(r=>setTimeout(r,ms));let browser,page;
try{
 let ready=false;
 for(let i=0;i<40;i++){try{if((await fetch(`http://127.0.0.1:${port}/tests/terminal-shortcut-settings-browser-smoke.html`)).ok){ready=true;break;}}catch{}await wait(100);}
 assert.ok(ready,'static fixture server starts');
 browser=spawn(chromium,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--hide-scrollbars',`--user-data-dir=${profile}`,'--window-size=1280,1024','--remote-debugging-port=0','about:blank'],{stdio:'ignore'});
 let debugPort;
 for(let i=0;i<60;i++){try{debugPort=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);if(debugPort)break;}catch{}await wait(100);}
 assert.ok(debugPort,'browser debugging endpoint starts');
 const info=await(await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
 page=await collectPageDiagnostics(info.webSocketDebuggerUrl,`http://127.0.0.1:${port}/tests/terminal-shortcut-settings-browser-smoke.html`,{settleMs:50});
 let checks;
 for(let i=0;i<100;i++){const text=await page.evaluate('document.getElementById("out")?.textContent||""');if(text){checks=JSON.parse(text);break;}await wait(100);}
 assert.ok(checks,'fixture completes using real frame clock, not virtual-time timers');
 for(const c of checks)console.log(`${c.ok?'PASS':'FAIL'} ${c.name}${c.detail?' :: '+c.detail:''}`);
 assert.deepEqual(checks.filter(c=>!c.ok),[]);assert.deepEqual(page.exceptions,[]);
 console.log(`PASS ${checks.length} terminal-shortcut-settings real DOM checks`);
}finally{
 page?.close();browser?.kill();try{process.kill(-server.pid,'SIGTERM');}catch{}
 await wait(150);rmSync(profile,{recursive:true,force:true,maxRetries:4,retryDelay:100});
}
