import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const source = read('public/remote-exec-tools.js');
const authority = read('public/vendor/zephyr-pro/terminal-sftp-pro.js');
const spec = read('public/zephyr-terminal-spec.css');
const css = read('public/remote-exec-tools.css');
const between = (a, b) => source.slice(source.indexOf(a), source.indexOf(b));
const iconSource = between('    const icon = ', '    const scope = ');
const pinSource = between('    const updatePin = ', '    const renderShortcuts = ');
const authoritySvg = authority.match(/pinBtn\.innerHTML = '([^']+)'/)[1];

function node() {
    const classes = new Set();
    const style = Object.fromEntries(['left', 'top', 'width', 'height', 'right', 'bottom'].map(key => [key, '']));
    style.removeProperty = key => { style[key] = ''; };
    const attrs = {};
    return {
        style, dataset: {}, attrs, hidden: false, children: [], innerHTML: '',
        classList: {
            contains: key => classes.has(key),
            add: (...keys) => keys.forEach(key => classes.add(key)),
            remove: (...keys) => keys.forEach(key => classes.delete(key)),
            toggle: (key, enabled) => enabled ? classes.add(key) : classes.delete(key),
        },
        setAttribute(key, value) { attrs[key] = value; },
        querySelector(selector) { return selector === '.z-pin-ico' && this.innerHTML.includes('class="z-pin-ico"') ? {} : null; },
        append(child) { child.parentElement?.removeChild(child); this.children.push(child); child.parentElement = this; },
        insertBefore(child, before) { this.append(child); this.children.splice(this.children.indexOf(child), 1); this.children.splice(this.children.indexOf(before), 0, child); },
        removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentElement = null; },
        remove() { this.parentElement?.removeChild(this); },
        getBoundingClientRect() { return { left: 10, top: 20, width: 420, height: 360 }; },
    };
}
function chrome() {
    const context = vm.createContext({});
    vm.runInContext(between('const ICONS = ', '/** Tier-1 batch tools.') + 'const tr = text => text;\n' + iconSource + pinSource + '\nglobalThis.update = updatePin;', context);
    return context.update;
}

test('pin SVG is byte-identical to SSH pro in all states; stable title/aria and selected chrome', () => {
    const update = chrome();
    for (const kind of ['shortcuts', 'snippets']) {
        const state = { kind, pin: node(), panel: node(), pinned: false, fullscreen: false };
        for (const [pinned, fullscreen] of [[false, false], [true, false], [false, false], [false, true], [true, false]]) {
            state.pinned = pinned; state.fullscreen = fullscreen;
            update(state);
            assert.equal(state.pin.innerHTML, authoritySvg);
            assert.equal(state.pin.title, '停靠/悬浮切换');
            assert.equal(state.pin.attrs['aria-label'], '停靠/悬浮切换');
            assert.equal(state.pin.attrs['aria-pressed'], String(pinned));
            for (const key of ['active', 'on']) assert.equal(state.pin.classList.contains(key), pinned);
            for (const key of ['pinned', 'docked-right']) assert.equal(state.panel.classList.contains(key), pinned);
            assert.equal(state.panel.dataset.pinSide, pinned ? 'right' : undefined);
        }
    }
});

