import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, closeBrowser, Cdp } from './helpers/cdp-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(root, 'public');
const appSource = readFileSync(path.join(publicRoot, 'app.js'), 'utf8');
const runtimeStart = appSource.indexOf('function createBrowserChangeWakeClient');
const runtimeEnd = appSource.indexOf('/* Browser change wake runtime end. */', runtimeStart);
assert.ok(runtimeStart >= 0 && runtimeEnd > runtimeStart);
const wakeRuntime = appSource.slice(runtimeStart, runtimeEnd);

const harnessHtml = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body>
  <main id="fixture">
    <section id="view-notes" class="active">
      <div id="notesShell"><div id="notesList"></div><div id="notesListEmpty" class="force-hidden"></div></div>
      <div id="notesEditorEmpty"></div><div id="notesEditor"></div><div id="notesBody"></div>
      <input id="notesTitleInput"><textarea id="notesContentInput"></textarea>
      <input id="notesTagsInput"><input id="notesGroupInput">
      <div id="notesSaveState"></div><div id="notesPreview"></div>
    </section>
  </main>
  <script>${wakeRuntime.replace(/<\/script/gi, '<\\/script')}</script>
  <script type="module">
    import { createNotesController } from '/notes.js';

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    class FakeTarget extends EventTarget {
      constructor() { super(); this.visibilityState = 'visible'; }
      emit(type) { this.dispatchEvent(new Event(type)); }
    }
    class FakeEventSource {
      static instances = [];
      constructor(url, options) {
        this.url = url;
        this.options = options;
        this.listeners = new Map();
        this.closed = false;
        FakeEventSource.instances.push(this);
      }
      addEventListener(type, listener) { this.listeners.set(type, listener); }
      emit(payload) { this.listeners.get('change')?.({ data: JSON.stringify(payload) }); }
      close() { this.closed = true; }
    }

    window.runWakeScenario = async () => {
      FakeEventSource.instances.length = 0;
      const documentRef = new FakeTarget();
      const windowRef = new FakeTarget();
      const loads = { network: 0, connections: 0 };
      const scheduler = createBrowserChangeRefreshScheduler({
        entityGroups: { connection: 'connections', proxy: 'network', sshKey: 'network', jumpHost: 'network' },
        loaders: {
          connections: async () => { loads.connections += 1; },
          network: async () => { loads.network += 1; await sleep(4); },
        },
        documentRef,
        debounceMs: 5,
      });
      const beforeText = document.body.textContent;
      const client = createBrowserChangeWakeClient({
        endpoint: '/api/me/change-wake',
        entityTypes: ['connection', 'proxy', 'sshKey', 'jumpHost'],
        onEntityTypes: scheduler.schedule,
        onResume: scheduler.resume,
        EventSourceImpl: FakeEventSource,
        documentRef,
        windowRef,
        navigatorRef: { onLine: true },
        locationRef: window.location,
        baseRetryMs: 5,
        maxRetryMs: 20,
      });
      client.start();
      FakeEventSource.instances[0].emit({
        sequence: 8,
        reason: 'change',
        entityTypes: ['proxy', 'sshKey', 'jumpHost', 'connection'],
      });
      await sleep(35);
      FakeEventSource.instances[0].onerror();
      await sleep(10);
      documentRef.visibilityState = 'hidden';
      documentRef.emit('visibilitychange');
      const hiddenCount = FakeEventSource.instances.length;
      await sleep(10);
      documentRef.visibilityState = 'visible';
      documentRef.emit('visibilitychange');
      await sleep(2);
      const result = {
        width: innerWidth,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        loads,
        hiddenCount,
        sourceCount: FakeEventSource.instances.length,
        liveSources: FakeEventSource.instances.filter((source) => !source.closed).length,
        resumedUrl: FakeEventSource.instances.at(-1)?.url || '',
        textUnchanged: beforeText === document.body.textContent,
      };
      client.stop();
      scheduler.stop();
      return result;
    };

    window.runNotesScenario = async () => {
      let note = {
        noteId: 'note-1', title: 'Base', content: 'base', tags: [], groupPath: '',
        revision: 1, updatedAt: Date.now(), createdAt: Date.now(),
      };
      let deferredPut = null;
      let remoteAfterSave = null;
      const api = async (url, options = {}) => {
        if (url === '/api/notes/groups') return { groups: [] };
        if (url.startsWith('/api/notes?')) return { notes: [{ ...note, preview: note.content }] };
        if (url === '/api/notes/note-1' && options.method === 'PUT') {
          const payload = JSON.parse(options.body);
          const save = () => {
            const saved = { ...note, ...payload, revision: note.revision + 1, updatedAt: Date.now() };
            delete saved.expectedRevision;
            note = remoteAfterSave ? { ...remoteAfterSave } : { ...saved };
            return { note: saved };
          };
          if (!deferredPut) return save();
          return new Promise((resolve) => { deferredPut.resolve = () => resolve(save()); });
        }
        if (url === '/api/notes/note-1') return { note: { ...note } };
        throw new Error('unexpected API call: ' + url);
      };
      const controller = createNotesController({ api, toast() {}, openTransientFromUri() {} });
      await controller.activate();
      await controller.selectNote('note-1');
      const input = document.querySelector('#notesContentInput');

      note = { ...note, content: 'remote-clean', revision: 2 };
      await controller.notifyRemoteUpdate();
      const cleanReloaded = input.value === 'remote-clean';

      input.value = 'local-draft';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      note = { ...note, content: 'remote-while-dirty', revision: 3 };
      await controller.notifyRemoteUpdate();
      const dirtyPreserved = input.value === 'local-draft' && controller.state.remoteUpdatePending;

      deferredPut = {};
      remoteAfterSave = { ...note, content: 'remote-after-save', revision: 5 };
      const saving = controller.flushSave();
      await Promise.resolve();
      await controller.notifyRemoteUpdate();
      const savingPreserved = input.value === 'local-draft' && controller.state.saving;
      deferredPut.resolve();
      await saving;
      await sleep(30);
      const refreshedAfterSave = input.value === 'remote-after-save' && !controller.state.remoteUpdatePending;

      input.value = 'local-before-leave';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      note = { ...note, content: 'remote-before-leave', revision: 6 };
      await controller.notifyRemoteUpdate();
      deferredPut = null;
      remoteAfterSave = null;
      await controller.leave();
      const inactiveDeferred = !controller.state.active && controller.state.remoteUpdatePending;
      note = { ...note, content: 'remote-after-leave', revision: 8 };
      await controller.activate();
      return {
        cleanReloaded,
        dirtyPreserved,
        savingPreserved,
        refreshedAfterSave,
        inactiveDeferred,
        refreshedOnReturn: input.value === 'remote-after-leave',
      };
    };

    window.__harnessReady = true;
  </script>
