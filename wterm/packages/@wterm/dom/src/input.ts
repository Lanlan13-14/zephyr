import type { TerminalCore } from "@wterm/core";

const NORMAL_KEYS: Record<string, string> = {
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
};

const APP_KEYS: Record<string, string> = {
  ArrowUp: "\x1bOA",
  ArrowDown: "\x1bOB",
  ArrowRight: "\x1bOC",
  ArrowLeft: "\x1bOD",
  Home: "\x1bOH",
  End: "\x1bOF",
};

const FIXED_KEYS: Record<string, string> = {
  Enter: "\r",
  Backspace: "\x7f",
  Tab: "\t",
  Escape: "\x1b",
  Insert: "\x1b[2~",
  Delete: "\x1b[3~",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  F1: "\x1bOP",
  F2: "\x1bOQ",
  F3: "\x1bOR",
  F4: "\x1bOS",
  F5: "\x1b[15~",
  F6: "\x1b[17~",
  F7: "\x1b[18~",
  F8: "\x1b[19~",
  F9: "\x1b[20~",
  F10: "\x1b[21~",
  F11: "\x1b[23~",
  F12: "\x1b[24~",
};

export class InputHandler {
  private element: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private onData: (data: string) => void;
  private getBridge: () => TerminalCore | null;
  private composing = false;

  private _onKeyDown: (e: KeyboardEvent) => void;
  private _onPaste: (e: ClipboardEvent) => void;
  private _onCompositionStart: () => void;
  private _onCompositionEnd: (e: CompositionEvent) => void;
  private _onInput: () => void;
  private _onFocus: () => void;
  private _onBlur: () => void;

  constructor(
    element: HTMLElement,
    onData: (data: string) => void,
    getBridge: () => TerminalCore | null,
  ) {
    this.element = element;
    this.onData = onData;
    this.getBridge = getBridge;

    this.textarea = document.createElement("textarea");
    this.textarea.setAttribute("autocapitalize", "off");
    this.textarea.setAttribute("autocomplete", "off");
    this.textarea.setAttribute("autocorrect", "off");
    this.textarea.setAttribute("spellcheck", "false");
    this.textarea.setAttribute("enterkeyhint", "send");
    this.textarea.setAttribute("tabindex", "0");
    this.textarea.setAttribute("aria-hidden", "true");
    const s = this.textarea.style;
    s.position = "absolute";
    s.left = "-9999px";
    s.top = "0";
    s.width = "1px";
    s.height = "1px";
    s.opacity = "0";
    s.overflow = "hidden";
    s.border = "0";
    s.padding = "0";
    s.margin = "0";
    s.outline = "none";
    s.resize = "none";
    s.pointerEvents = "none";
    s.caretColor = "transparent";
    s.color = "transparent";
    s.background = "transparent";
    element.appendChild(this.textarea);

    this._onKeyDown = this.handleKeyDown.bind(this);
    this._onPaste = this.handlePaste.bind(this);
    this._onCompositionStart = this.handleCompositionStart.bind(this);
    this._onCompositionEnd = this.handleCompositionEnd.bind(this);
    this._onInput = this.handleInput.bind(this);
    this._onFocus = () => this.element.classList.add("focused");
    this._onBlur = () => this.element.classList.remove("focused");

    this.textarea.addEventListener("keydown", this._onKeyDown);
    this.textarea.addEventListener("paste", this._onPaste as EventListener);
    this.textarea.addEventListener(
      "compositionstart",
      this._onCompositionStart,
    );
    this.textarea.addEventListener(
      "compositionend",
      this._onCompositionEnd as EventListener,
    );
    this.textarea.addEventListener("input", this._onInput);
    this.textarea.addEventListener("focus", this._onFocus);
    this.textarea.addEventListener("blur", this._onBlur);
  }

  focus(): void {
    this.textarea.focus({ preventScroll: true });
  }

