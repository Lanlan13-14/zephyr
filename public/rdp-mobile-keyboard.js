/**
 * Mobile soft-keyboard helpers for the RDP WASM client.
 *
 * The page keeps a 1px textarea as an IME host. Committed text is sent through
 * native RDP Unicode keyboard events, while editing/control keys continue to
 * use scancodes. Clipboard paste is retained only as an explicit-paste path
 * and as a compatibility fallback.
 */

export function isAsciiPrintable(text) {
    if (!text) return false;
    for (const ch of text) {
        const c = ch.charCodeAt(0);
        if (c < 0x20 || c > 0x7e) return false;
    }
    return true;
}

/** Map one committed character to an RDP input plan. */
export function planCharInput(char) {
    if (!char) return null;
    if (char === '\n' || char === '\r') return { type: 'keys', steps: [{ code: 'Enter', shift: false }] };
    if (char === '\t') return { type: 'keys', steps: [{ code: 'Tab', shift: false }] };
    if (char === '\b') return { type: 'keys', steps: [{ code: 'Backspace', shift: false }] };
    if (char === '\x7f') return { type: 'keys', steps: [{ code: 'Delete', shift: false }] };
    return { type: 'unicode', text: char };
}

/** Group adjacent text into one native Unicode event batch. */
export function planTextInput(text) {
    if (!text) return [];
    const plans = [];
    let unicode = '';
    const flushUnicode = () => {
        if (!unicode) return;
        plans.push({ type: 'unicode', text: unicode });
        unicode = '';
    };
    const chars = [...String(text)];
    for (let index = 0; index < chars.length; index++) {
        const ch = chars[index];
        const plan = planCharInput(ch);
        if (!plan) continue;
        if (plan.type === 'unicode') {
            unicode += plan.text;
            continue;
        }
        flushUnicode();
        plans.push(plan);
        if (ch === '\r' && chars[index + 1] === '\n') index++;
    }
    flushUnicode();
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
        sendUnicodeText,
        sendClipboardText,
        keyHoldMs = 30,
    } = {}) {
        this.host = host;
        this.button = button;
        this.isConnected = isConnected;
        this.sendKeyDown = sendKeyDown;
        this.sendKeyUp = sendKeyUp;
        this.sendUnicodeText = sendUnicodeText;
        this.sendClipboardText = sendClipboardText;
        this.keyHoldMs = keyHoldMs;
        this.open = false;
        this.composing = false;
        this._inputQueue = Promise.resolve();
        this._compositionEcho = null;
        this._controlEcho = null;
        this._onPointerDown = (event) => {
            // Keep the host's focus decision under our control. Without this,
            // a second tap focuses the button and dismisses the OS keyboard.
            event.preventDefault();
        };
        this._onClick = (event) => {
            event.preventDefault();
            this.toggle();
        };
        this._onFocus = () => this.setOpen(true);
        this._onBlur = () => {
            setTimeout(() => {
                if (this._document()?.activeElement !== this.host) this.setOpen(false);
            }, 0);
        };
        this._onCompositionStart = () => {
            this.composing = true;
            this._compositionEcho = null;
        };
        this._onCompositionEnd = (event) => {
            this.composing = false;
            const text = String(event.data || this.host?.value || '');
            if (this.host) this.host.value = '';
            if (text) {
                // Chromium/WebKit commonly emit an input/beforeinput echo after
                // compositionend. Consume exactly one matching echo shortly
                // afterwards so a committed candidate is never duplicated.
                this._compositionEcho = { text, expiresAt: Date.now() + 150 };
                this.dispatchText(text);
            }
        };
        this._onBeforeInput = (event) => {
            if (!this.isConnected() || this.composing || event.isComposing) return;
            if (event.inputType === 'deleteContentBackward') {
                event.preventDefault();
                if (!this._consumeControlEcho('Backspace')) this.tapKey('Backspace');
            } else if (event.inputType === 'deleteContentForward') {
                event.preventDefault();
                if (!this._consumeControlEcho('Delete')) this.tapKey('Delete');
            } else if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
                event.preventDefault();
                if (!this._consumeControlEcho('Enter')) this.tapKey('Enter');
            } else if (event.inputType === 'insertText' && event.data) {
                event.preventDefault();
                if (!this._consumeCompositionEcho(String(event.data))) this.dispatchText(event.data);
                if (this.host) this.host.value = '';
            } else if (event.inputType === 'insertFromPaste') {
                const text = event.dataTransfer?.getData?.('text/plain') || event.data || '';
                if (text) {
                    event.preventDefault();
                    this.enqueueClipboard(text);
                    if (this.host) this.host.value = '';
                }
            }
        };
        this._onInput = (event) => {
            if (!this.isConnected() || this.composing || event.isComposing) return;
            // Fallback for engines that do not expose a cancellable beforeinput.
            const data = event.data || this.host?.value || '';
            if (data && !this._consumeCompositionEcho(String(data))) this.dispatchText(data);
            if (this.host) this.host.value = '';
        };
        this._onKeyDown = (event) => {
            // Some mobile keyboards emit a real keydown before beforeinput.
            // Remember it briefly so the following edit event is only acked.
            if (!this.isConnected() || this.composing || event.isComposing) return;
            const code = event.key === 'Backspace' ? 'Backspace'
                : event.key === 'Delete' ? 'Delete'
                    : event.key === 'Enter' ? 'Enter'
                        : event.key === 'Tab' ? 'Tab' : '';
            if (!code) return;
            event.preventDefault();
            this._controlEcho = { code, expiresAt: Date.now() + 100 };
            this.tapKey(code);
        };
        this.attach();
    }

    _document() {
        return this.host?.ownerDocument || globalThis.document;
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
        this._document()?.documentElement?.classList.toggle('rdp-keyboard-open', this.open);
        if (this.open) {
            try {
                this.host?.focus({ preventScroll: true });
            } catch {
                this.host?.focus();
            }
        } else if (this._document()?.activeElement === this.host) {
            this.host.blur();
        }
    }

    toggle() {
        const activeIsHost = this._document()?.activeElement === this.host;
        if (shouldToggleKeyboardClosed(this.open, activeIsHost)) {
            this.setOpen(false);
            return;
        }
        this.setOpen(true);
    }

    tapKey(code) {
        if (!code) return Promise.resolve(false);
        return this._enqueueInput(() => this._sendKey(code, false));
    }

    tapKeyWithShift(code, shift) {
        if (!code) return Promise.resolve(false);
        return this._enqueueInput(() => this._sendKey(code, !!shift));
    }

    dispatchText(text) {
        if (!text) return Promise.resolve(false);
        const plans = planTextInput(text);
        return this._enqueueInput(async () => {
            for (const plan of plans) {
                if (plan.type === 'unicode') {
                    let sent = false;
                    if (typeof this.sendUnicodeText === 'function') {
                        try {
                            sent = (await this.sendUnicodeText(plan.text)) !== false;
                        } catch (error) {
                            console.warn('[rdp-mobile-keyboard] unicode input failed; falling back to clipboard', error);
                        }
                    }
                    if (!sent) await this.sendClipboardText?.(plan.text);
                } else if (plan.type === 'keys') {
                    for (const step of plan.steps) await this._sendKey(step.code, !!step.shift);
                }
            }
            return true;
        });
    }

    enqueueClipboard(text) {
        if (!text) return Promise.resolve(false);
        return this._enqueueInput(() => this.sendClipboardText?.(text));
    }

    _enqueueInput(action) {
        this._inputQueue = this._inputQueue
            .catch(() => {})
            .then(async () => {
                if (!this.isConnected()) return false;
                return await action();
            })
            .catch((error) => {
                console.warn('[rdp-mobile-keyboard] input failed', error);
                return false;
            });
        return this._inputQueue;
    }

    async _sendKey(code, shift) {
        if (shift) this.sendKeyDown?.('ShiftLeft');
        this.sendKeyDown?.(code);
        await new Promise((resolve) => setTimeout(resolve, this.keyHoldMs));
        this.sendKeyUp?.(code);
        if (shift) this.sendKeyUp?.('ShiftLeft');
        return true;
    }

    _consumeCompositionEcho(text) {
        const echo = this._compositionEcho;
        if (!echo) return false;
        if (Date.now() > echo.expiresAt) {
            this._compositionEcho = null;
            return false;
        }
        if (String(text) !== echo.text) return false;
        this._compositionEcho = null;
        return true;
    }

    _consumeControlEcho(code) {
        const echo = this._controlEcho;
        if (!echo) return false;
        if (Date.now() > echo.expiresAt) {
            this._controlEcho = null;
            return false;
        }
        if (code !== echo.code) return false;
        this._controlEcho = null;
        return true;
    }
}
