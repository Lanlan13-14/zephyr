import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const sharedSource = readFileSync(new URL('../public/terminal-shortcuts.js', import.meta.url), 'utf8');
const shared = await import(`data:text/javascript;base64,${Buffer.from(sharedSource).toString('base64')}`);
const sources = ['terminal.js', 'telnet-terminal.js'].map(name => [name, readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8')]);
function sliceFunction(source, start, end) {
    const a = source.indexOf(start);
    const b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a, start);
    return source.slice(a, b);
}
function setup(source) {
    const parent = { postMessage(message, origin) { replies.push({ ...message, origin }); }, __zephyrRemoteExecViewPolicy() { return context.policy; } };
    const win = { parent, __zephyrBroadcastInputActive: true };
    const replies = [], sent = [], font = [], scroll = [];
    const context = vm.createContext({
        window: win, location: { origin: 'https://test.local', search: '?tabId=tab-1' }, URLSearchParams,
        params: { tabId: 'tab-1' }, policy: { canControl: true, shared: false },
        WebSocket: { OPEN: 1 }, wsConnection: { readyState: 1, send(data) { sent.push(JSON.parse(data)); } }, isConnected: true,
        terminalFontSize: 14, TERMINAL_FONT_STEP: 1, applyTerminalFontSize(size) { font.push(size); },
        setTerminalAutoFollow() {}, requestTerminalAutoFollow() { scroll.push('follow'); }, scheduleTerminalScrollbarUpdate() {},
        normalizeTerminalInputNewlines: data => String(data).replace(/\r\n/g, '\r').replace(/\n/g, '\r'),
        processModifiers: data => 'CORRUPTED:' + data, sftpPro: null,
        encodeShortcutKeys: shared.encodeShortcutKeys,
    });
    const policy = sliceFunction(source, 'function getRemoteExecViewPolicy()', '\nlet sessionPersistenceEnabled');
    vm.runInContext(policy, context);
    const send = sliceFunction(source, 'function sendData(data,', '\n \nfunction preserveTerminalScrollWhileEditingCommandInput');
    vm.runInContext(send, context);
    const handler = sliceFunction(source, 'const remoteExecToolReplies =', "window.addEventListener('message', (ev) => {\n    if (handleRemoteExecToolMessage(ev)) return;");
    vm.runInContext(handler, context);
    const message = (data = {}, event = {}) => context.handleRemoteExecToolMessage({ source: parent, origin: 'https://test.local', data: { source: 'zephyr-app', type: 'remote-exec-shortcut', tabId: 'tab-1', shortcut: { keys: ['Ctrl', 'Alt', 'Delete'] }, ...data }, ...event });
    return { context, parent, replies, sent, font, scroll, message };
}
for (const [name, source] of sources) {
    test(`${name}: immediate shortcut sends exact bytes with modifiers bypassed, no Enter, no broadcast`, () => {
        const h = setup(source);
        assert.equal(h.message({ requestId: 'a', suppressBroadcast: true }), true);
        assert.deepEqual(h.sent, [{ type: 'input', data: '\x1b[3;7~' }]);
        assert.equal(h.replies.length, 1);
        assert.deepEqual(h.replies[0], { source: 'zephyr-terminal', type: 'remote-exec-shortcut-sent', tabId: 'tab-1', requestId: 'a', origin: 'https://test.local' });
        h.message({ requestId: 'a' });
        assert.equal(h.sent.length, 1, 'retry is ACKed without sending twice');
        assert.equal(h.replies.length, 2);
        assert.equal(h.replies.filter(x => x.type === 'zephyr-broadcast-input').length, 0);
    });
    test(`${name}: untrusted origin, sibling frame, own top window, source marker and wrong tab cannot send`, () => {
        const h = setup(source);
        h.message({}, { origin: 'https://evil.local' });
        h.message({}, { source: {} });
        h.message({ tabId: 'different-tab' });
        h.message({ tabId: 123 });
        h.message({ source: 'evil' });
        h.context.window.parent = h.context.window;
        h.message();
        assert.equal(h.sent.length, 0);
        assert.equal(h.replies.length, 0);
    });
    test(`${name}: read-only and offline actions fail immediately and never replay on reconnect`, () => {
        const h = setup(source);
        h.context.policy = { shared: true, canControl: false };
        for (const type of ['remote-exec-shortcut', 'remote-exec-font-size', 'remote-exec-tool-command']) h.message({ type, delta: 1, command: 'whoami', requestId: type });
        assert.ok(h.replies.every(x => x.reason === 'not-controller'));
        h.context.policy = { shared: true, canControl: true };
        h.context.isConnected = false;
        for (const type of ['remote-exec-shortcut', 'remote-exec-font-size', 'remote-exec-tool-command']) h.message({ type, delta: 1, command: 'whoami', requestId: `off:${type}` });
        assert.ok(h.replies.slice(3).every(x => x.reason === 'not-connected'));
        h.context.isConnected = true;
        h.message({ requestId: 'off:remote-exec-shortcut' });
        assert.equal(h.sent.length, 0, 'offline failed request is still failed after reconnect');
        assert.equal(h.font.length, 0);
        h.message({ requestId: 'fresh' });
        assert.equal(h.sent.length, 1);
    });
    test(`${name}: invalid shortcuts, deltas and commands ACK failure without network writes`, () => {
        const h = setup(source);
        for (const keys of [[], ['Ctrl'], ['Ctrl', 'Alt'], ['A', 'B'], ['F13'], ['Ctrl', '1'], ['Ctrl', 'Alt', 'Shift', 'Delete']]) h.message({ shortcut: { keys } });
        h.message({ type: 'remote-exec-font-size', delta: 2 });
        h.message({ type: 'remote-exec-font-size', delta: '1' });
        h.message({ type: 'remote-exec-tool-command', command: '' });
        h.message({ type: 'remote-exec-tool-command', command: {} });
        assert.ok(h.replies.every(x => x.type.endsWith('-failed')));
        assert.equal(h.sent.length, 0);
        assert.equal(h.font.length, 0);
    });
    test(`${name}: font-size controls use the real font action, never send input or broadcast`, () => {
        const h = setup(source);
        h.message({ type: 'remote-exec-font-size', delta: -1, requestId: 'font-minus' });
        h.message({ type: 'remote-exec-font-size', delta: 1, requestId: 'font-plus' });
        assert.deepEqual(h.font, [13, 15]);
        assert.equal(h.sent.length, 0);
        assert.ok(h.replies.every(x => x.type === 'remote-exec-font-size-sent'));
    });
    test(`${name}: autoRun tool snippets normalize newlines once, append Enter only as requested`, () => {
        const h = setup(source);
        h.message({ type: 'remote-exec-tool-command', command: 'echo a\r\necho b', appendEnter: true, requestId: 'snippet' });
        h.message({ type: 'remote-exec-tool-command', command: 'pwd\n', appendEnter: true });
        h.message({ type: 'remote-exec-tool-command', command: 'pwd', appendEnter: false });
        assert.deepEqual(h.sent.map(x => x.data), ['echo a\recho b\r', 'pwd\r', 'pwd']);
        assert.ok(h.replies.every(x => x.type === 'remote-exec-tool-command-sent'));
    });
    test(`${name}: failed WebSocket send is reported, not queued`, () => {
        const h = setup(source);
        h.context.wsConnection.send = () => { throw new Error('closed'); };
        h.message({ requestId: 'throw' });
        assert.equal(h.replies[0].reason, 'send-failed');
        assert.equal(h.sent.length, 0);
    });
    test(`${name}: PTY owner policy falls back read-only for remoteExecOwner and sendData returns success`, () => {
        const h = setup(source);
        delete h.parent.__zephyrRemoteExecViewPolicy;
        h.context.params.remoteExecOwner = true;
        assert.equal(h.context.sendData('x'), undefined);
        h.context.params.remoteExecOwner = false;
        assert.equal(h.context.sendData('x', { applyModifiers: false, skipBroadcast: true }), true);
        assert.deepEqual(h.sent, [{ type: 'input', data: 'x' }]);
        h.context.wsConnection.readyState = 3;
        assert.equal(h.context.sendData('x'), false);
    });
    test(`${name}: terminal-settings rerender and initial GET load are wired without touching snippet handlers`, () => {
        assert.match(source, /e\.source === window\.parent && e\.origin === location\.origin && e\.data\.type === 'terminal-settings'/);
        assert.match(source, /applyTerminalShortcuts\(e\.data\.terminal\.shortcuts\)/);
        assert.match(source, /fetch\('\/api\/settings'/);
        assert.match(source, /fetch\('\/api\/me\/settings'/);
        assert.match(source, /shortcutRevision === terminalShortcutsRevision/);
        assert.match(source, /source: 'snippet-run'/);
        assert.match(source, /grid\.appendChild\(fontDecreaseBtn\)/);
        assert.match(source, /grid\.appendChild\(fontIncreaseBtn\)/);
        assert.match(source, /applyTerminalShortcuts\(terminalShortcuts\)/);
    });
}

for (const [name, source] of sources) {
    test(`${name}: live terminal shortcut panel combines sticky modifiers via encoder and retains font nodes`, () => {
        const grid = { children: [], appendChild(node) { this.children.push(node); } };
        const fonts = [{ id: 'minus' }, { id: 'plus' }];
        const sent = [], errors = [], bindings = [];
        const context = vm.createContext({
            terminalShortcuts: [], modifierState: { ctrl: false, alt: false, shift: false, meta: false },
            normalizeTerminalShortcuts: shared.normalizeTerminalShortcuts, encodeShortcutKeys: shared.encodeShortcutKeys,
            document: { getElementById: id => id === 'shortcutGrid' ? grid : null },
            fontDecreaseBtn: fonts[0], fontIncreaseBtn: fonts[1],
            renderShortcutButtons(container, items, handlers) { container.children = []; bindings.push({ items, handlers }); },
            getRemoteExecViewPolicy: () => ({ canControl: context.canControl }), canControl: true,
            updateModifierUI() {}, sendData(payload, options) { sent.push({ payload, options }); },
            showToast(message) { errors.push(message); },
        });
        vm.runInContext(sliceFunction(source, 'function applyTerminalShortcuts(input)', '\napplyTerminalShortcuts(terminalShortcuts);'), context);
        context.applyTerminalShortcuts(undefined);
        assert.equal(bindings[0].items.length, 49);
        assert.deepEqual(grid.children, fonts);
        const handlers = bindings[0].handlers;
        handlers.onModifier('Ctrl'); handlers.onModifier('Alt');
        handlers.onShortcut({ keys: ['Delete'] });
        assert.equal(sent[0].payload, '\x1b[3;7~');
        assert.equal(sent[0].options.applyModifiers, false);
        handlers.onModifier('Alt'); handlers.onModifier('Ctrl'); handlers.onModifier('Shift');
        handlers.onShortcut({ keys: ['Tab'] });
        assert.equal(sent[1].payload, '\x1b[Z');
        handlers.onModifier('Shift');
        context.applyTerminalShortcuts([{ id: 'second', keys: ['F12'] }, { id: 'first', keys: ['Ctrl', 'A'] }]);
        assert.deepEqual(Array.from(bindings[1].items, x => x.id), ['second', 'first']);
        context.applyTerminalShortcuts([]);
        assert.equal(bindings[2].items.length, 0);
        assert.deepEqual(grid.children, fonts);
        context.canControl = false;
        handlers.onModifier('Ctrl');
        assert.equal(context.modifierState.ctrl, false);
        assert.deepEqual(errors, []);
    });
    test(`${name}: asynchronous initial settings honor personal explicit empty and cannot override newer parent settings`, async () => {
        const applied = [], fetches = [];
        let resolvePersonal, resolvePlatform;
        const personal = new Promise(resolve => { resolvePersonal = resolve; });
        const platform = new Promise(resolve => { resolvePlatform = resolve; });
        const context = vm.createContext({
            terminalShortcutsRevision: 0,
            fetch(url) { fetches.push(url); return url === '/api/me/settings' ? personal : platform; },
            applyTerminalShortcuts(value) { applied.push(value); },
            localStorage: { getItem() { return ''; }, setItem() {} },
            applyTheme() {}, getPreferredTheme() {}, applyWtermTheme() {}, getPreferredWtermTheme() {}, applyTerminalLigatures() {}, applyNotesFeatureEnabled() {}, terminalAllowLigatures: false,
        });
        vm.runInContext(sliceFunction(source, 'async function loadTerminalSettings()', '\nloadTerminalSettings();'), context);
        const loading = context.loadTerminalSettings();
        const custom = [{ id: 'global', keys: ['F1'] }];
        resolvePersonal({ ok: true, json: async () => ({ settings: { terminal: { shortcuts: [] } } }) });
        resolvePlatform({ ok: true, json: async () => ({ terminal: { shortcuts: custom } }) });
        await loading;
        assert.equal(applied.length, 1);
        assert.deepEqual(applied[0], []);
        assert.deepEqual(fetches.sort(), ['/api/me/settings', '/api/settings']);
        applied.length = 0;
        context.fetch = async url => ({ ok: true, json: async () => url === '/api/me/settings' ? { settings: {} } : { terminal: { shortcuts: custom } } });
        await context.loadTerminalSettings();
        assert.deepEqual(applied, [custom]);
        applied.length = 0;
        const race = context.loadTerminalSettings();
        context.terminalShortcutsRevision++;
        await race;
        assert.equal(applied.length, 0, 'parent update during GET wins');
    });
}
