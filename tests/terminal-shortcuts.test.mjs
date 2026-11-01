import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../public/terminal-shortcuts.js', import.meta.url), 'utf8');
const { DEFAULT_TERMINAL_SHORTCUTS: defaults, SUPPORTED_SHORTCUT_KEYS, normalizeShortcutKeys, normalizeTerminalShortcuts: normalize, shortcutLabel, encodeShortcutKeys: encode, renderShortcutButtons: render } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const esc = '\x1b';

test('default order and all legacy function/control bytes are preserved', () => {
    const items = normalize(undefined);
    assert.equal(items.length, 49);
    assert.deepEqual(items.slice(0, 11).map(x => x.id), ['ctrl', 'alt', 'shift', 'esc', 'tab', 'home', 'end', 'up', 'down', 'left', 'right']);
    assert.equal(encode(['Escape']), esc);
    assert.equal(encode(['Tab']), '\t');
    assert.equal(encode(['Home']), esc + '[1~');
    assert.equal(encode(['End']), esc + '[4~');
    for (let i = 0; i < 26; i++) assert.equal(encode(['Ctrl', String.fromCharCode(65 + i)]), String.fromCharCode(1 + i));
    const sequences = ['OP', 'OQ', 'OR', 'OS', '[15~', '[17~', '[18~', '[19~', '[20~', '[21~', '[23~', '[24~'];
    for (let i = 0; i < 12; i++) assert.equal(encode([`F${i + 1}`]), esc + sequences[i]);
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowLeft']) assert.ok(encode([key]).startsWith(esc + '['));
    assert.ok(Object.isFrozen(defaults) && Object.isFrozen(defaults[0].keys));
    items[0].keys.push('A');
    assert.deepEqual(normalize(undefined)[0].keys, ['Ctrl']);
});

test('canonical supported keys and ordering', () => {
    for (const key of ['Ctrl', 'Alt', 'Shift', 'Meta', 'Delete', 'Enter', 'F12', 'a', 'Z', '?']) assert.ok(SUPPORTED_SHORTCUT_KEYS.includes(key));
    assert.deepEqual(normalizeShortcutKeys(['delete', 'alt', 'ctrl']), ['Ctrl', 'Alt', 'Delete']);
    assert.deepEqual(normalizeShortcutKeys(['esc']), ['Escape']);
    assert.deepEqual(normalizeShortcutKeys(['Shift', 'a', 'Ctrl']), ['Ctrl', 'Shift', 'a']);
});

test('ANSI navigation and function-key modifier parameters encode chords, not bytewise transformations', () => {
    assert.equal(encode(['Ctrl', 'Alt', 'Delete']), esc + '[3;7~');
    assert.equal(encode(['Ctrl', 'ArrowLeft']), esc + '[1;5D');
    assert.equal(encode(['Alt', 'Shift', 'ArrowUp']), esc + '[1;4A');
    assert.equal(encode(['Ctrl', 'Home']), esc + '[1;5~');
    assert.equal(encode(['Shift', 'End']), esc + '[4;2~');
    assert.equal(encode(['Ctrl', 'Insert']), esc + '[2;5~');
    assert.equal(encode(['Alt', 'PageUp']), esc + '[5;3~');
    assert.equal(encode(['Shift', 'PageDown']), esc + '[6;2~');
    assert.equal(encode(['Ctrl', 'Alt', 'F1']), esc + '[1;7P');
    assert.equal(encode(['Shift', 'F12']), esc + '[24;2~');
});

test('printable ASCII, shifted symbols, C0 boundaries, Meta as Alt', () => {
    assert.equal(encode(['Enter']), '\r');
    assert.equal(encode(['Backspace']), '\x7f');
    assert.equal(encode(['Ctrl', 'Backspace']), '\b');
    assert.equal(encode(['Space']), ' ');
    assert.equal(encode(['Ctrl', 'Space']), '\x00');
    for (const [key, code] of [['@', 0], ['[', 27], ['\\', 28], [']', 29], ['^', 30], ['_', 31], ['?', 127]]) assert.equal(encode(['Ctrl', key]), String.fromCharCode(code));
    assert.equal(encode(['Shift', 'a']), 'A');
    assert.equal(encode(['Shift', '1']), '!');
    assert.equal(encode(['Shift', '/']), '?');
    assert.equal(encode(['Shift', "'"]), '"');
    assert.equal(encode(['Ctrl', 'Shift', 'a']), '\x01');
    assert.equal(encode(['Meta', 'x']), esc + 'x');
    assert.equal(encode(['Meta', 'Alt', 'x']), esc + 'x');
    assert.equal(encode(['Ctrl', 'Meta', 'Delete']), esc + '[3;7~');
    assert.equal(encode(['Alt', 'Enter']), esc + '\r');
    assert.equal(encode(['Alt', 'Backspace']), esc + '\x7f');
});

test('Tab and modified control keys use explicit xterm distinguishable sequences', () => {
    assert.equal(encode(['Shift', 'Tab']), esc + '[Z');
    assert.equal(encode(['Alt', 'Shift', 'Tab']), esc + '[1;4Z');
    assert.equal(encode(['Ctrl', 'Tab']), esc + '[27;5;9~');
    assert.equal(encode(['Ctrl', 'Enter']), esc + '[27;5;13~');
    assert.equal(encode(['Shift', 'Enter']), esc + '[27;2;13~');
    assert.equal(encode(['Ctrl', 'Escape']), esc + '[27;5;27~');
    assert.equal(encode(['Shift', 'Backspace']), esc + '[27;2;127~');
});

test('invalid chords throw instead of silently sending a different key', () => {
    for (const keys of [undefined, null, [], 'Ctrl+A', ['Ctrl', 'Alt'], ['Ctrl'], ['Hyper', 'A'], ['F13'], ['A', 'B'], ['Ctrl', 'Ctrl', 'A'], ['ctrl', 'Ctrl', 'A'], ['Ctrl', 'Alt', 'Shift', 'A'], [42], ['\n'], ['💻'], ['汉'], ['Ctrl', '1'], ['Ctrl', 'Shift', '1'], ['Shift', '0', '1']]) {
        assert.throws(() => encode(keys), TypeError, JSON.stringify(keys));
    }
});

test('normalize filters invalid values and duplicate ids, preserves explicit empty and custom order', () => {
    assert.deepEqual(normalize([]), []);
    for (const input of [null, {}, false, 'bad']) assert.deepEqual(normalize(input), []);
    const input = [{ id: 'last', keys: ['F12'] }, { id: 'first', label: '<img onerror=x>', keys: ['alt', 'ctrl', 'delete'] }, { id: 'last', keys: ['A'] }, { id: 'bad', keys: ['A', 'B'] }, { id: 'unsupported', keys: ['Ctrl', '1'] }, { id: 'mod', keys: ['Meta'] }, null];
    const items = normalize(input);
    assert.deepEqual(items.map(item => item.id), ['last', 'first', 'mod']);
    assert.deepEqual(items[1].keys, ['Ctrl', 'Alt', 'Delete']);
    assert.equal(shortcutLabel(items[1]), '<img onerror=x>');
    assert.equal(shortcutLabel({ keys: ['Ctrl', 'Alt', 'Delete'] }), 'Ctrl+Alt+Delete');
    assert.equal(shortcutLabel({ keys: ['ArrowUp'] }), '↑');
    assert.equal(shortcutLabel({ keys: ['Escape'] }), 'Esc');
    items[0].keys.push('Alt');
    assert.deepEqual(input[0].keys, ['F12']);
});

export function createFakeGrid() {
    const createElement = () => ({ dataset: {}, attributes: {}, listeners: {}, className: '', setAttribute(k, v) { this.attributes[k] = v; }, addEventListener(k, v) { this.listeners[k] = v; }, click() { this.listeners.click?.(); } });
    return { ownerDocument: { createElement }, children: [], replaceChildren(...nodes) { this.children = nodes; }, appendChild(node) { this.children.push(node); } };
}
test('renderer preserves order, separates sticky modifiers and fonts, and uses textContent', () => {
    const grid = createFakeGrid();
    const actions = [];
    const handlers = { onShortcut: item => actions.push(item.id), onModifier: key => actions.push(key), onFont: delta => actions.push(delta) };
    const buttons = render(grid, [{ id: 'del', label: '<b>Delete</b>', keys: ['Ctrl', 'Alt', 'Delete'] }, { id: 'ctrl', keys: ['Ctrl'] }], handlers);
    assert.equal(buttons.length, 4);
    assert.deepEqual(buttons.map(b => b.textContent), ['<b>Delete</b>', 'Ctrl', 'A−', 'A+']);
    assert.equal(buttons[1].attributes['aria-pressed'], 'false');
    buttons.forEach(b => b.click());
    assert.deepEqual(actions, ['del', 'Ctrl', -1, 1]);
    render(grid, [], handlers);
    assert.equal(grid.children.length, 2);
    render(grid, []);
    assert.equal(grid.children.length, 0);
    assert.deepEqual(render(null, defaults), []);
});

test('normalize enforces persistence-sized arrays, IDs and labels', () => {
    assert.deepEqual(normalize(Array.from({ length: 129 }, (_, i) => ({ id: `s${i}`, keys: ['A'] }))), []);
    for (const item of [{ id: 'x'.repeat(81), keys: ['A'] }, { id: 'with space', keys: ['A'] }, { id: 'x', label: 'x'.repeat(81), keys: ['A'] }, { id: 'x', label: 'bad\nlabel', keys: ['A'] }, { id: 'x', label: {}, keys: ['A'] }]) assert.deepEqual(normalize([item]), []);
    assert.equal(normalize([{ id: 'safe_Id-01', label: 'x'.repeat(80), keys: ['A'] }]).length, 1);
});
