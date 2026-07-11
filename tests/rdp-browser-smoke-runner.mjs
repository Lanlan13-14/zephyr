import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';

const chromium = ['chromium','chromium-browser','google-chrome'].find(n => spawnSync('sh',['-c',`command -v ${n}`]).status === 0);
if (!chromium) throw new Error('Chromium is required for test:browser-smoke');
const port=18765, debugPort=18766;
const profile=mkdtempSync(join(tmpdir(),'zephyr-chromium-'));
const server=spawn(process.execPath,['tests/static-smoke-server.mjs',String(port)],{stdio:'ignore'});
const chrome=spawn(chromium,['--headless','--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',`--user-data-dir=${profile}`,'--remote-debugging-address=127.0.0.1',`--remote-debugging-port=${debugPort}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
let chromeError=''; chrome.stderr.on('data',chunk=>chromeError+=chunk);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function json(url){return new Promise((resolve,reject)=>http.get(url,r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{try{resolve(JSON.parse(b))}catch(e){reject(e)}})}).on('error',reject))}
async function cdp(){for(let i=0;i<100;i++){if(chrome.exitCode!==null)throw new Error(`Chromium exited ${chrome.exitCode}: ${chromeError}`);try{const p=(await json(`http://127.0.0.1:${debugPort}/json`))[0];if(p)return new WebSocket(p.webSocketDebuggerUrl)}catch{}await wait(100)}throw new Error(`CDP unavailable: ${chromeError}`)}
async function run(ws,path,expr,validate){let id=0,pending=new Map();ws.on('message',raw=>{const m=JSON.parse(raw);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}});const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))});await call('Page.enable');await call('Runtime.enable');await call('Page.navigate',{url:`http://127.0.0.1:${port}/${path}`});for(let i=0;i<100;i++){const r=await call('Runtime.evaluate',{expression:expr,returnByValue:true});const v=r.result?.value;if(v!==undefined&&v!==null){if(!validate(v))throw new Error(`${path} failed: ${JSON.stringify(v)}`);console.log(`${path}: ${JSON.stringify(v)}`);return}await wait(100)}throw new Error(`${path} timeout`)}
try{await wait(300);const ws=await cdp();await new Promise((r,j)=>{ws.on('open',r);ws.on('error',j)});await run(ws,'tests/rdp-renderer-browser-smoke.html','globalThis.result',v=>v.ok&&v.presents?.[0]===1&&v.pixels?.length===32);await run(ws,'tests/go-worker-runtime-smoke.html','globalThis.goWorkerSmokeResult',v=>v.ok&&v.hasImportObject===true);ws.close()}finally{chrome.kill('SIGKILL');server.kill('SIGTERM');rmSync(profile,{recursive:true,force:true})}
