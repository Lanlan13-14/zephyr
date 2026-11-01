'use strict';
// Settings boundary only. Key-to-PTY encoding lives in public/terminal-shortcuts.js.
const MODIFIERS = new Set(['Ctrl', 'Alt', 'Shift', 'Meta']);
const NAMED_KEYS = new Set(['Escape', 'Tab', 'Enter', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)]);
function validateTerminalShortcuts(value) {
    if (!Array.isArray(value) || value.length > 128) throw new TypeError('Expected at most 128 shortcuts.');
    const ids = new Set();
    return value.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)
            || Object.keys(item).some((key) => !['id', 'label', 'keys'].includes(key))) throw new TypeError('Invalid shortcut item.');
        if (typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)) throw new TypeError('Shortcut IDs must be unique.');
        ids.add(item.id);
        if (item.label !== undefined && (typeof item.label !== 'string' || item.label.length > 80 || /[\u0000-\u001f\u007f]/.test(item.label))) throw new TypeError('Invalid shortcut label.');
        if (!Array.isArray(item.keys) || item.keys.length < 1 || item.keys.length > 3 || new Set(item.keys).size !== item.keys.length) throw new TypeError('A shortcut requires one to three different keys.');
        let baseKeys = 0;
        for (const key of item.keys) {
            if (typeof key !== 'string' || !(MODIFIERS.has(key) || NAMED_KEYS.has(key) || /^[\x20-\x7e]$/.test(key))) throw new TypeError('Unknown shortcut key.');
            if (!MODIFIERS.has(key)) baseKeys++;
        }
        // A standalone modifier remains useful as a sticky terminal modifier.
        if (baseKeys !== 1 && !(item.keys.length === 1 && MODIFIERS.has(item.keys[0]))) throw new TypeError('Choose one terminal key with optional modifiers.');
        const base = item.keys.find((key) => !MODIFIERS.has(key));
        if (base && item.keys.includes('Ctrl') && (base === 'Space' || base.length === 1)) {
            let character = base === 'Space' ? ' ' : base;
            if (item.keys.includes('Shift')) {
                const from = "`1234567890-=[]\\;',./";
                const to = '~!@#$%^&*()_+{}|:"<>?';
                const index = from.indexOf(character);
                if (index >= 0) character = to[index];
            }
            if (!/^[A-Za-z]$/.test(character) && ![' ', '@', '2', '[', '3', '\\', '4', ']', '5', '^', '6', '_', '7', '?', '8'].includes(character)) throw new TypeError('Ctrl is unsupported for this character.');
        }
        const result = { id: item.id, keys: [...item.keys] };
        if (item.label !== undefined) result.label = item.label;
        return result;
    });
}
module.exports = { validateTerminalShortcuts };
