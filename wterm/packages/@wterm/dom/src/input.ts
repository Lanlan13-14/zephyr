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

    // P2-3: Mouse reporting on the terminal element.
    this._onMouseDown = this.handleMouseDown.bind(this);
    this._onMouseUp = this.handleMouseUp.bind(this);
    this._onMouseMove = this.handleMouseMove.bind(this);
    this._onMouseScroll = this.handleMouseWheel.bind(this);
    this.element.addEventListener("mousedown", this._onMouseDown);
    this.element.addEventListener("mouseup", this._onMouseUp);
    this.element.addEventListener("mousemove", this._onMouseMove);
    this.element.addEventListener("wheel", this._onMouseScroll, { passive: false });
  }

  focus(): void {
    this.textarea.focus({ preventScroll: true });
  }

  // P2-3: Mouse reporting state
  private _onMouseDown: (e: MouseEvent) => void;
  private _onMouseUp: (e: MouseEvent) => void;
  private _onMouseMove: (e: MouseEvent) => void;
  private _onMouseScroll: (e: WheelEvent) => void;

  // P2-2: Selection state
  private _clickCount = 0;
  private _clickTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastClickTime = 0;
  private _lastClickCol = -1;
  private _lastClickRow = -1;
  private _selectionStart: { row: number; col: number } | null = null;
  private _selectionEnd: { row: number; col: number } | null = null;

  private mouseToCell(e: MouseEvent): { col: number; row: number } {
    const rect = this.element.getBoundingClientRect();
    const cs = getComputedStyle(this.element);
    const fontSize = parseFloat(cs.fontSize) || 14;
    const lineHeight = parseFloat(cs.lineHeight) || fontSize * 1.2;
    const padding = parseFloat(cs.paddingLeft) || 0;
    const paddingTop = parseFloat(cs.paddingTop) || 0;
    const col = Math.floor((e.clientX - rect.left - padding) / fontSize);
    const row = Math.floor((e.clientY - rect.top - paddingTop) / lineHeight);
    return { col: Math.max(0, col), row: Math.max(0, row) };
  }

  private sendMouseEvent(button: number, col: number, row: number, press: boolean): void {
    const bridge = this.getBridge();
    if (!bridge || bridge.mouseMode() === 0) return;
    const c = Math.min(255, col + 1);
    const r = Math.min(255, row + 1);
    if (bridge.mouseSGR()) {
      this.onData(`\x1b[<${button};${c};${r}${press ? "M" : "m"}`);
    } else {
      const b = String.fromCharCode(button + 32);
      const cx = String.fromCharCode(Math.min(255, c + 31));
      const rx = String.fromCharCode(Math.min(255, r + 31));
      this.onData(`\x1b[M${b}${cx}${rx}`);
    }
  }

  // P2-2: Multi-click selection
  private handleClickSelection(e: MouseEvent): void {
    const { col, row } = this.mouseToCell(e);
    const now = Date.now();
    if (this._clickTimer && now - this._lastClickTime < 400 &&
        col === this._lastClickCol && row === this._lastClickRow) {
      this._clickCount++;
    } else {
      this._clickCount = 1;
    }
    this._lastClickTime = now;
    this._lastClickCol = col;
    this._lastClickRow = row;
    if (this._clickTimer) clearTimeout(this._clickTimer);
    this._clickTimer = setTimeout(() => { this._clickCount = 0; }, 400);

    if (e.shiftKey && this._selectionStart) {
      this._selectionEnd = { row, col };
      this._applySelection();
      e.preventDefault();
      return;
    }
    if (this._clickCount === 2) {
      this._selectionStart = { row, col: this._wordStart(row, col) };
      this._selectionEnd = { row, col: this._wordEnd(row, col) };
      this._applySelection();
      e.preventDefault();
    } else if (this._clickCount >= 3) {
      const bridge = this.getBridge();
      const cols = bridge ? bridge.getCols() : 80;
      this._selectionStart = { row, col: 0 };
      this._selectionEnd = { row, col: cols };
      this._applySelection();
      e.preventDefault();
    } else {
      this._selectionStart = { row, col };
      this._selectionEnd = null;
    }
  }

  private _wordStart(row: number, col: number): number {
    const bridge = this.getBridge();
    if (!bridge) return col;
    let c = col;
    while (c > 0) {
      const ch = bridge.getCell(row, c - 1).char;
      if (ch < 33 || this._isDelimiter(ch)) break;
      c--;
    }
    return c;
  }

  private _wordEnd(row: number, col: number): number {
    const bridge = this.getBridge();
    if (!bridge) return col + 1;
    const cols = bridge.getCols();
    let c = col;
    while (c < cols - 1) {
      const ch = bridge.getCell(row, c + 1).char;
      if (ch < 33 || this._isDelimiter(ch)) break;
      c++;
    }
    return c + 1;
  }

  private _isDelimiter(ch: number): boolean {
    return (ch >= 33 && ch <= 47) || (ch >= 58 && ch <= 64) ||
           (ch >= 91 && ch <= 96) || (ch >= 123 && ch <= 126);
  }

  private _applySelection(): void {
    if (!this._selectionStart) return;
    const end = this._selectionEnd || this._selectionStart;
    const rows = this.element.querySelectorAll(".term-row, .term-scrollback-row");
    const bridge = this.getBridge();
    const gridRows = bridge ? bridge.getRows() : 24;
    const sbCount = Math.max(0, rows.length - gridRows);
    const startIdx = this._selectionStart.row + sbCount;
    const endIdx = end.row + sbCount;
    if (startIdx >= rows.length || endIdx >= rows.length) return;
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    const startEl = rows[startIdx] as HTMLElement;
    const endEl = rows[endIdx] as HTMLElement;
    try {
      if (startEl === endEl) {
        range.selectNodeContents(startEl);
      } else {
        range.setStart(startEl, 0);
        range.setEnd(endEl, endEl.childNodes.length);
      }
      sel.removeAllRanges();
      sel.addRange(range);
    } catch { /* best-effort */ }
  }

  private handleMouseDown(e: MouseEvent): void {
    const bridge = this.getBridge();
    // P2-2: Handle selection when mouse reporting is off or Shift is held
    if (!bridge || bridge.mouseMode() === 0 || e.shiftKey) {
      this.handleClickSelection(e);
    }
    if (!bridge || bridge.mouseMode() === 0) return;
    e.preventDefault();
    const { col, row } = this.mouseToCell(e);
    this._lastClickCol = col;
    this._lastClickRow = row;
    const button = e.button === 2 ? 2 : e.button === 1 ? 1 : 0;
    this.sendMouseEvent(button, col, row, true);
  }

  private handleMouseUp(e: MouseEvent): void {
    const bridge = this.getBridge();
    if (!bridge || bridge.mouseMode() === 0) return;
    e.preventDefault();
    const { col, row } = this.mouseToCell(e);
    const button = e.button === 2 ? 2 : e.button === 1 ? 1 : 0;
    this.sendMouseEvent(button, col, row, false);
  }

  private handleMouseMove(e: MouseEvent): void {
    const bridge = this.getBridge();
    if (!bridge || bridge.mouseMode() < 2) return;
    const { col, row } = this.mouseToCell(e);
    if (col === this._lastClickCol && row === this._lastClickRow) return;
    this._lastClickCol = col;
    this._lastClickRow = row;
    const button = e.buttons > 0 ? Math.log2(e.buttons) | 0 : 3;
    this.sendMouseEvent(button, col, row, true);
  }

  private handleMouseWheel(e: WheelEvent): void {
    const bridge = this.getBridge();
    if (!bridge || bridge.mouseMode() === 0) return;
    e.preventDefault();
    const { col, row } = this.mouseToCell(e);
    const button = e.deltaY < 0 ? 64 : 65;
    this.sendMouseEvent(button, col, row, true);
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
    this.element.removeEventListener("mousedown", this._onMouseDown);
    this.element.removeEventListener("mouseup", this._onMouseUp);
    this.element.removeEventListener("mousemove", this._onMouseMove);
    this.element.removeEventListener("wheel", this._onMouseScroll);
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
