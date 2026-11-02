// Run serially on the remote host only. No business server or login needed.
// node --experimental-websocket tests/liquid-glass-nav-resize-browser.test.mjs light
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, extname } from 'node:path';
const group=process.argv[2]||'light';
if(!['light','dark'].includes(group))throw Error('Choose light or dark; run groups serially');
if(typeof WebSocket!=='function')throw Error('Node 20 requires --experimental-websocket');
const root=resolve(new URL('..',import.meta.url).pathname);
const server=createServer(async(req,res)=>{
 const path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
 if(!path.startsWith(root+'/')){res.writeHead(403).end();return;}
 try{res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(path)]||'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const profile=await mkdtemp(tmpdir()+'/nav-resize-');
let browser,ws,seq=0,stderr='';const pending=new Map();const wait=ms=>new Promise(r=>setTimeout(r,ms));
function command(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const value=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(value.exceptionDetails)throw Error(JSON.stringify(value.exceptionDetails));return value.result.value;}
try{
 browser=spawn(process.env.CHROMIUM_BIN||'/usr/bin/chromium',['--headless','--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-networking','--disable-extensions','--disable-gpu-shader-disk-cache','--no-first-run','--renderer-process-limit=1','--js-flags=--max-old-space-size=256','--window-size=1200,800','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
 browser.stderr.on('data',b=>stderr+=b);
 let port;for(let i=0;i<100;i++){try{port=Number((await readFile(profile+'/DevToolsActivePort','utf8')).split('\n')[0]);break;}catch{}await wait(100);}
 if(!port)throw Error('Chromium startup failed '+stderr.slice(-1000));
 const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}};
 await command('Page.enable');
 await command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/tests/liquid-glass-nav-resize-browser.html`});
 let ready=false;for(let i=0;i<100;i++){if(await evaluate('Boolean(window.ZephyrLiquidGlassBars?.topNav && window.navResizeStep)')){ready=true;break;}await wait(100);}
 if(!ready)throw Error('Fixture failed to boot');
 for(const dpr of [1,2.625])for(const [index,width] of [1200,800,759,1100,900,760].entries()){
  await command('Emulation.setDeviceMetricsOverride',{width,height:700,deviceScaleFactor:dpr,mobile:false});
  await evaluate(`navResizeStep(${index},${index%2?'.125':'0'},${JSON.stringify(group)})`);
 }
 // Observe settling frames as well as active spring/resize frames.
 await wait(500);
 const result=await evaluate('({samples:navResizeSamples.length,errors:navResizeErrors,dpr:ZephyrLiquidGlassBars.topNav.renderer.dpr})');
 console.log(JSON.stringify({group,...result},null,2));
 if(result.samples<12||result.errors.length)throw Error('Geometry containment failed');
}catch(e){console.error(e);process.exitCode=1;}
finally{
 if(ws){try{await Promise.race([command('Browser.close'),wait(500)]);}catch{}ws.close();}
 if(browser&&browser.exitCode===null){browser.kill('SIGTERM');await wait(300);if(browser.exitCode===null)browser.kill('SIGKILL');}
 server.closeAllConnections();await Promise.race([new Promise(r=>server.close(r)),wait(500)]);
 await Promise.race([rm(profile,{recursive:true,force:true,maxRetries:2,retryDelay:100}),wait(1500)]);
 // Browser websocket close events can retain undici's transport handle on Node20.
 // All owned processes/sockets have been closed; bound script teardown explicitly.
 setTimeout(()=>process.exit(process.exitCode||0),100).unref();
}
