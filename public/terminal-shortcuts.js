const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const NAMED_KEYS = ['Escape', 'Tab', 'Enter', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)];
export const SUPPORTED_SHORTCUT_KEYS = Object.freeze([...MODIFIERS, ...NAMED_KEYS, ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i))]);
const KEY_NAMES = new Map([...MODIFIERS, ...NAMED_KEYS].map(key => [key.toLowerCase(), key]));
KEY_NAMES.set('esc', 'Escape');
const ESC = '\x1b';
const SHIFT_FROM = "`1234567890-=[]\\;',./";
const SHIFT_TO = '~!@#$%^&*()_+{}|:"<>?';

/** Validate a physical chord and put modifiers in canonical order. A singleton
 * modifier is a sticky UI action, not something that can be sent to a PTY. */
export function normalizeShortcutKeys(keys) {
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > 3) throw new TypeError('A shortcut needs 1–3 keys');
    const result = keys.map(key => {
        if (typeof key !== 'string') throw new TypeError('Invalid shortcut key');
        const named = KEY_NAMES.get(key.toLowerCase());
        if (named) return named;
        if (/^[\x20-\x7e]$/.test(key)) return key;
        throw new TypeError(`Unknown shortcut key: ${key}`);
    });
    if (new Set(result).size !== result.length) throw new TypeError('Duplicate shortcut key');
    const ordinary = result.filter(key => !MODIFIERS.includes(key));
    if (ordinary.length > 1 || (!ordinary.length && result.length !== 1)) throw new TypeError('A shortcut needs exactly one non-modifier key');
    return [...MODIFIERS.filter(key => result.includes(key)), ...ordinary];
}

function shiftedCharacter(key) {
    if (/^[a-z]$/.test(key)) return key.toUpperCase();
    const index = SHIFT_FROM.indexOf(key);
    if (index >= 0) return SHIFT_TO[index];
    if (/^[A-Z ~!@#$%^&*()_+{}|:"<>?]$/.test(key)) return key;
    throw new TypeError(`Shift is unsupported for character: ${key}`);
}
function controlCharacter(key) {
    if (/^[a-z]$/i.test(key)) return String.fromCharCode(key.toUpperCase().charCodeAt(0) - 64);
    const controls = { ' ': 0, '@': 0, '2': 0, '[': 27, '3': 27, '\\': 28, '4': 28, ']': 29, '5': 29, '^': 30, '6': 30, '_': 31, '7': 31, '?': 127, '8': 127 };
    if (Object.prototype.hasOwnProperty.call(controls, key)) return String.fromCharCode(controls[key]);
    throw new TypeError(`Ctrl is unsupported for character: ${key}`);
}

/** Encode bytes for a traditional xterm-compatible PTY; never synthesize DOM
 * events. Meta aliases Alt (one ESC prefix / xterm Alt bit, even with Alt+Meta).
 * Modified Enter/Escape/Tab/Backspace use xterm modifyOtherKeys when legacy
 * control bytes cannot distinguish the chord. Remote applications must support
 * that extension to distinguish those keys. Ctrl+Shift letters retain C0 bytes. */
export function encodeShortcutKeys(keys) {
    const canonical = normalizeShortcutKeys(keys);
    const key = canonical.find(value => !MODIFIERS.includes(value));
    if (!key) throw new TypeError('A modifier alone has no terminal byte sequence');
    const ctrl = canonical.includes('Ctrl');
    const alt = canonical.includes('Alt') || canonical.includes('Meta');
    const shift = canonical.includes('Shift');
    const modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
    const prefix = value => (alt ? ESC : '') + value;
    const tilde = number => `${ESC}[${number}${modifier > 1 ? `;${modifier}` : ''}~`;
    const final = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' }[key];
    if (final) return `${ESC}[${modifier > 1 ? `1;${modifier}` : ''}${final}`;
    const number = { Home: 1, Insert: 2, Delete: 3, End: 4, PageUp: 5, PageDown: 6 }[key];
    if (number) return tilde(number);
    if (/^F\d+$/.test(key)) {
        const fn = Number(key.slice(1));
        if (fn <= 4) return modifier === 1 ? `${ESC}O${'PQRS'[fn - 1]}` : `${ESC}[1;${modifier}${'PQRS'[fn - 1]}`;
        return tilde([15, 17, 18, 19, 20, 21, 23, 24][fn - 5]);
    }
    if (key === 'Tab' && shift && !ctrl) return modifier === 2 ? `${ESC}[Z` : `${ESC}[1;${modifier}Z`;
    const special = { Enter: 13, Tab: 9, Escape: 27, Backspace: 127 }[key];
    if (special) {
        if (key === 'Backspace' && !shift) return prefix(ctrl ? '\x08' : '\x7f');
        if (ctrl || shift) return `${ESC}[27;${modifier};${special}~`;
        return prefix(String.fromCharCode(special));
    }
    let character = key === 'Space' ? ' ' : key;
    if (shift) character = shiftedCharacter(character);
    if (ctrl) character = controlCharacter(character);
    return prefix(character);
}

const DEFAULT_ITEMS = [
    ...['Ctrl', 'Alt', 'Shift'].map(key => ({ id: key.toLowerCase(), keys: [key] })),
    ...['Escape', 'Tab', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].map(key => ({ id: key === 'Escape' ? 'esc' : key.replace('Arrow', '').toLowerCase(), keys: [key] })),
    ...Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ', key => ({ id: `ctrl-${key.toLowerCase()}`, keys: ['Ctrl', key] })),
    ...Array.from({ length: 12 }, (_, i) => ({ id: `f${i + 1}`, keys: [`F${i + 1}`] })),
];
export const DEFAULT_TERMINAL_SHORTCUTS = Object.freeze(DEFAULT_ITEMS.map(item => Object.freeze({ ...item, keys: Object.freeze(item.keys) })));

/** undefined restores defaults; [] deliberately clears shortcut buttons. Invalid
 * entries (including unencodable chords) and duplicate ids are filtered. Array
 * order is user order. Returned items and keys are independent mutable copies. */
export function normalizeTerminalShortcuts(input) {
    const items = input === undefined ? DEFAULT_TERMINAL_SHORTCUTS : input;
    if (!Array.isArray(items) || items.length > 128) return [];
    const seen = new Set();
    return items.flatMap((item, index) => {
        try {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
            const keys = normalizeShortcutKeys(item.keys);
            if (!(keys.length === 1 && MODIFIERS.includes(keys[0]))) encodeShortcutKeys(keys);
            const id = item.id === undefined ? `shortcut-${index + 1}` : item.id;
            if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id) || seen.has(id)) return [];
            if (item.label !== undefined && (typeof item.label !== 'string' || item.label.length > 80 || /[\u0000-\u001f\u007f]/.test(item.label))) return [];
            seen.add(id);
            const label = typeof item.label === 'string' ? item.label.trim() : '';
            return [{ id, ...(label ? { label } : {}), keys }];
        } catch { return []; }
    });
}

