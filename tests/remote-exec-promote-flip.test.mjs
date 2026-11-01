import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const at = app.indexOf(`function ${name}(`);
  const asyncAt = app.indexOf(`async function ${name}(`);
  const start = asyncAt >= 0 && (at < 0 || asyncAt < at) ? asyncAt : at;
  assert.notEqual(start, -1, `${name} exists`);
  // Skip the complete parameter list: destructuring/default {} is not the body.
  let parameterDepth = 0, parameterEnd = -1;
  for (let i = app.indexOf('(', start); i < app.length; i++) {
    if (app[i] === '(') parameterDepth++;
    if (app[i] === ')' && --parameterDepth === 0) { parameterEnd = i; break; }
  }
  assert.notEqual(parameterEnd, -1, `${name} parameters close`);
  const brace = app.indexOf('{', parameterEnd);
  let depth = 0, quote = '', escaped = false, line = false, block = false;
  for (let i = brace; i < app.length; i++) {
    const c = app[i], n = app[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = ''; continue; }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}
function makeContext(extra = {}, additionalNames = []) {
  const context = vm.createContext({ console, ...extra });
  const names = ['createRemoteExecFlipFace', 'animateRemoteExecPromoteFlip', 'promoteRemoteWindowToFullTerminal', ...additionalNames];
  vm.runInContext(names.map(functionSource).join('\n') + `\nthis.api={${names.join(',')}};`, context);
  return context;
}
class Classes {
  constructor() { this.values = new Set(); }
  add(...xs) { xs.forEach(x => this.values.add(x)); }
  remove(...xs) { xs.forEach(x => this.values.delete(x)); }
  contains(x) { return this.values.has(x); }
}
class Element {
  constructor(name = '') {
    this.name = name; this.style = { cssText: '', setProperty(k,v) { this[k] = v; } };
    this.classList = new Classes(); this.attrs = {}; this.dataset = {}; this.isConnected = true;
    this.children = []; this.replacements = []; this.rect = { left: 10, top: 20, width: 200, height: 120 };
  }
  setAttribute(k,v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; if (k === 'style') this.style.cssText = ''; }
  querySelectorAll(selector) { return selector === 'iframe' ? (this.frames || []) : []; }
  cloneNode() { const clone = new Element(`${this.name}-clone`); clone.frames = (this.frames || []).map(() => new Frame()); return clone; }
  replaceChildren(...items) { this.children = items; }
  replaceWith(item) { this.replacements.push(item); }
  getBoundingClientRect() { return this.rect; }
  closest() { return this; }
}
class Frame extends Element {
  constructor() { super('frame'); this.contentDocument = null; this.rect = { left: 0, top: 0, width: 180, height: 80 }; }
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function elementEnv({ reduced = false, openResult = true, failAt = '', playGate, handoffGate } = {}) {
  const body = new Element('body'), stage = new Element('stage'), front = new Element('front');
  const calls = [], motion = { phase: 'settled', hostedWindow: null }, engine = {};
  let context;
  context = makeContext({
    console: { info() {}, warn: (...args) => calls.push(['warn', ...args]) },
    document: { body, createElement: () => new Element('snapshot') },
    window: { matchMedia: () => ({ matches: reduced }) },
    terminalCardFlipMotion: motion, sshKeyMotion: { engine }, currentAppView: 'remote',
    terminalCardSourceRadius: source => { calls.push(['radius', source]); return 12; },
    async playTerminalCardFlipOpen(source, options) {
      calls.push(['play', source, options]);
      assert.equal(motion.fromView, 'remote');
      assert.equal(body.classList.contains('terminal-card-flip-preparing'), true);
      motion.hostedWindow = options.liveWindow;
      motion.sourceEl = source;
      motion.originRect = options.originRect;
      motion.phase = 'opening';
      stage.classList.add('is-active');
      body.classList.add('terminal-card-flip-animating', 'terminal-card-flip-open', 'terminal-card-flip-handoff');
      source.setAttribute('style', 'opacity:0;pointer-events:none');
      source.dataset.motionHidden = '1';
      options.paintFront(front);
      if (playGate) await playGate.promise;
      if (failAt === 'play') throw Error('shared open failed');
      motion.phase = 'open';
      calls.push(['play-resolved']);
      return openResult;
    },
    async finishTerminalCardFlipOpenHandoff() {
      calls.push(['handoff', motion.hostedWindow]);
      motion.phase = 'handoff';
      if (handoffGate) await handoffGate.promise;
      if (failAt === 'handoff') throw Error('shared handoff failed');
      calls.push(['handoff-resolved']);
    },
    restoreCardFlipHostedWindow() { calls.push(['restore', motion.hostedWindow]); motion.hostedWindow = null; },
    releaseCardFlipWindowPins: target => calls.push(['release', target]),
    resetTerminalCardFlipSurface(value) {
      calls.push(['reset', value]);
      stage.classList.remove('is-active');
      body.classList.remove('terminal-card-flip-open');
      motion.originRect = null;
      motion.sourceEl = null;
    },
    applySwitchViewCore(view, options) { calls.push(['recover', view, options]); context.currentAppView = view; },
  });
  return { context, body, stage, front, motion, engine, calls };
}
const callKinds = env => env.calls.map(([kind]) => kind);
function assertClean(env, source, target, originalStyle) {
  assert.equal(source.getAttribute('style'), originalStyle);
  assert.equal(Object.hasOwn(source.dataset, 'motionHidden'), false);
  assert.equal(env.motion.phase, 'settled');
  assert.equal(env.motion.hostedWindow, null);
  assert.equal(env.motion.sourceEl, null);
  assert.equal(env.motion.originRect, null);
  assert.equal(env.stage.classList.contains('is-active'), false);
  for (const name of ['preparing', 'animating', 'handoff', 'open']) {
    assert.equal(env.body.classList.contains(`terminal-card-flip-${name}`), false, name);
  }
  assert.equal(env.calls.filter(([kind, win]) => kind === 'restore' && win === target).length, 1);
  assert.equal(env.calls.filter(([kind, win]) => kind === 'release' && win === target).length, 1);
  assert.equal(env.calls.filter(([kind, engine]) => kind === 'reset' && engine === env.engine).length, 1);
}

test('real adapter delegates reverse/timeScale 1.5 and snapshot painting to shared open, then awaits handoff', async () => {
  const playGate = deferred(), handoffGate = deferred();
  const env = elementEnv({ playGate, handoffGate });
  const remote = new Element('remote'), terminal = new Element('terminal');
  remote.setAttribute('style', 'color:red');
  remote.dataset.connectionId = 'server-A';
  remote.frames = [new Frame()];
  const pending = env.context.api.animateRemoteExecPromoteFlip(remote, terminal);
  const [, source, options] = env.calls.find(([kind]) => kind === 'play');
  assert.equal(source, remote);
  assert.equal(options.liveWindow, terminal);
  assert.deepEqual({ ...options.originRect }, remote.rect);
  assert.notEqual(options.originRect, remote.rect);
  assert.equal(options.connectionId, 'server-A');
  assert.equal(options.radiusFrom, 12);
  assert.equal(options.direction, 'reverse');
  assert.equal(options.timeScale, 1.5);
  assert.equal(typeof options.paintFront, 'function');
  assert.equal(env.front.children[0].name, 'remote-clone');
  assert.equal(remote.frames[0].replacements.length, 0);
  assert.equal(callKinds(env).includes('handoff'), false);
  assert.equal(env.body.classList.contains('terminal-card-flip-animating'), true);
  playGate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.calls.find(([kind]) => kind === 'handoff')[1], terminal);
  assert.equal(callKinds(env).includes('restore'), false, 'finally waits for the shared handoff');
  handoffGate.resolve();
  assert.equal(await pending, true);
  assert.deepEqual(callKinds(env), ['radius', 'play', 'play-resolved', 'handoff', 'handoff-resolved', 'restore', 'release', 'reset']);
  assertClean(env, remote, terminal, 'color:red');
});