test('use authoritative permanent 45deg SVG rotation and shared dark/light selected fill, never mask', () => {
    assert.match(spec, /\.panel-head-controls \.panel-pin-toggle \.z-pin-ico\s*\{\s*transform: rotate\(45deg\)/);
    assert.match(spec, /\.panel-head-controls \.panel-pin-toggle\.active,[\s\S]*?\.panel-pin-toggle\.on,[\s\S]*?\.pinned \.panel-head-controls \.panel-pin-toggle\s*\{/);
    assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /(?:^|\})[^{}]*(?:remote-exec-tool-pin|z-pin-ico)[^{}]*\{/m);
    assert.doesNotMatch((iconSource + pinSource).replace(/\/\/[^\n]*/g, ''), /mask|state\.pinned\s*\?/);
    assert.match(authority, /b\.classList\.add\('active', 'on'\)/);
});

function runtime() {
    const layer = node(), dock = node(), layoutRoot = node();
    const state = { kind: 'shortcuts', panel: node(), pin: node(), body: node(), trigger: node(), open: true, pinned: false, side: 'right', fullscreen: false, revision: 0, modifiers: new Set() };
    Object.assign(state.panel.style, { left: '12px', top: '24px', width: '420px', height: '360px', right: 'auto', bottom: 'auto' });
    layer.append(state.panel);
    const calls = [];
    const engine = { panelDockMorph: async (candidates, mutate, options) => { calls.push(['dock', options.preset]); mutate(); options.onDone(); }, morph: async () => calls.push(['fullscreen']), panelCloseWasm: async () => calls.push(['close']) };
    const context = vm.createContext({ state, layer, dock, layoutRoot, calls, destroyed: false, panels: new Map([['shortcuts', state]]), root: node(), stageShell: node(),
        motion: () => engine, resolve: () => state, finishResize: () => calls.push(['finishResize']),
        closeMore: () => calls.push(['closeMore']), captureStage: () => ({}), animateStage: async () => {},
        resetMotion: () => {}, bakePanelTransform: () => {}, bringPanelToFront: () => {}, focusPanel: () => {},
        layout: reason => calls.push(['layout', reason]), element: () => node(),
        fitFree: state => { if (state.freeStyle && !state.fullscreen) Object.assign(state.panel.style, state.freeStyle); },
        open: async () => {},
    });
    vm.runInContext(between('const BOX_KEYS', '// Terminal Tier-1 authority:') + pinSource, context);
    // updatePin closes over icon/tr in production; install those exact helpers.
    vm.runInContext(between('const ICONS = ', '/** Tier-1 batch tools.') + 'const tr = text => text;\n' + iconSource, context);
    vm.runInContext(between('    const close = async kind => ', '    const togglePanel = ') + '\nglobalThis.api = { setPinned, setFullscreen, close };', context);
    vm.runInContext('updatePin(state);', context);
    return { state, calls, layer, dock, api: context.api };
}

test('default pin/unpin is right-only and restores free box with one terminal dock morph', async () => {
    const { state, api, calls, layer, dock } = runtime();
    const free = { ...state.panel.style };
    await api.setPinned('shortcuts', true, 'left');
    assert.equal(state.panel.parentElement, dock);
    assert.equal(state.side, 'right'); assert.equal(state.pinned, true);
    assert.equal(state.panel.classList.contains('pinned'), true);
    assert.equal(state.pin.attrs['aria-pressed'], 'true');
    await api.setPinned('shortcuts', false);
    assert.equal(state.panel.parentElement, layer);
    for (const key of ['left', 'top', 'width', 'height']) assert.equal(state.panel.style[key], free[key]);
    assert.equal(state.pin.attrs['aria-pressed'], 'false');
    assert.equal(calls.filter(call => call[0] === 'dock').length, 2);
    assert.equal(dock.children.length, 0);
});

test('docked fullscreen is a no-op; fullscreen pin goes directly to dock, then restores original free box', async () => {
    const { state, api, calls } = runtime();
    const width = state.panel.style.width;
    await api.setPinned('shortcuts', true);
    const count = calls.length;
    await api.setFullscreen(state, true);
    assert.equal(calls.length, count); assert.equal(state.pinned, true); assert.equal(state.fullscreen, false);
    await api.setPinned('shortcuts', false);
    await api.setFullscreen(state, true);
    assert.equal(state.fullscreen, true); assert.equal(state.pin.attrs['aria-pressed'], 'false');
    const morphs = calls.filter(call => call[0] === 'fullscreen').length;
    await api.setPinned('shortcuts', true);
    assert.equal(calls.filter(call => call[0] === 'fullscreen').length, morphs, 'no preliminary fullscreen restore morph');
    assert.equal(state.fullscreen, false); assert.equal(state.panel.classList.contains('panel-fullscreen'), false);
    await api.setPinned('shortcuts', false);
    assert.equal(state.panel.style.width, width);
});

test('close clears docked pin chrome/popover and fullscreen state before reopening', async () => {
    for (const mode of ['docked', 'fullscreen']) {
        const { state, api, calls } = runtime();
        if (mode === 'docked') await api.setPinned('shortcuts', true);
        else await api.setFullscreen(state, true);
        await api.close('shortcuts');
        assert.equal(state.open, false); assert.equal(state.panel.hidden, true);
        assert.equal(state.pinned, false); assert.equal(state.fullscreen, false);
        assert.equal(state.panel.classList.contains('panel-fullscreen'), false);
        assert.equal(state.pin.attrs['aria-pressed'], 'false');
        assert.ok(calls.some(call => call[0] === 'closeMore'));
    }
});

test('pin click uses pro capture semantics, prevents default, closes More and toggles instead of opening a menu', () => {
    const binding = between("        listen(pin, 'click'", "        listen(closeButton, 'click'");
    const calls = [];
    const context = vm.createContext({ pin: {}, kind: 'shortcuts', state: { pinned: false },
        listen: (target, type, fn, options) => { assert.equal(type, 'click'); assert.equal(options.capture, true); context.click = fn; },
        closeMore: instant => calls.push(['closeMore', instant]), setPinned: (...args) => calls.push(['pin', ...args]),
    });
    vm.runInContext(binding, context);
    const event = { preventDefault: () => calls.push(['prevent']), stopImmediatePropagation: () => calls.push(['stop']) };
    context.click(event); context.state.pinned = true; context.click(event);
    assert.deepEqual(calls, [['prevent'], ['stop'], ['closeMore', true], ['pin', 'shortcuts', true], ['prevent'], ['stop'], ['closeMore', true], ['pin', 'shortcuts', false]]);
});