export function shortcutLabel(item) {
    if (typeof item?.label === 'string' && item.label.trim()) return item.label.trim();
    const symbols = { Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space' };
    return normalizeShortcutKeys(item?.keys).map(key => symbols[key] || key).join('+');
}

/** Replaces only the supplied container's children. Existing font controls are
 * owned by the terminal caller, which may append them again without rebinding.
 * onShortcut(item), onModifier(canonicalModifier, item), onFont(delta). When
 * onFont is supplied, A−/A+ buttons are appended, including for an empty list.
 * No HTML interpolation. */
export function renderShortcutButtons(container, items, { onShortcut, onModifier, onFont } = {}) {
    if (!container) return [];
    const normalized = normalizeTerminalShortcuts(items);
    const buttons = normalized.map(item => {
        const button = container.ownerDocument.createElement('button');
        const modifier = item.keys.length === 1 && MODIFIERS.includes(item.keys[0]);
        button.type = 'button';
        button.className = `tool-btn ${modifier ? 'modifier' : 'func'}${/^F\d+$/.test(item.keys[0]) ? ' fn-key' : ''}`;
        button.dataset.shortcutId = item.id;
        button.dataset.key = modifier ? item.keys[0].toLowerCase() : item.id;
        button.textContent = shortcutLabel(item);
        button.title = item.keys.join('+');
        if (modifier) button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => modifier ? onModifier?.(item.keys[0], item) : onShortcut?.(item));
        return button;
    });
    if (onFont) {
        for (const delta of [-1, 1]) {
            const button = container.ownerDocument.createElement('button');
            button.type = 'button';
            button.className = 'tool-btn font-size-btn';
            button.dataset.fontDelta = String(delta);
            button.textContent = delta < 0 ? 'A−' : 'A+';
            button.addEventListener('click', () => onFont(delta));
            buttons.push(button);
        }
    }
    container.replaceChildren(...buttons);
    return buttons;
}
