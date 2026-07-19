/**
 * Mobile soft-keyboard helpers for the RDP WASM client.
 *
 * The page keeps a 1px textarea as an IME host. ASCII is converted to key
 * scancodes (with Shift when needed). CJK / emoji / full-width text goes
 * through clipboard paste so the remote IME composition stays intact.
 */

const DIGIT_SHIFT = {
    '!': 'Digit1',
    '@': 'Digit2',
    '#': 'Digit3',
    $: 'Digit4',
    '%': 'Digit5',
    '^': 'Digit6',
    '&': 'Digit7',
    '*': 'Digit8',
    '(': 'Digit9',
    ')': 'Digit0',
};

const PUNCT_BASE = {
    ' ': 'Space',
    '\n': 'Enter',
    '\r': 'Enter',
    '\t': 'Tab',
    '-': 'Minus',
    '=': 'Equal',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '\\': 'Backslash',
    ';': 'Semicolon',
    "'": 'Quote',
    '`': 'Backquote',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
};

const PUNCT_SHIFT = {
    _: 'Minus',
    '+': 'Equal',
    '{': 'BracketLeft',
    '}': 'BracketRight',
    '|': 'Backslash',
    ':': 'Semicolon',
    '"': 'Quote',
    '~': 'Backquote',
    '<': 'Comma',
    '>': 'Period',
    '?': 'Slash',
};

export function isAsciiPrintable(text) {
    if (!text) return false;
    for (const ch of text) {
        const c = ch.charCodeAt(0);
        if (c < 0x20 || c > 0x7e) return false;
    }
    return true;
}

/** Map one character to a keyboard event plan. */
export function planCharInput(char) {
    if (!char) return null;
    if (char.length !== 1) return { type: 'clipboard', text: char };

    if (char >= 'a' && char <= 'z') {
        return { type: 'keys', steps: [{ code: 'Key' + char.toUpperCase(), shift: false }] };
    }
    if (char >= 'A' && char <= 'Z') {
        return { type: 'keys', steps: [{ code: 'Key' + char, shift: true }] };
    }
    if (char >= '0' && char <= '9') {
        return { type: 'keys', steps: [{ code: 'Digit' + char, shift: false }] };
    }
    if (DIGIT_SHIFT[char]) {
        return { type: 'keys', steps: [{ code: DIGIT_SHIFT[char], shift: true }] };
    }
    if (PUNCT_BASE[char]) {
        return { type: 'keys', steps: [{ code: PUNCT_BASE[char], shift: false }] };
    }
    if (PUNCT_SHIFT[char]) {
        return { type: 'keys', steps: [{ code: PUNCT_SHIFT[char], shift: true }] };
    }
    // Non-ASCII (CJK, emoji, full-width punctuation) → clipboard paste.
    return { type: 'clipboard', text: char };
}

export function planTextInput(text) {
    if (!text) return [];
    if (!isAsciiPrintable(text)) {
        return [{ type: 'clipboard', text }];
    }
    const plans = [];
    for (const ch of text) {
        const plan = planCharInput(ch);
        if (plan) plans.push(plan);
    }
    return plans;
}

/**
 * Decide whether the keyboard button should close the IME host.
 * True only when the soft keyboard host is currently focused/open.
 */
export function shouldToggleKeyboardClosed(isOpen, activeIsHost) {
    return !!(isOpen && activeIsHost);
}

/**
 * Lightweight controller for open/close + composition-safe text dispatch.
 * Dependencies are injected so unit tests do not need a real RDP session.
 */