</body></html>`;

const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (pathname === '/harness') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(harnessHtml);
    return;
  }
  const relative = pathname.replace(/^\/+/, '');
  const file = path.resolve(publicRoot, relative);
  if (!file.startsWith(publicRoot + path.sep) || !existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  const type = file.endsWith('.js') ? 'text/javascript; charset=utf-8'
    : file.endsWith('.json') ? 'application/json; charset=utf-8'
      : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(readFileSync(file));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const browser = await launchBrowser({ port: 39461 });
const cdp = await Cdp.connect(browser.wsUrl);

try {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  for (const viewport of [
    { name: 'desktop', width: 1280, height: 820, mobile: false, deviceScaleFactor: 1 },
    { name: 'mobile', width: 390, height: 844, mobile: true, deviceScaleFactor: 2 },
  ]) {
    const { name: viewportName, ...metrics } = viewport;
    await cdp.send('Emulation.setDeviceMetricsOverride', metrics, sessionId);
    await cdp.send('Emulation.setEmulatedMedia', {
      media: '',
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    }, sessionId);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/harness?viewport=${viewportName}` }, sessionId);

    const deadline = Date.now() + 10000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      const check = await cdp.send('Runtime.evaluate', { expression: 'window.__harnessReady === true', returnByValue: true }, sessionId);
      ready = check.result.value === true;
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, `${viewportName} harness did not load`);

    const wakeEval = await cdp.send('Runtime.evaluate', {
      expression: 'window.runWakeScenario()', awaitPromise: true, returnByValue: true,
    }, sessionId);
    assert.equal(wakeEval.exceptionDetails, undefined, `${viewportName} wake scenario threw`);
    const wake = wakeEval.result.value;
    assert.equal(wake.width, viewport.width);
    assert.equal(wake.reducedMotion, true);
    assert.deepEqual(wake.loads, { network: 1, connections: 1 });
    assert.equal(wake.liveSources, 1);
    assert.match(wake.resumedUrl, /\/api\/me\/change-wake\?cursor=8$/);
    assert.equal(wake.textUnchanged, true);

    const notesEval = await cdp.send('Runtime.evaluate', {
      expression: 'window.runNotesScenario()', awaitPromise: true, returnByValue: true,
    }, sessionId);
    assert.equal(notesEval.exceptionDetails, undefined, `${viewportName} Notes scenario threw`);
    assert.deepEqual(notesEval.result.value, {
      cleanReloaded: true,
      dirtyPreserved: true,
      savingPreserved: true,
      refreshedAfterSave: true,
      inactiveDeferred: true,
      refreshedOnReturn: true,
    });
  }

  console.log('browser change wake desktop/mobile scenarios passed');
} finally {
  cdp.close();
  closeBrowser(browser);
  await new Promise((resolve) => server.close(resolve));
}