  destroy(): void {
    this.textarea.removeEventListener("keydown", this._onKeyDown);
    this.textarea.removeEventListener("paste", this._onPaste as EventListener);
    this.textarea.removeEventListener(
      "compositionstart",
      this._onCompositionStart,
    );
    this.textarea.removeEventListener(
      "compositionend",
      this._onCompositionEnd as EventListener,
    );
    this.textarea.removeEventListener("input", this._onInput);
    this.textarea.removeEventListener("focus", this._onFocus);
    this.textarea.removeEventListener("blur", this._onBlur);
    this.element.classList.remove("focused");
    this.textarea.remove();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (this.composing) return;

    // P1-3: AltGr (AltGraph) produces printable characters on European
    // keyboards (e.g. AltGr+Q = @ on German layout). Let the browser handle
    // these so the composed character reaches the terminal via input event.
    if (e.altKey && e.ctrlKey && e.key.length === 1 && e.key >= " ") {
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "c") {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "v") {
      this.textarea.focus();
      return;
    }
    if (e.metaKey && !e.ctrlKey) {
      if (e.key === "Backspace") {
        e.preventDefault();
        this.onData("\x15");
      } else if (e.key === "a") {
        e.preventDefault();
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(this.element);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
      return;
    }

    e.preventDefault();
    const seq = this.keyToSequence(e);
    if (seq) this.onData(seq);
  }

  private handlePaste(e: ClipboardEvent): void {
    e.preventDefault();
    const text = e.clipboardData?.getData("text");
    if (!text) return;

    const bridge = this.getBridge();
    if (bridge && bridge.bracketedPaste()) {
      // Strip ESC bytes so clipboard payloads cannot inject \x1b[201~ to
      // break out of bracketed paste mode and smuggle commands to the PTY.
      const safe = text.replace(/\x1b/g, "");
      this.onData("\x1b[200~" + safe + "\x1b[201~");
    } else {
      this.onData(text);
    }
  }

  private handleCompositionStart(): void {
    this.composing = true;
  }

  private handleCompositionEnd(e: CompositionEvent): void {
    this.composing = false;
    // preventDefault: some Android IMEs fire a stray input event after
    // compositionend that would re-send the composed text via handleInput.
    e.preventDefault();
    if (e.data) this.onData(e.data);
    // Defer clearing the textarea to the next frame. Clearing synchronously
    // can race with the browser composition cleanup on some IMEs and cause
    // a spurious input event with partial text.
    requestAnimationFrame(() => {
      this.textarea.value = "";
    });
  }

  private handleInput(): void {
    if (this.composing) return;
    const value = this.textarea.value;
    if (value) {
      this.onData(value);
      this.textarea.value = "";
    }
  }

  private keyToSequence(e: KeyboardEvent): string | null {
    // P1-3: Build a modifier bitmask for CSI-u style encoding.
    // Bit 1=Shift, 2=Alt, 4=Control, 8=Meta (per Kitty/CSI-u spec).
    const mods =
      (e.shiftKey ? 1 : 0) | (e.altKey ? 2 : 0) |
      (e.ctrlKey ? 4 : 0) | (e.metaKey ? 8 : 0);

    // Ctrl + letter (no Alt/Meta): classic control codes a-z -> 0x01-0x1A
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.key.length === 1) {
        const code = e.key.toLowerCase().charCodeAt(0);
        if (code >= 97 && code <= 122) {
          // Ctrl+Shift+letter: uppercase variant via CSI-u (code + 64, mods=1)
          if (e.shiftKey) return `\x1b[${code - 96 + 64};${mods + 1}u`;
          return String.fromCharCode(code - 96);
        }
      }
      if (e.key === "[") return "\x1b";
      if (e.key === "\\") return "\x1c";
      if (e.key === "]") return "\x1d";
      if (e.key === "^") return "\x1e";
      if (e.key === "_") return "\x1f";
    }

    // Enter and Tab with modifiers: use CSI-u encoding for modifier combos.
    // Plain Enter/Tab/Shift+Tab are handled by FIXED_KEYS below.
    if (e.key === "Enter") {
      if (mods > 0) return `\x1b[13;${mods + 1}u`;
      return "\r";
    }
    if (e.key === "Tab") {
      if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) return "\x1b[Z";
      if (mods > 0) return `\x1b[9;${mods + 1}u`;
      return "\t";
    }

    const fixed = FIXED_KEYS[e.key];
    if (fixed) {
      // Modifier + function/navigation keys: CSI-u with modifier param
      if (mods > 0 && !e.altKey) {
        // Only encode non-Alt modifiers via CSI-u; Alt prefix is traditional
        const code = e.key === "Escape" ? 27 : 0;
        if (code) return `\x1b[${code};${mods + 1}u`;
      }
      return e.altKey ? "\x1b" + fixed : fixed;
    }

    const bridge = this.getBridge();
    const appMode = bridge && bridge.cursorKeysApp();
    const navMap = appMode ? APP_KEYS : NORMAL_KEYS;
    const nav = navMap[e.key];
    if (nav) {
      // Navigation keys with Ctrl/Meta: CSI-u encoding
      const navCodes: Record<string, number> = {
        ArrowUp: 65, ArrowDown: 66, ArrowRight: 67, ArrowLeft: 68,
        Home: 72, End: 70,
      };
      const code = navCodes[e.key];
      if (code && mods > 1) {
        return `\x1b[${code};${mods + 1}u`;
      }
      return e.altKey ? "\x1b" + nav : nav;
    }

    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      return e.altKey ? "\x1b" + e.key : e.key;
    }

    return null;
  }
}
