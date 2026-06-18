const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const BROWSER_DIR = path.join(__dirname, 'data', 'ai-browser');
const SHOT_DIR = path.join(BROWSER_DIR, 'screenshots');
const PROFILE_DIR = process.env.AI_CHROMIUM_USER_DATA_DIR || path.join(BROWSER_DIR, 'profile');
const DEFAULT_TIMEOUT = 12000;
const DESKTOP_UA = process.env.AI_CHROMIUM_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0))); }
function ensureDirs() { fs.mkdirSync(SHOT_DIR, { recursive: true }); fs.mkdirSync(PROFILE_DIR, { recursive: true }); }
function clipText(text, max = 60000) { const s = String(text || ''); return s.length > max ? `${s.slice(0, max)}\n...[已截断 ${s.length - max} 字符]` : s; }
function findChromium() {
    const candidates = [process.env.CHROMIUM_BIN, process.env.CHROME_BIN, '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].filter(Boolean);
    return candidates.find((bin) => { try { return fs.existsSync(bin); } catch { return false; } }) || 'chromium';
}
function httpJson(url, timeout = DEFAULT_TIMEOUT) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}`));
                try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
            });
        });
        req.setTimeout(timeout, () => { req.destroy(new Error('Chromium CDP HTTP 超时')); });
        req.on('error', reject);
    });
}
function sanitizeUrl(url) {
    const parsed = new URL(String(url || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('浏览器仅允许打开 http/https URL');
    return parsed.href;
}

class CdpClient {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.ws = null;
        this.nextId = 1;
        this.pending = new Map();
        this.events = new Map();
    }
    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.wsUrl);
            const timer = setTimeout(() => reject(new Error('CDP 连接超时')), DEFAULT_TIMEOUT);
            this.ws.on('open', () => { clearTimeout(timer); resolve(this); });
            this.ws.on('message', (raw) => this.handleMessage(raw));
            this.ws.on('error', (err) => {
                for (const item of this.pending.values()) item.reject(err);
                this.pending.clear();
                reject(err);
            });
        });
    }
    handleMessage(raw) {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
            const item = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) item.reject(new Error(msg.error.message || 'CDP 调用失败'));
            else item.resolve(msg.result || {});
            return;
        }
        const handlers = this.events.get(msg.method) || [];
        handlers.forEach((fn) => { try { fn(msg.params || {}, msg); } catch {} });
    }
    send(method, params = {}, sessionId = undefined, timeout = DEFAULT_TIMEOUT) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP 未连接'));
        const id = this.nextId++;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP 调用超时：${method}`)); }, timeout);
            this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (err) => { clearTimeout(timer); reject(err); } });
            this.ws.send(JSON.stringify(payload));
        });
    }
    on(method, fn) {
        const list = this.events.get(method) || [];
        list.push(fn);
        this.events.set(method, list);
    }
    close() { try { this.ws?.close?.(); } catch {} }
}