test('face snapshots replace only clone iframes and preserve both live owners', () => {
  const context = makeContext({ document: { createElement: () => new Element('snapshot') } });
  for (const name of ['remote', 'terminal']) {
    const owner = new Element(name), frame = new Frame(), face = new Element('face');
    owner.frames = [frame];
    frame.setAttribute('src', `/terminal.html?owner=${name}`);
    const contentWindow = frame.contentWindow = {};
    context.api.createRemoteExecFlipFace(owner, face, 300, 200);
    assert.equal(owner.frames[0], frame);
    assert.equal(frame.contentWindow, contentWindow);
    assert.equal(frame.getAttribute('src'), `/terminal.html?owner=${name}`);
    assert.equal(frame.isConnected, true);
    assert.equal(frame.replacements.length, 0);
    assert.equal(face.children.length, 1);
    const clone = face.children[0];
    assert.notEqual(clone, owner);
    assert.equal(clone.getAttribute('aria-hidden'), 'true');
    assert.equal(clone.frames[0].replacements.length, 1);
  }
});

for (const originalStyle of [null, 'color:red;opacity:.7']) {
  for (const failAt of ['play', 'handoff']) {
    test(`shared ${failAt} failure restores source (${originalStyle ?? 'no inline style'}) and shared state`, async () => {
      const env = elementEnv({ failAt });
      const remote = new Element('remote'), terminal = new Element('terminal');
      if (originalStyle != null) remote.setAttribute('style', originalStyle);
      terminal.setAttribute('style', 'opacity:.8');
      assert.equal(await env.context.api.animateRemoteExecPromoteFlip(remote, terminal), false);
      const expected = failAt === 'play' ? ['radius', 'play'] : ['radius', 'play', 'play-resolved', 'handoff'];
      assert.deepEqual(callKinds(env), [...expected, 'warn', 'recover', 'restore', 'release', 'reset']);
      const [, view, options] = env.calls.find(([kind]) => kind === 'recover');
      assert.equal(view, 'remote');
      assert.equal(options.enteringAnimated, true);
      assert.equal(terminal.getAttribute('style'), 'opacity:.8');
      assertClean(env, remote, terminal, originalStyle);
    });
  }
}

