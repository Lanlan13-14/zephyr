import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(mobile, 'android/feature-notes/src/main/assets');
let chromium;
try {
    const moduleName = process.env.ZEPHYR_PLAYWRIGHT_MODULE || 'playwright-core';
    ({chromium} = await import(moduleName));
} catch {}
const require = createRequire(import.meta.url);
// The shipped browser logic itself runs, not a regex/reimplementation of its formulas.
const controls = await fs.readFile(path.join(assets,'mobile-preview/image-controls.js'),'utf8');
const {ImageTransform} = require('node:vm').runInNewContext(`${controls};module.exports`, {module:{exports:{}},globalThis:{}});
test('actual image transforms: zoom clamps, one-to-one, rotate, flip, pan and reset', () => {
    const transform = new ImageTransform();
    transform.scale(1.2); assert.equal(transform.zoom,1.2);
    transform.scale(100); assert.equal(transform.zoom,20);
    transform.scale(0); assert.equal(transform.zoom,0.05);
    transform.oneToOne(1200,800,300,200); assert.equal(transform.zoom,4);
    transform.rotate(-90); transform.flip('x'); transform.flip('y'); transform.pan(20,30);
    assert.equal(transform.css(),'translate(20px,30px) rotate(-90deg) scale(-4,-4)');
    transform.reset(); assert.equal(transform.css(),'translate(0px,0px) rotate(0deg) scale(1,1)');
});
test('real Chromium mobile page: PNG decode, all viewer buttons, bridge and pointer pan', {skip:!chromium}, async () => {
    let raw = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=','base64');
    const server = http.createServer(async (req,res) => {
        res.setHeader('Cross-Origin-Opener-Policy','same-origin'); res.setHeader('Cross-Origin-Embedder-Policy','require-corp'); res.setHeader('Cross-Origin-Resource-Policy','same-origin');
        const url = new URL(req.url,'http://localhost');
        if (url.pathname === '/raw/image') { res.end(raw); return; }
        try {
            const file = path.join(assets,url.pathname);
            assert.ok(file.startsWith(assets + path.sep));
            const mime = {'.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.html':'text/html'}[path.extname(file)] || 'application/octet-stream';
            res.setHeader('Content-Type',mime); res.end(await fs.readFile(file));
        } catch { res.writeHead(404);res.end(); }
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    try {
        const page = await browser.newPage({viewport:{width:390,height:700}});
        const errors=[];page.on('pageerror',e=>errors.push(e.message));
        await page.addInitScript(()=>{window.PreviewBridge={sibling:delta=>{window.lastSibling=delta;}};});
        const url=`http://127.0.0.1:${server.address().port}/mobile-preview/image.html?name=pixel.png`;
        await page.goto(url);
        await page.waitForFunction(()=>document.querySelector('#status').hidden,{timeout:20000});
        assert.equal(await page.locator('#image').evaluate(el=>el.naturalWidth),1);
        for(const action of ['zoomIn','zoomOut','oneToOne','rotateLeft','rotateRight','flipHorizontal','flipVertical','view','reset']) {
            await page.locator(`[data-action="${action}"]`).click();
            assert.ok(await page.locator('#image').evaluate(el=>el.style.transform));
        }
        await page.locator('[data-action="next"]').click();assert.equal(await page.evaluate(()=>window.lastSibling),1);
        await page.locator('[data-action="prev"]').click();assert.equal(await page.evaluate(()=>window.lastSibling),-1);
        await page.mouse.move(180,200);await page.mouse.down();await page.mouse.move(205,235);await page.mouse.up();
        assert.match(await page.locator('#image').evaluate(el=>el.style.transform),/translate\(25px, 35px\)/);
        assert.deepEqual(errors,[]);
        // Actual bundled wasm-vips + side modules decode non-browser TIFF and encode WebP.
        const decoded = await page.evaluate(async()=>{
            const {default:Vips}=await import('./vendor/wasm-vips/vips-es6.js');
            const v=await Vips({dynamicLibraries:['vips-jxl.wasm','vips-heif.wasm','vips-resvg.wasm']});
            v.concurrency?.(1);
            const original=v.Image.black(2,3);
            const tiff=new Uint8Array(original.tiffsaveBuffer());
            original.delete();
            const image=v.Image.thumbnailBuffer(tiff,4096,{height:4096,size:'down'});
            const result={width:image.width,height:image.height,length:image.webpsaveBuffer().length};
            image.delete();return result;
        });
        assert.equal(decoded.width,2);assert.equal(decoded.height,3);assert.ok(decoded.length>0);
        raw=Buffer.from('not an image');await page.goto(url);
        await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('预览失败'),{timeout:30000});
    } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
});