class AiBrowserService {
    constructor() {
        this.proc = null;
        this.port = Number(process.env.AI_CHROMIUM_DEBUG_PORT || 9223);
        this.client = null;
        this.pages = new Map();
        ensureDirs();
    }
    async ensure() {
        if (this.client) return this.client;
        await this.launch();
        const version = await this.waitVersion();
        this.client = await new CdpClient(version.webSocketDebuggerUrl).connect();
        return this.client;
    }
    async launch() {
        if (this.proc && !this.proc.killed) return;
        const bin = findChromium();
        ensureDirs();
        const args = [
            `--remote-debugging-port=${this.port}`,
            `--user-data-dir=${PROFILE_DIR}`,
            `--user-agent=${DESKTOP_UA}`,
            '--window-size=1365,900', '--lang=zh-CN,zh,en-US,en',
            '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions',
            '--disable-background-networking', '--disable-sync', '--metrics-recording-only', '--mute-audio',
            '--disable-blink-features=AutomationControlled',
            '--no-first-run', '--no-default-browser-check',
            'about:blank',
        ];
        this.proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
        this.proc.stderr.on('data', (chunk) => {
            const text = String(chunk || '').trim();
            if (text && /error|failed|DevTools/i.test(text)) console.warn('[ai-browser]', text.slice(0, 500));
        });
        this.proc.on('exit', () => { this.client?.close?.(); this.client = null; this.pages.clear(); });
    }
    async waitVersion() {
        for (let i = 0; i < 40; i += 1) {
            try { return await httpJson(`http://127.0.0.1:${this.port}/json/version`, 1000); } catch { await delay(250); }
        }
        throw new Error('Chromium 未能启动。请确认镜像/系统已安装 chromium，或设置 CHROMIUM_BIN。');
    }
    async getPage(session = 'default') {
        await this.ensure();
        const key = String(session || 'default');
        const cached = this.pages.get(key);
        if (cached?.sessionId) return cached;
        const target = await this.client.send('Target.createTarget', { url: 'about:blank' });
        const attach = await this.client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        const page = { targetId: target.targetId, sessionId: attach.sessionId, url: 'about:blank' };
        await this.client.send('Page.enable', {}, page.sessionId);
        await this.client.send('Runtime.enable', {}, page.sessionId);
        await this.client.send('DOM.enable', {}, page.sessionId);
        await this.client.send('Emulation.setUserAgentOverride', { userAgent: DESKTOP_UA, acceptLanguage: 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7', platform: 'Win32' }, page.sessionId).catch(() => {});
        await this.client.send('Page.addScriptToEvaluateOnNewDocument', { source: `
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
            window.chrome = window.chrome || { runtime: {} };
        ` }, page.sessionId).catch(() => {});
        this.pages.set(key, page);
        return page;
    }
    async navigate({ url, session = 'default', waitMs = 1000 }) {
        const page = await this.getPage(session);
        const href = sanitizeUrl(url);
        await this.client.send('Page.navigate', { url: href }, page.sessionId);
        await delay(clamp(waitMs, 0, 8000, 1000));
        page.url = href;
        return { session, url: href, title: await this.title(session), text: await this.text(session, 4000) };
    }
    async title(session = 'default') {
        const page = await this.getPage(session);
        const result = await this.client.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, page.sessionId);
        return result?.result?.value || '';
    }
    async text(session = 'default', maxChars = 60000) {
        const page = await this.getPage(session);
        const expression = 'document.body ? document.body.innerText : document.documentElement.innerText';
        const result = await this.client.send('Runtime.evaluate', { expression, returnByValue: true }, page.sessionId);
        return clipText(result?.result?.value || '', maxChars);
    }
    async screenshot({ session = 'default', fullPage = false } = {}) {
        const page = await this.getPage(session);
        let params = { format: 'png', fromSurface: true, captureBeyondViewport: !!fullPage };
        if (fullPage) {
            const metrics = await this.client.send('Page.getLayoutMetrics', {}, page.sessionId).catch(() => null);
            const cs = metrics?.contentSize;
            if (cs?.width && cs?.height) params.clip = { x: 0, y: 0, width: Math.min(12000, cs.width), height: Math.min(12000, cs.height), scale: 1 };
        }
        const shot = await this.client.send('Page.captureScreenshot', params, page.sessionId, 30000);
        const id = `${Date.now()}-${Math.random().toString(16).slice(2)}.png`;
        const file = path.join(SHOT_DIR, id);
        fs.writeFileSync(file, Buffer.from(shot.data || '', 'base64'));
        return { id, path: file, url: `/api/ai/browser/screenshots/${encodeURIComponent(id)}`, bytes: fs.statSync(file).size, session };
    }
    async inspect({ session = 'default', max = 80 } = {}) {
        const page = await this.getPage(session);
        const expression = `(() => {
            const cssEscape = (value) => (window.CSS && CSS.escape) ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
            const selectorFor = (el) => {
                if (el.id) return '#' + cssEscape(el.id);
                const name = el.getAttribute('name');
                if (name) return el.tagName.toLowerCase() + '[name="' + name.replace(/"/g, '\\\"') + '"]';
                const aria = el.getAttribute('aria-label');
                if (aria) return el.tagName.toLowerCase() + '[aria-label="' + aria.replace(/"/g, '\\\"') + '"]';
                const parts = [];
                let cur = el;
                while (cur && cur.nodeType === 1 && parts.length < 5) {
                    const tag = cur.tagName.toLowerCase();
                    const parent = cur.parentElement;
                    if (!parent) { parts.unshift(tag); break; }
                    const same = Array.from(parent.children).filter((x) => x.tagName === cur.tagName);
                    const idx = same.indexOf(cur) + 1;
                    parts.unshift(same.length > 1 ? tag + ':nth-of-type(' + idx + ')' : tag);
                    cur = parent;
                }
                return parts.join(' > ');
            };
            const visible = (el) => {
                const r = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return r.width > 1 && r.height > 1 && style.visibility !== 'hidden' && style.display !== 'none' && r.bottom >= 0 && r.right >= 0 && r.top <= innerHeight && r.left <= innerWidth;
            };
            const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"],summary,label'));
            return nodes.filter(visible).slice(0, ${clamp(max, 1, 200, 80)}).map((el, index) => {
                const r = el.getBoundingClientRect();
                return {
                    index,
                    tag: el.tagName.toLowerCase(),
                    type: el.getAttribute('type') || '',
                    role: el.getAttribute('role') || '',
                    selector: selectorFor(el),
                    text: String(el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.title || '').trim().slice(0, 160),
                    href: el.href || '',
                    x: Math.round(r.left + r.width / 2),
                    y: Math.round(r.top + r.height / 2),
                };
            });
        })()`;
        const result = await this.client.send('Runtime.evaluate', { expression, returnByValue: true }, page.sessionId);
        return { session, url: page.url, title: await this.title(session), elements: result?.result?.value || [] };
    }
    async click({ session = 'default', selector = '', x = null, y = null }) {
        const page = await this.getPage(session);
        let px = Number(x), py = Number(y), meta = {};
        if (selector) {
            const expression = `(function(){const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return {ok:false,error:'selector not found'}; el.scrollIntoView({block:'center',inline:'center'}); const r=el.getBoundingClientRect(); return {ok:true,x:r.left+r.width/2,y:r.top+r.height/2,text:el.innerText||el.value||el.getAttribute('aria-label')||'',tag:el.tagName};})()`;
            const result = await this.client.send('Runtime.evaluate', { expression, returnByValue: true }, page.sessionId);
            const value = result?.result?.value || {};
            if (!value.ok) throw new Error(value.error || '点击失败');
            px = Number(value.x); py = Number(value.y); meta = value;
        }
        if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error('请提供 selector 或 x/y 坐标');
        await this.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none' }, page.sessionId);
        await this.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 }, page.sessionId);
        await this.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1 }, page.sessionId);
        await delay(250);
        return { ok: true, ...meta, x: px, y: py, title: await this.title(session), url: page.url };
    }
    async type({ session = 'default', selector = '', text = '', clear = false }) {
        const page = await this.getPage(session);
        if (!selector) throw new Error('请输入表单 selector');
        const expression = `(function(){const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return {ok:false,error:'selector not found'}; el.scrollIntoView({block:'center',inline:'center'}); el.focus(); if(${clear ? 'true' : 'false'}){ if('value' in el){ el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); } else { el.textContent=''; } } const r=el.getBoundingClientRect(); return {ok:true,x:r.left+r.width/2,y:r.top+r.height/2,tag:el.tagName,value:el.value||el.textContent||''};})()`;
        const result = await this.client.send('Runtime.evaluate', { expression, returnByValue: true }, page.sessionId);
        const focused = result?.result?.value || {};
        if (!focused.ok) throw new Error(focused.error || '输入失败');
        await this.client.send('Input.insertText', { text: String(text || '') }, page.sessionId);
        await delay(120);
        const read = await this.client.send('Runtime.evaluate', { expression: `(function(){const el=document.querySelector(${JSON.stringify(selector)}); return el ? {ok:true,value:el.value||el.textContent||''} : {ok:false};})()`, returnByValue: true }, page.sessionId).catch(() => null);
        return { ...focused, ...(read?.result?.value || {}), title: await this.title(session), url: page.url };
    }
    async key({ session = 'default', key = 'Enter' }) {
        const page = await this.getPage(session);
        const name = String(key || 'Enter');
        const map = {
            Enter: ['Enter', 'Enter', 13], Tab: ['Tab', 'Tab', 9], Escape: ['Escape', 'Escape', 27], Backspace: ['Backspace', 'Backspace', 8], Delete: ['Delete', 'Delete', 46],
            ArrowUp: ['ArrowUp', 'ArrowUp', 38], ArrowDown: ['ArrowDown', 'ArrowDown', 40], ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37], ArrowRight: ['ArrowRight', 'ArrowRight', 39],
            Home: ['Home', 'Home', 36], End: ['End', 'End', 35], PageUp: ['PageUp', 'PageUp', 33], PageDown: ['PageDown', 'PageDown', 34], Space: [' ', 'Space', 32],
        };
        const [keyName, code, vk] = map[name] || [name, name, name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0];
        await this.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: vk }, page.sessionId);
        await this.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk }, page.sessionId);
        await delay(180);
        return { ok: true, key: name, title: await this.title(session), url: page.url };
    }
    async wait({ session = 'default', ms = 1000 } = {}) {
        const page = await this.getPage(session);
        await delay(clamp(ms, 0, 15000, 1000));
        return { ok: true, session, url: page.url, title: await this.title(session), text: await this.text(session, 2000) };
    }
    async scroll({ session = 'default', direction = 'down', amount = 800 }) {
        const page = await this.getPage(session);
        const sign = direction === 'up' ? -1 : 1;
        const px = clamp(amount, 1, 8000, 800) * sign;
        const expression = `window.scrollBy({top:${px},left:0,behavior:'instant'}); ({x:window.scrollX,y:window.scrollY,height:document.documentElement.scrollHeight})`;
        const result = await this.client.send('Runtime.evaluate', { expression, returnByValue: true }, page.sessionId);
        return result?.result?.value || { ok: true };
    }
    async evaluate({ session = 'default', script = '' }) {
        const page = await this.getPage(session);
        const result = await this.client.send('Runtime.evaluate', { expression: String(script || ''), awaitPromise: true, returnByValue: true }, page.sessionId);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'JS 执行失败');
        return result?.result?.value;
    }
    async reset(session = 'default') {
        const key = String(session || 'default');
        const page = this.pages.get(key);
        if (page?.targetId) await this.client?.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
        this.pages.delete(key);
        return { ok: true, session: key };
    }
    async closeSession(session = 'default') {
        return this.reset(session);
    }
}
function clamp(value, min, max, fallback) { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; }

const browserService = new AiBrowserService();
module.exports = { browserService, SHOT_DIR };
