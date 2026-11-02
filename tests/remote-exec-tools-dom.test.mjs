import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, findBrowser } from './helpers/cdp-harness.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const browser = findBrowser();
test('batch tools: real DOM, layout, scope, shared physics and interruption', { skip: !browser, timeout: 120000 }, async t => {
    const server = createServer(async (req, res) => {
        try {
            const path = resolve(repo, `.${decodeURIComponent(new URL(req.url, 'http://localhost').pathname)}`);
            if (!path.startsWith(repo)) { res.writeHead(403).end(); return; }
            const type = { '.js':'text/javascript', '.css':'text/css', '.html':'text/html', '.wasm':'application/wasm', '.json':'application/json' }[extname(path)] || 'application/octet-stream';
            const bytes = await readFile(path);
            res.writeHead(200, { 'Content-Type':type });
            res.end(bytes);
        } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const profile = await mkdtemp(join(tmpdir(), 'remote-tools-dom-'));
    const child = spawn(browser, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--window-size=1280,900','about:blank'], { stdio:['ignore','ignore','pipe'] });
    let cdp;
    try {
        const ws = await new Promise((resolve, reject) => {
            let log = '';
            const timer = setTimeout(() => reject(new Error('Chromium startup timeout: '+log.slice(-1000))),20000);
            child.stderr.on('data', data => {
                log += data;
                const url = log.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
                if (url) { clearTimeout(timer); resolve(url); }
            });
            child.on('error', reject);
        });
        cdp = await Cdp.connect(ws);
        const {targetId} = await cdp.send('Target.createTarget',{url:'about:blank'});
        const {sessionId} = await cdp.send('Target.attachToTarget',{targetId,flatten:true});
        const errors=[];
        cdp.on('Runtime.exceptionThrown',params=>errors.push(params.exceptionDetails.text));
        await cdp.send('Runtime.enable',{},sessionId);
        await cdp.send('Page.enable',{},sessionId);
        const evaluate = async expression => {
            const result = await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);
            if(result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
            return result.result.value;
        };
        await cdp.send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/tests/fixtures/remote-exec-tools-harness.html`},sessionId);
        // Poll a running local browser, not a blind animation settle delay.
        const deadline=Date.now()+15000;
        while(!await evaluate('window.toolsReady === true')) {
            if(Date.now()>deadline) throw new Error('harness not ready: '+JSON.stringify(errors));
            await new Promise(resolve=>setTimeout(resolve,50));
        }
        await t.test('automatic toolbar binding; default scope false; actual Motion M05',async()=>{
            assert.deepEqual(await evaluate('h.tools.getState()'),{shortcuts:{open:false,pinned:false,focusOnly:false},snippets:{open:false,pinned:false,focusOnly:false}});
            assert.equal(await evaluate('h.layouts.length'),0,'constructor does not re-enter parent render');
            await evaluate('h.click("#remoteShortcutBtn"); h.nextFrame()');
            assert.equal(await evaluate('h.tools.getState().shortcuts.open'),true);
            await evaluate('h.tools.close("shortcuts")');
            assert.equal(await evaluate('document.querySelector("#remoteExecShortcutsPanel").hidden'),true);
            await evaluate('h.tools.open("shortcuts")');
            assert.equal(await evaluate('getComputedStyle(document.querySelector("#remoteExecShortcutsPanel")).borderRadius'), '16px');
            await evaluate('h.dockCalls=[]; const orig=h.Motion.panelDockMorph.bind(h.Motion); h.Motion.panelDockMorph=(...args)=>{h.dockCalls.push({preset:args[2].preset,layoutOnly:args[2].layoutOnly.length});return orig(...args)}');
        });
        await t.test('both pin glyphs match terminal across free, right dock, fullscreen and close',async()=>{
            await evaluate('h.engine=null');
            for(const kind of ['shortcuts','snippets']) {
                const id=kind==='shortcuts'?'#remoteExecShortcutsPanel':'#remoteExecSnippetsPanel';
                await evaluate(`h.tools.open('${kind}')`);
                const glyph=()=>evaluate(`(()=>{const b=document.querySelector('${id} .panel-pin-toggle'),s=b.querySelector('svg');return {svg:s.outerHTML,title:b.title,label:b.getAttribute('aria-label'),pressed:b.getAttribute('aria-pressed'),active:b.classList.contains('active'),on:b.classList.contains('on'),transform:getComputedStyle(s).transform}})()`);
                const free=await glyph();assert.equal(free.title,'停靠/悬浮切换');assert.equal(free.label,free.title);assert.equal(free.pressed,'false');assert.match(free.transform,/matrix\(0\.707/);
                await evaluate(`h.click('${id} .panel-pin-toggle')`);const docked=await glyph();assert.equal(docked.svg,free.svg);assert.equal(docked.transform,free.transform);assert.equal(docked.pressed,'true');assert.equal(docked.active,true);assert.equal(docked.on,true);
                assert.equal(await evaluate(`document.querySelector('${id}').parentElement.id`),'remoteToolsDock');
                await evaluate(`h.click('${id} .panel-pin-toggle')`);assert.deepEqual(await glyph(),free);
                await evaluate(`h.tools.close('${kind}')`);
            }
            await evaluate('h.tools.open("shortcuts");h.engine=h.Motion');
        });
        await t.test('terminal rings: pointer-only focus, both corners, capture/cancel, fullscreen and bounds', async () => {
            // Exercise both tools' exact shared ring UI before resizing the shortcut panel.
            await evaluate('h.engine=null;h.tools.open("snippets")');
            assert.equal(await evaluate('document.querySelectorAll("#remoteExecSnippetsPanel > .panel-resize-handle").length'),2);
            await evaluate('document.querySelector("#remoteExecSnippetsPanel").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');
            assert.equal(await evaluate('getComputedStyle(document.querySelector("#remoteExecSnippetsPanel .panel-resize-handle")).pointerEvents'),'auto');
            await evaluate('h.tools.close("snippets")');
            const panel = '#remoteExecShortcutsPanel';
            const mouse = (type, x, y, button = 'left') => cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, sessionId);
            const point = async selector => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
            const styles = () => evaluate(`(()=>{const p=document.querySelector('${panel}'),a=p.querySelector('.panel-resize-handle');return {focused:p.classList.contains('panel-focused'),opacity:getComputedStyle(a).opacity,events:getComputedStyle(a).pointerEvents,overflow:getComputedStyle(p).overflow,bottom:getComputedStyle(a).bottom,width:getComputedStyle(a).width}})()`);
            await evaluate('document.body.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true})); document.querySelector("#remoteExecShortcutsPanel button").focus()');
            const center = await point(`${panel} .remote-exec-tool-header strong`);
            await mouse('mouseMoved', center.x, center.y, 'none');
            assert.equal((await styles()).focused, false, 'neither keyboard focus nor hover opens ring');
            assert.equal((await styles()).events, 'none');
            await mouse('mousePressed', center.x, center.y); await mouse('mouseReleased', center.x, center.y);
            await evaluate('new Promise(resolve=>setTimeout(resolve,350))');
            assert.deepEqual(await styles(), { focused:true, opacity:'1', events:'auto', overflow:'visible', bottom:'-8px', width:'30px' });
            const start = await evaluate(`h.rect('${panel}')`);
            let p = await point(`${panel} > .panel-resize-handle.right`);
            await mouse('mousePressed', p.x, p.y);
            assert.equal(await evaluate(`document.querySelector('${panel} .right').hasPointerCapture(1)`), true);
            await mouse('mouseMoved', p.x + 70, p.y + 40); await mouse('mouseReleased', p.x + 70, p.y + 40);
            let resized = await evaluate(`h.rect('${panel}')`);
            assert.ok(Math.abs(resized.width-start.width-70)<1 && Math.abs(resized.height-start.height-40)<1);
            p = await point(`${panel} > .panel-resize-handle.left`);
            await mouse('mousePressed', p.x, p.y); await mouse('mouseMoved', p.x+40, p.y-20); await mouse('mouseReleased', p.x+40, p.y-20);
            let left = await evaluate(`h.rect('${panel}')`);
            assert.ok(Math.abs(left.right-resized.right)<1, 'left corner anchors opposite edge');
            assert.ok(Math.abs(left.width-resized.width+40)<1);
            const retained = await evaluate(`({width:document.querySelector('${panel}').style.width,height:document.querySelector('${panel}').style.height})`);
            await evaluate('h.tools.pin("shortcuts")');
            assert.equal(await evaluate(`getComputedStyle(document.querySelector('${panel} .right')).display`), 'none');
            assert.equal(await evaluate(`getComputedStyle(document.querySelector('${panel}')).borderRadius`), '14px');
            await evaluate('h.tools.free("shortcuts")');
            assert.equal(await evaluate(`getComputedStyle(document.querySelector('${panel}')).borderRadius`), '16px');
            assert.deepEqual(await evaluate(`({width:document.querySelector('${panel}').style.width,height:document.querySelector('${panel}').style.height})`), retained);
            const fullscreen = async () => evaluate(`h.click('${panel} .panel-more-btn');h.click('[data-more-action=fullscreen]');h.nextFrame()`);
            await fullscreen();
            assert.equal(await evaluate(`document.querySelector('${panel}').classList.contains('panel-fullscreen')`), true);
            await evaluate('h.root.style.width="900px";h.root.style.height="650px";h.nextFrame()');
            assert.equal(await evaluate(`h.rect('${panel}').width`), 900);
            assert.equal(await evaluate(`h.rect('${panel}').height`), 650);
            await fullscreen();
            assert.deepEqual(await evaluate(`({width:document.querySelector('${panel}').style.width,height:document.querySelector('${panel}').style.height})`), retained);
            // Fullscreen retains resize rings and resizing exits fullscreen, as SSH.
            await fullscreen();
            await evaluate(`document.querySelector('${panel}').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
            p = await point(`${panel} > .panel-resize-handle.right`);
            await mouse('mousePressed', p.x, p.y); await mouse('mouseMoved', p.x-100,p.y-100); await mouse('mouseReleased',p.x-100,p.y-100);
            assert.equal(await evaluate(`document.querySelector('${panel}').classList.contains('panel-fullscreen')`), false);
            for (const stop of ['pointercancel', 'lostpointercapture']) {
                p = await point(`${panel} > .panel-resize-handle.right`);
                await mouse('mousePressed',p.x,p.y); await mouse('mouseMoved',p.x+10,p.y+10);
                await evaluate(`document.querySelector('${panel} .right').dispatchEvent(new PointerEvent('${stop}',{pointerId:1,bubbles:true}))`);
                const stopped = await evaluate(`h.rect('${panel}')`);
                await mouse('mouseMoved',p.x+50,p.y+50); await mouse('mouseReleased',p.x+50,p.y+50);
                assert.deepEqual(await evaluate(`h.rect('${panel}')`),stopped);
                assert.equal(await evaluate(`document.querySelector('${panel}').classList.contains('resizing')`),false);
            }
            // Programmatic pin while captured also tears down all gesture listeners.
            p = await point(`${panel} > .panel-resize-handle.right`);
            await mouse('mousePressed',p.x,p.y); await evaluate('h.tools.pin("shortcuts")');
            await mouse('mouseReleased',p.x,p.y);
            assert.equal(await evaluate(`document.querySelector('${panel}').classList.contains('resizing')`),false);
            await evaluate('h.tools.free("shortcuts");h.root.style.width="300px";h.root.style.height="180px";h.nextFrame()');
            const tiny = await evaluate(`({p:h.rect('${panel}'),r:h.rect('#view-remote')})`);
            assert.ok(tiny.p.right<=tiny.r.right && tiny.p.bottom<=tiny.r.bottom, 'available host overrides minimum');
            await evaluate('h.tools.close("shortcuts");h.tools.open("shortcuts")');
            assert.ok(await evaluate(`h.rect('${panel}').right<=h.rect('#view-remote').right`));
            await evaluate('h.root.style.width="1100px";h.root.style.height="720px";h.nextFrame()');
            // The ratio is invariant under host AI/docking classes (no AI-owned DOM mutation).
            await evaluate('h.root.classList.add("has-docked-right");document.body.classList.add("app-body","ai-docked-right")');
            assert.equal(await evaluate('getComputedStyle(document.querySelector(".remote-stage-shell")).borderTopLeftRadius'), '14px');
            assert.equal(await evaluate('getComputedStyle(document.querySelector(".remote-exec-window")).borderTopLeftRadius'), '14px');
            await evaluate('h.root.classList.remove("has-docked-right");document.body.classList.remove("app-body","ai-docked-right");h.engine=h.Motion');
            assert.equal(await evaluate('h.frame===document.querySelector("iframe") && h.frameWindow===h.frame.contentWindow'),true);
        });
        await t.test('two pins consume only right-side layout and each panel scrolls',async()=>{
            const full=await evaluate('h.rect("#remoteWorkspace").width');
            await evaluate('h.tools.pin("shortcuts")');
            assert.deepEqual(await evaluate('h.dockCalls.at(-1)'),{preset:{response:0.22,damping:0.98},layoutOnly:1});
            assert.equal(await evaluate('document.querySelectorAll(".remote-exec-dock-morph-slot,.z-panel-morphing").length'),0);
            const one=await evaluate('({w:h.rect("#remoteWorkspace"),d:h.rect("#remoteToolsDock"),s:h.rect(".remote-layout"),toolbar:h.rect("#toolbar"),stage:h.rect(".remote-stage-shell")})');
            assert.ok(one.w.width<full-100);
            assert.ok(one.d.left>=one.w.right,'dock is outside workspace');
            assert.ok(one.d.right<=one.s.right+1);
            assert.ok(one.toolbar.right<=one.d.left,'sync toolbar stays entirely to dock left');
            assert.ok(Math.abs(one.d.top-one.stage.top)<1,'dock aligns to complete stage top');
            assert.ok(Math.abs(one.d.bottom-one.stage.bottom)<1,'dock aligns to complete stage bottom');
            await evaluate('h.tools.open("snippets").then(()=>h.tools.pin("snippets"))');
            const both=await evaluate('({a:h.rect("#remoteExecShortcutsPanel"),b:h.rect("#remoteExecSnippetsPanel"),w:h.rect("#remoteWorkspace"),count:document.querySelector("#remoteToolsDock").children.length,scroll:[...document.querySelectorAll(".remote-exec-tool-body")].map(el=>[el,...el.querySelectorAll(".snippet-list")].some(node=>node.scrollHeight>node.clientHeight && ["auto","scroll"].includes(getComputedStyle(node).overflowY)))})');
            assert.equal(both.count,2);
            assert.ok(both.a.right<=one.s.right+1);
            assert.ok(both.a.bottom<=both.b.top,'vertical stack not overlap');
            assert.equal(both.w.width,one.w.width,'second pin shares same column');
            assert.deepEqual(both.scroll,[true,true]);
            await evaluate('h.tools.free("shortcuts")');
            assert.ok(await evaluate('h.rect("#remoteWorkspace").width')<full);
            await evaluate('h.tools.close("snippets")');
            assert.equal(await evaluate('h.rect("#remoteWorkspace").width'),full);
            assert.equal(await evaluate('h.frame===document.querySelector("iframe") && h.frameWindow===document.querySelector("iframe").contentWindow'),true,'iframe element and browsing context retained');
        });
        await t.test('independent scope, sticky modifiers, physical key, font callback and safe snippets',async()=>{
            await evaluate('h.engine=null; h.setShortcuts([{id:"ctrl",keys:["Ctrl"]},{id:"alt",keys:["Alt"]},{id:"shift",keys:["Shift"]},{id:"a",keys:["a"]},{id:"delete",keys:["Delete"]}]); h.scope("shortcuts",true); h.click("[data-shortcut-id=ctrl]"); h.click("[data-shortcut-id=alt]"); h.click("[data-shortcut-id=delete]")');
            assert.deepEqual(await evaluate('h.calls.at(-1)'),{type:'shortcut',item:{id:'delete',keys:['Ctrl','Alt','Delete']},options:{focusOnly:true}});
            assert.equal(await evaluate('document.querySelector("[data-shortcut-id=ctrl]").getAttribute("aria-pressed")'),'true');
            await evaluate(`document.querySelector('[data-shortcut-id=a]').dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true,cancelable:true})); h.click('[data-font-delta="1"]')`);
            assert.deepEqual(await evaluate('h.calls.at(-2).item.keys'),['Ctrl','Alt','a']);
            assert.deepEqual(await evaluate('h.calls.at(-1)'),{type:'font',delta:1,options:{focusOnly:true}});
            await evaluate('h.setSnippets([{id:"x",name:"<img src=x onerror=alert(1)>",command:"echo <script>",autoRun:false}]); h.tools.open("snippets"); h.click(".snippet-item")');
            assert.equal(await evaluate('document.querySelector(".snippet-item img")===null'),true);
            assert.deepEqual(await evaluate('h.calls.at(-1).options'),{focusOnly:false});
            assert.equal(await evaluate('h.calls.at(-1).item.autoRun'),false);
            await evaluate('h.scope("snippets",true); h.click(".snippet-item")');
            assert.deepEqual(await evaluate('h.calls.at(-1).options'),{focusOnly:true});
            await evaluate('document.querySelector(".snippet-search").value="no match"; document.querySelector(".snippet-search").dispatchEvent(new Event("input",{bubbles:true}))');
            assert.equal(await evaluate('document.querySelectorAll(".snippet-item").length'),0);
            await evaluate('h.setShortcuts([])');
            assert.equal(await evaluate('document.querySelectorAll("[data-shortcut-id]").length'),0);
            assert.equal(await evaluate('document.querySelectorAll("[data-font-delta]").length'),2);
        });
        await t.test('320px compact layout stays right, bounded and releases width',async()=>{
            await evaluate('h.root.style.width="320px"; h.root.style.height="640px"; h.tools.pin("shortcuts"); h.tools.pin("snippets"); h.nextFrame()');
            const compact=await evaluate('({w:h.rect("#remoteWorkspace"),d:h.rect("#remoteToolsDock"),s:h.rect(".remote-layout"),toolbar:h.rect("#toolbar"),overflow:document.documentElement.scrollWidth>window.innerWidth})');
            assert.ok(compact.d.left>=compact.w.right);
            assert.ok(compact.d.right<=compact.s.right+1);
            assert.ok(compact.w.width>100);
            assert.equal(compact.overflow,false);
            await evaluate('h.tools.free("shortcuts"); h.nextFrame()');
            assert.equal(await evaluate('h.rect("#remoteExecShortcutsPanel").right<=h.rect("#view-remote").right+1'),true);
            await evaluate('h.tools.leave()');
            assert.deepEqual(await evaluate('h.tools.getState()'),{shortcuts:{open:false,pinned:false,focusOnly:true},snippets:{open:true,pinned:true,focusOnly:true}});
            await evaluate('h.tools.close("snippets")');
            assert.equal(await evaluate('h.rect("#remoteWorkspace").width'),320);
        });
        await t.test('interrupted close cannot hide reopened panel; destroy unbinds',async()=>{
            await evaluate('h.engine=h.Motion; h.root.style.width="1000px"; h.tools.open("shortcuts")');
            await evaluate('Promise.all([h.tools.close("shortcuts"),h.tools.open("shortcuts")])');
            assert.equal(await evaluate('h.tools.getState().shortcuts.open && !document.querySelector("#remoteExecShortcutsPanel").hidden'),true);
            await evaluate('document.querySelector("#remoteExecShortcutsPanel .right").dispatchEvent(new PointerEvent("pointerdown",{pointerId:77,button:0,clientX:400,clientY:350,bubbles:true,cancelable:true}));h.tools.destroy();window.dispatchEvent(new PointerEvent("pointermove",{pointerId:77,clientX:700,clientY:600}));h.click("#remoteSnippetBtn")');
            assert.equal(await evaluate('document.querySelectorAll(".remote-exec-tool-panel").length'),0);
            assert.equal(await evaluate('h.rect("#remoteWorkspace").width===h.rect(".remote-stage-shell").width'),true);
            assert.equal(await evaluate('h.layouts.at(-1).reason'),'destroy');
            assert.equal(await evaluate('h.frame===document.querySelector("iframe")'),true);
        });
        assert.deepEqual(errors,[]);
    } finally {
        cdp?.close();
        child.kill('SIGKILL');
        await new Promise(resolve=>server.close(resolve));
        await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    }
});