test('shared open returning false skips handoff but still runs finally cleanup', async () => {
  const env = elementEnv({ openResult: false });
  const remote = new Element('remote'), terminal = new Element('terminal');
  assert.equal(await env.context.api.animateRemoteExecPromoteFlip(remote, terminal), false);
  assert.deepEqual(callKinds(env), ['radius', 'play', 'play-resolved', 'restore', 'release', 'reset']);
  assertClean(env, remote, terminal, null);
});

test('reduced motion skips the shared engine and leaves owners and shared state untouched', async () => {
  const env = elementEnv({ reduced: true });
  const remote = new Element('remote'), terminal = new Element('terminal');
  remote.frames = [new Frame()];
  remote.setAttribute('style', 'opacity:.9');
  assert.equal(await env.context.api.animateRemoteExecPromoteFlip(remote, terminal), false);
  assert.deepEqual(env.calls, []);
  assert.equal(remote.getAttribute('style'), 'opacity:.9');
  assert.equal(remote.frames[0].replacements.length, 0);
  assert.equal(env.motion.phase, 'settled');
  assert.equal(env.body.classList.contains('terminal-card-flip-preparing'), false);
});

function promotionEnv({ reduced = false } = {}) {
  const env = elementEnv({ reduced });
  const sessions = new Map(), fullWindows = new Map(), messages = [], removedKeys = [];
  const owners = new Map(), events = [];
  for (const id of ['A', 'B']) {
    const win = new Element(`remote-${id}`), frame = new Frame();
    win.dataset.connectionId = `server-${id}`;
    win.frames = [frame];
    frame.closest = () => win;
    const contentWindow = frame.contentWindow = {
      MessageEvent: class { constructor(type, options) { this.type = type; this.data = options.data; } },
      dispatchEvent: event => messages.push([id, 'remote', event.data]),
    };
    frame.remove = () => { frame.isConnected = false; events.push(['remove-remote', id]); };
    const session = { id, connectionId: `server-${id}`, sharedView: false, promoting: false, frame, params: {}, name: id };
    sessions.set(id, session);
    owners.set(id, { session, frame, contentWindow, win });
  }
  const workspace = new Element('workspace');
  workspace.querySelector = selector => [...fullWindows.values()].find(win => selector.includes(`"${win.dataset.window}"`));
  const context = env.context;
  Object.assign(context, {
    activeRemoteTab: 'A', remoteExecSessions: sessions, terminalTabs: [], activeTerminalTab: null,
    openOrderStack: [], visualLayout: [], recentUseStack: [], closingTerminalTabs: new Set(),
    terminalReconnectFallbackTimers: new Map(), terminalWorkspace: workspace,
    pinnedStateByTabId: new Map(), minimizingTerminalTabs: new Set(),
    dockLaunchAnimatingWindows: new Set(), dockSwapAnimatingWindows: new Set(),
    resetTerminalWindowLayoutMotion: (win, options) => events.push(['cleanup-layout', win, options]),
    CSS: { escape: value => value },
    sessionStorage: {
      setItem(key, value) { events.push(['store', key, value]); },
      removeItem(key) { removedKeys.push(key); },
    },
    isCompactTerminalWorkspace: () => false,
    touchTerminalSession: id => events.push(['touch', id]),
    enforceTerminalWorkspaceLimit: id => events.push(['limit', id]),
    renderTerminalTabs() {
      for (const tab of context.terminalTabs) {
        if (fullWindows.has(tab.id)) continue;
        const win = new Element(`full-${tab.id}`), frame = new Frame();
        win.dataset.window = tab.id;
        frame.dataset.frame = tab.id;
        frame.closest = () => win;
        frame.contentWindow = {
          MessageEvent: owners.get(tab.id).contentWindow.MessageEvent,
          dispatchEvent: event => messages.push([tab.id, 'full', event.data]),
        };
        frame.remove = () => { frame.isConnected = false; fullWindows.delete(tab.id); events.push(['remove-full', tab.id]); };
        win.querySelector = () => frame;
        win.frames = [frame];
        fullWindows.set(tab.id, win);
      }
    },
    switchView(view, options) { events.push(['switch', view, options]); context.currentAppView = view; },
    scheduleTerminalLayoutStabilize: (...args) => events.push(['layout', ...args]),
    scheduleWorkspaceSave: (...args) => events.push(['save', ...args]),
    toast: message => { throw Error(`Unexpected promotion error: ${message}`); },
    $: () => workspace,
    playTerminalWindowCloseMotion: async () => {}, exitTerminalFullscreen: async () => {},
    removeTerminalSnapshot() {}, applySplitSlideState() {}, setTerminalSmartbarOpen() {}, resetTerminalWorkspaceKeyboard() {},
    postRemoteExecMessage: (session, message) => messages.push([session.id, 'remote', message]),
    renderRemoteWorkspace() {},
  });
  context.document.querySelectorAll = selector => selector.includes('iframe')
    ? [...fullWindows.values()].map(win => win.frames[0]) : [...fullWindows.values()];
  vm.runInContext(['openTerminalConnection', 'closeTerminalTab', 'detachRemoteExecFrame'].map(functionSource).join('\n'), context);
  return { ...env, sessions, owners, fullWindows, messages, removedKeys, events };
}
function assertOwnersAlive(env) {
  assert.equal(env.sessions.size, 2);
  for (const [id, owner] of env.owners) {
    assert.equal(env.sessions.get(id), owner.session);
    assert.equal(owner.session.frame, owner.frame);
    assert.equal(owner.frame.contentWindow, owner.contentWindow);
    assert.equal(owner.frame.isConnected, true);
    assert.equal(owner.frame.replacements.length, 0);
    assert.equal(owner.session.promoting, false);
  }
  assert.equal(env.messages.some(([, , message]) => message.type === 'disconnect-terminal'), false);
  assert.equal(env.events.some(([kind]) => kind === 'remove-remote'), false);
  assert.equal(env.removedKeys.some(key => key.startsWith('zephyr_ssh_params_')), false);
}

