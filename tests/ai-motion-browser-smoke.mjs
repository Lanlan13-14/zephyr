import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '..');
const mime = {'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css'};
const server = createServer(async (req,res)=>{
  try {
    const u = new URL(req.url,'http://x');
    const full = path.resolve(root, '.' + decodeURIComponent(u.pathname));
    if (!full.startsWith(root)) throw new Error('bad path');
    const data = await readFile(full);
    res.setHeader('content-type', mime[path.extname(full)] || 'application/octet-stream');
    res.end(data);
  } catch { res.statusCode=404;res.end('not found'); }
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const browser=await puppeteer.launch({executablePath:'/usr/bin/chromium-browser',headless:true,protocolTimeout:180000,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote']});
try {
  const page=await browser.newPage();
  await page.setViewport({width:1100,height:760,deviceScaleFactor:1});
  await page.goto(`http://127.0.0.1:${port}/tests/ai-motion-browser-harness.html`,{waitUntil:'networkidle0'});
  await page.waitForFunction(()=>window.Motion?.aiPanelOpen);

  const panelFrames=[];
  await page.evaluate(()=>window.openPanel());
  for(let i=0;i<18;i++){
    panelFrames.push(await page.$eval('#aiAgentPanel',e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return {x:r.x,y:r.y,w:r.width,h:r.height,opacity:+s.opacity,transform:s.transform}}));
    await new Promise(r=>setTimeout(r,20));
  }
  const panelFinal=panelFrames.at(-1);
  assert.ok(panelFrames.some(f=>f.transform!=='none'),'panel must use compositor transform during open');
  assert.ok(panelFrames.every(f=>f.w>0&&f.h>0),'panel geometry must stay valid');
  assert.ok(Math.abs(panelFinal.x-180)<2&&Math.abs(panelFinal.y-90)<2,'panel must settle at authored layout');
  await page.evaluate(()=>window.closePanel());
  assert.equal(await page.$eval('#aiAgentPanel',e=>getComputedStyle(e).display),'none');

  const rects=await page.evaluate(async()=>{
    const add=document.querySelector('#aiAddProviderBtn');
    const edit=document.querySelector('[data-ai-edit-provider]');
    const addRect=add.getBoundingClientRect(), editRect=edit.getBoundingClientRect();
    const samples=[];
    const promise=window.openProvider(edit);
    for(let i=0;i<8;i++){await new Promise(r=>setTimeout(r,18));const r=document.querySelector('#aiProviderForm').getBoundingClientRect();samples.push({x:r.x,y:r.y,w:r.width,h:r.height});}
    await promise;
    const form=document.querySelector('#aiProviderForm'), inner=document.querySelector('#aiProviderModalInner');
    const out={add:{x:addRect.x,y:addRect.y,w:addRect.width,h:addRect.height},edit:{x:editRect.x,y:editRect.y,w:editRect.width,h:editRect.height},samples,overflow:getComputedStyle(form).overflow,maxHeight:getComputedStyle(form).maxHeight,height:getComputedStyle(form).height,innerOverflow:getComputedStyle(inner).overflow};
    await window.closeProvider();
    return out;
  });
  const first=rects.samples[0];
  const distEdit=Math.hypot(first.x-rects.edit.x,first.y-rects.edit.y);
  const distAdd=Math.hypot(first.x-rects.add.x,first.y-rects.add.y);
  assert.ok(distEdit<distAdd,'edit modal must originate from edit button, not add button');
  assert.equal(rects.overflow,'visible');
  assert.equal(rects.maxHeight,'none');
  assert.equal(rects.innerOverflow,'visible');

  console.log(JSON.stringify({ok:true,panelFrames:panelFrames.length,providerOrigin:{distEdit,distAdd},providerOverflow:{overflow:rects.overflow,maxHeight:rects.maxHeight,innerOverflow:rects.innerOverflow}},null,2));
} finally { await browser.close(); await new Promise(r=>server.close(r)); }
