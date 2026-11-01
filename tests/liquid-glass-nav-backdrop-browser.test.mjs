import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, extname } from 'node:path';
const group=process.argv[2] || 'light';
if(!['light','dark'].includes(group)) throw new Error('Run one small group: light or dark');
const root=resolve(new URL('..',import.meta.url).pathname);
const server=createServer(async(req,res)=>{
  const path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
  if(!path.startsWith(root+'/')){res.writeHead(403).end();return;}
  try{const body=await readFile(path);res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript'})[extname(path)]||'application/octet-stream');res.end(body);}catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const profile=await mkdtemp(tmpdir()+'/nav-backdrop-chrome-');
let browser, ws, stderr='', seq=0;const pending=new Map();
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function command(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
try{
 browser=spawn(process.env.CHROMIUM_BIN||'/usr/bin/chromium',['--headless','--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-networking','--disable-extensions','--disable-gpu-shader-disk-cache','--no-first-run','--renderer-process-limit=1','--js-flags=--max-old-space-size=256','--window-size=1200,800','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
 browser.stderr.on('data',b=>{stderr+=b;});
 let port;
 for(let i=0;i<150;i++){try{port=Number((await readFile(profile+'/DevToolsActivePort','utf8')).split('\n')[0]);break;}catch{}await wait(100);}
 if(!port)throw new Error('Chromium startup failed: '+stderr.slice(-2000));
 const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 ws.onmessage=e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}};
 await command('Page.enable');
 await command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/tests/liquid-glass-nav-backdrop-browser.html?group=${group}`});
 let result;
 for(let i=0;i<120;i++){
  const value=await command('Runtime.evaluate',{expression:'window.navBackdropResult || null',returnByValue:true});
  if(value.result?.value){result=value.result.value;break;}await wait(150);
 }
 if(!result)throw new Error('Browser test timed out');
 console.log(JSON.stringify(result,null,2));
 if(!result.ok)process.exitCode=1;
}catch(e){console.error(e);process.exitCode=1;}
finally{
 if(ws){try{await Promise.race([command('Browser.close'),wait(1500)]);}catch{}ws.close();}
 if(browser && browser.exitCode===null){browser.kill('SIGTERM');await wait(800);if(browser.exitCode===null)browser.kill('SIGKILL');}
 server.closeAllConnections();await new Promise(r=>server.close(r));
 await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:200});
}