test('sharedView session promotes again through the real adapter without duplicating its full terminal', async () => {
  const env = promotionEnv();
  const session = env.sessions.get('A');
  session.sharedView = true;
  assert.equal(await env.context.api.promoteRemoteWindowToFullTerminal('A'), true);
  const firstFull = env.fullWindows.get('A');
  env.context.currentAppView = 'remote';
  assert.equal(await env.context.api.promoteRemoteWindowToFullTerminal('A'), true);
  assert.equal(env.fullWindows.get('A'), firstFull);
  assert.equal(env.context.terminalTabs.length, 1);
  assert.equal(session.sharedView, true);
  assert.equal(env.calls.filter(([kind]) => kind === 'play').length, 2);
  assert.equal(env.calls.filter(([kind]) => kind === 'handoff').length, 2);
  assertOwnersAlive(env);
});

test('multi-window promotions target A → B → A and closing a promoted view never closes a remote owner', async () => {
  const env = promotionEnv();
  const targets = [];
  for (const id of ['A', 'B', 'A']) {
    env.context.currentAppView = 'remote';
    assert.equal(await env.context.api.promoteRemoteWindowToFullTerminal(id), true);
    const [, source, options] = env.calls.filter(([kind]) => kind === 'play').at(-1);
    assert.equal(source, env.owners.get(id).win);
    assert.equal(options.liveWindow, env.fullWindows.get(id));
    assert.equal(options.connectionId, `server-${id}`);
    assert.equal(options.direction, 'reverse');
    assert.equal(options.timeScale, 1.5);
    assert.equal(env.calls.filter(([kind]) => kind === 'handoff').at(-1)[1], env.fullWindows.get(id));
    assert.equal(env.context.activeTerminalTab, id);
    assert.equal(env.motion.phase, 'settled');
    assert.equal(env.motion.hostedWindow, null);
    targets.push(options.liveWindow);
    assertOwnersAlive(env);
  }
  assert.equal(targets[0], targets[2], 'A reuses its mounted full-terminal window');
  assert.notEqual(targets[0], targets[1], 'B must not inherit A as the shared back face');
  assert.deepEqual(Array.from(env.context.terminalTabs, tab => tab.id), ['A', 'B']);
  assert.equal(env.events.filter(([kind]) => kind === 'switch').length, 0, 'successful shared flip needs no fallback flip');
  for (const id of ['A', 'B']) {
    env.context.currentAppView = 'terminal';
    await env.context.closeTerminalTab(id);
    assert.equal(env.fullWindows.has(id), false);
    assert.equal(env.sessions.get(id).sharedView, false);
    assert.equal(env.context.currentAppView, 'terminal');
    assertOwnersAlive(env);
  }
  assert.equal(env.context.terminalTabs.length, 0);
  assert.deepEqual(env.events.filter(([kind]) => kind === 'remove-full').map(([, id]) => id), ['A', 'B']);
  assert.equal(env.messages.filter(([, view, message]) => view === 'full' && message.type === 'terminal-settings' && message.workspace.sessionPersistence).length, 2);
});

test('reduced-motion promotion reuses the PTY and switches directly without invoking shared open or handoff', async () => {
  const env = promotionEnv({ reduced: true });
  assert.equal(await env.context.api.promoteRemoteWindowToFullTerminal('A'), true);
  assert.deepEqual(env.calls, []);
  const [, view, options] = env.events.find(([kind]) => kind === 'switch');
  assert.equal(view, 'terminal');
  assert.equal(options.skipCardFlip, true);
  assert.equal(env.sessions.get('A').sharedView, true);
  assert.equal(env.context.terminalTabs[0].remoteExecOwner, true);
  assertOwnersAlive(env);
});