export class RdpMobileKeyboard {
    constructor({
        host,
        button,
        isConnected = () => true,
        sendKeyDown,
        sendKeyUp,
        sendClipboardText,
        keyHoldMs = 30,
    } = {}) {
        this.host = host;
        this.button = button;
        this.isConnected = isConnected;
        this.sendKeyDown = sendKeyDown;
        this.sendKeyUp = sendKeyUp;
        this.sendClipboardText = sendClipboardText;
        this.keyHoldMs = keyHoldMs;
        this.open = false;
        this.composing = false;
        this._pasteQueue = Promise.resolve();
        this._onPointerDown = (e) => {
            // Keep the host's focus decision under our control. Without this,
            // a second tap focuses the button and the OS dismisses the IME
            // before our click handler can toggle cleanly.
            e.preventDefault();
        };
        this._onClick = (e) => {
            e.preventDefault();
            this.toggle();
        };
        this._onFocus = () => this.setOpen(true);
        this._onBlur = () => {
            // Delay so a button press that blurs the host can still read open=true.
            setTimeout(() => {
                if (document.activeElement !== this.host) this.setOpen(false);
            }, 0);
        };
        this._onCompositionStart = () => {
            this.composing = true;
        };
        this._onCompositionEnd = (e) => {
            this.composing = false;
            const text = String(e.data || this.host?.value || '');
            this.host.value = '';
            if (text) this.dispatchText(text);
        };
        this._onBeforeInput = (e) => {
            if (!this.isConnected() || this.composing) return;
            if (e.inputType === 'deleteContentBackward') {
                e.preventDefault();
                this.tapKey('Backspace');
            } else if (e.inputType === 'deleteContentForward') {
                e.preventDefault();
                this.tapKey('Delete');
            } else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
                e.preventDefault();
                this.tapKey('Enter');
            } else if (e.inputType === 'insertText' && e.data) {
                // Prefer beforeinput for non-composition inserts: more reliable
                // for CJK candidates committed as a unit on some Android IMEs.
                e.preventDefault();
                this.dispatchText(e.data);
                this.host.value = '';
            } else if (e.inputType === 'insertFromPaste' && e.dataTransfer) {
                const text = e.dataTransfer.getData('text/plain') || e.data || '';
                if (text) {
                    e.preventDefault();
                    this.dispatchText(text);
                    this.host.value = '';
                }
            }
        };
        this._onInput = (e) => {
            if (!this.isConnected() || this.composing) return;
            // Fallback when beforeinput is unavailable or ignored.
            const data = e.data;
            if (data) {
                this.dispatchText(data);
            }
            // Keep the host empty so the next IME session starts clean. Do not
            // truncate mid-composition — that path is gated by `composing`.
            if (this.host) this.host.value = '';
        };
        this._onKeyDown = (e) => {
            // Some mobile keyboards emit real keydown for Enter/Backspace
            // without a corresponding beforeinput.
            if (!this.isConnected() || this.composing) return;
            if (e.key === 'Backspace') {
                e.preventDefault();
                this.tapKey('Backspace');
            } else if (e.key === 'Enter') {
                e.preventDefault();
                this.tapKey('Enter');
            } else if (e.key === 'Tab') {
                e.preventDefault();
                this.tapKey('Tab');
            }
        };
        this.attach();
    }

    attach() {
        if (!this.host) return;
        this.button?.addEventListener('pointerdown', this._onPointerDown);
        this.button?.addEventListener('click', this._onClick);
        this.host.addEventListener('focus', this._onFocus);
        this.host.addEventListener('blur', this._onBlur);
        this.host.addEventListener('compositionstart', this._onCompositionStart);
        this.host.addEventListener('compositionend', this._onCompositionEnd);
        this.host.addEventListener('beforeinput', this._onBeforeInput);
        this.host.addEventListener('input', this._onInput);
        this.host.addEventListener('keydown', this._onKeyDown);
        this.host.value = '';
        this.setOpen(false);
    }

    destroy() {
        this.button?.removeEventListener('pointerdown', this._onPointerDown);
        this.button?.removeEventListener('click', this._onClick);
        if (!this.host) return;
        this.host.removeEventListener('focus', this._onFocus);
        this.host.removeEventListener('blur', this._onBlur);
        this.host.removeEventListener('compositionstart', this._onCompositionStart);
        this.host.removeEventListener('compositionend', this._onCompositionEnd);
        this.host.removeEventListener('beforeinput', this._onBeforeInput);
        this.host.removeEventListener('input', this._onInput);
        this.host.removeEventListener('keydown', this._onKeyDown);
        this.setOpen(false);
    }

    setOpen(open) {
        this.open = !!open;
        this.button?.classList.toggle('active', this.open);
        this.button?.classList.toggle('keyboard-visible', this.open);
        this.button?.setAttribute('aria-pressed', this.open ? 'true' : 'false');
        this.host?.classList.toggle('keyboard-open', this.open);
        document.documentElement.classList.toggle('rdp-keyboard-open', this.open);
        if (this.open) {
            try {
                this.host?.focus({ preventScroll: true });
            } catch {
                this.host?.focus();
            }
        } else if (document.activeElement === this.host) {
            this.host.blur();
        }
    }

    toggle() {
        const activeIsHost = document.activeElement === this.host;
        if (shouldToggleKeyboardClosed(this.open, activeIsHost)) {
            this.setOpen(false);
            return;
        }
        this.setOpen(true);
    }

    tapKey(code) {
        if (!this.isConnected() || !code) return;
        this.sendKeyDown?.(code);
        setTimeout(() => this.sendKeyUp?.(code), this.keyHoldMs);
    }

    tapKeyWithShift(code, shift) {
        if (!this.isConnected() || !code) return;
        if (!shift) {
            this.tapKey(code);
            return;
        }
        this.sendKeyDown?.('ShiftLeft');
        this.sendKeyDown?.(code);
        setTimeout(() => {
            this.sendKeyUp?.(code);
            this.sendKeyUp?.('ShiftLeft');
        }, this.keyHoldMs);
    }

    dispatchText(text) {
        if (!this.isConnected() || !text) return;
        const plans = planTextInput(text);
        for (const plan of plans) {
            if (plan.type === 'clipboard') {
                this.enqueueClipboard(plan.text);
            } else if (plan.type === 'keys') {
                for (const step of plan.steps) {
                    this.tapKeyWithShift(step.code, step.shift);
                }
            }
        }
    }

    enqueueClipboard(text) {
        if (!text) return;
        // Serialize pastes: rapid CJK commits must not interleave Ctrl+V.
        this._pasteQueue = this._pasteQueue
            .then(() => this.sendClipboardText?.(text))
            .catch((err) => console.warn('[rdp-mobile-keyboard] paste failed', err));
        return this._pasteQueue;
    }
}
