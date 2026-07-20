var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const NORMAL_KEYS = {
  ArrowUp: "\x1B[A",
  ArrowDown: "\x1B[B",
  ArrowRight: "\x1B[C",
  ArrowLeft: "\x1B[D",
  Home: "\x1B[H",
  End: "\x1B[F"
};
const APP_KEYS = {
  ArrowUp: "\x1BOA",
  ArrowDown: "\x1BOB",
  ArrowRight: "\x1BOC",
  ArrowLeft: "\x1BOD",
  Home: "\x1BOH",
  End: "\x1BOF"
};
const FIXED_KEYS = {
  Enter: "\r",
  Backspace: "\x7F",
  Tab: "	",
  Escape: "\x1B",
  Insert: "\x1B[2~",
  Delete: "\x1B[3~",
  PageUp: "\x1B[5~",
  PageDown: "\x1B[6~",
  F1: "\x1BOP",
  F2: "\x1BOQ",
  F3: "\x1BOR",
  F4: "\x1BOS",
  F5: "\x1B[15~",
  F6: "\x1B[17~",
  F7: "\x1B[18~",
  F8: "\x1B[19~",
  F9: "\x1B[20~",
  F10: "\x1B[21~",
  F11: "\x1B[23~",
  F12: "\x1B[24~"
};
const KITTY_PRIVATE = {
  CapsLock: 57358,
  ScrollLock: 57359,
  NumLock: 57360,
  PrintScreen: 57361,
  Pause: 57362,
  ContextMenu: 57363,
  F13: 57376,
  F14: 57377,
  F15: 57378,
  F16: 57379,
  F17: 57380,
  F18: 57381,
  F19: 57382,
  F20: 57383,
  F21: 57384,
  F22: 57385,
  F23: 57386,
  F24: 57387,
  F25: 57388,
  F26: 57389,
  F27: 57390,
  F28: 57391,
  F29: 57392,
  F30: 57393,
  F31: 57394,
  F32: 57395,
  F33: 57396,
  F34: 57397,
  F35: 57398,
  Numpad0: 57399,
  Numpad1: 57400,
  Numpad2: 57401,
  Numpad3: 57402,
  Numpad4: 57403,
  Numpad5: 57404,
  Numpad6: 57405,
  Numpad7: 57406,
  Numpad8: 57407,
  Numpad9: 57408,
  NumpadDecimal: 57409,
  NumpadDivide: 57410,
  NumpadMultiply: 57411,
  NumpadSubtract: 57412,
  NumpadAdd: 57413,
  NumpadEnter: 57414,
  NumpadEqual: 57415,
  NumpadSeparator: 57416,
  ShiftLeft: 57441,
  ControlLeft: 57442,
  AltLeft: 57443,
  MetaLeft: 57444,
  ShiftRight: 57447,
  ControlRight: 57448,
  AltRight: 57449,
  MetaRight: 57450
};
const KITTY_TILDE = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
const KITTY_FINAL = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F", F1: "P", F2: "Q", F3: "R", F4: "S" };
class InputHandler {
  constructor(element, onData, getBridge) {
    __publicField(this, "element");
    __publicField(this, "textarea");
    __publicField(this, "onData");
    __publicField(this, "getBridge");
    __publicField(this, "composing", false);
    __publicField(this, "_onKeyDown");
    __publicField(this, "_onKeyUp");
    __publicField(this, "_onPaste");
    __publicField(this, "_onCompositionStart");
    __publicField(this, "_onCompositionEnd");
    __publicField(this, "_onInput");
    __publicField(this, "_onFocus");
    __publicField(this, "_onBlur");
    // P2-3: Mouse reporting state
    __publicField(this, "_onMouseDown");
    __publicField(this, "_onMouseUp");
    __publicField(this, "_onMouseMove");
    __publicField(this, "_onMouseScroll");
    __publicField(this, "_onWindowFocus");
    __publicField(this, "_onWindowBlur");
    // P2-2: Selection state
    __publicField(this, "_clickCount", 0);
    __publicField(this, "_clickTimer", null);
    __publicField(this, "_lastClickTime", 0);
    __publicField(this, "_lastClickCol", -1);
    __publicField(this, "_lastClickRow", -1);
    __publicField(this, "_selectionStart", null);
    __publicField(this, "_selectionEnd", null);
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
    this._onKeyUp = this.handleKeyUp.bind(this);
    this._onPaste = this.handlePaste.bind(this);
    this._onCompositionStart = this.handleCompositionStart.bind(this);
    this._onCompositionEnd = this.handleCompositionEnd.bind(this);
    this._onInput = this.handleInput.bind(this);
    this._onFocus = () => this.element.classList.add("focused");
    this._onBlur = () => this.element.classList.remove("focused");
    this.textarea.addEventListener("keydown", this._onKeyDown);
    this.textarea.addEventListener("keyup", this._onKeyUp);
    this.textarea.addEventListener("paste", this._onPaste);
    this.textarea.addEventListener(
      "compositionstart",
      this._onCompositionStart
    );
    this.textarea.addEventListener(
      "compositionend",
      this._onCompositionEnd
    );
    this.textarea.addEventListener("input", this._onInput);
    this.textarea.addEventListener("focus", this._onFocus);
    this.textarea.addEventListener("blur", this._onBlur);
    this._onMouseDown = this.handleMouseDown.bind(this);
    this._onMouseUp = this.handleMouseUp.bind(this);
    this._onMouseMove = this.handleMouseMove.bind(this);
    this._onMouseScroll = this.handleMouseWheel.bind(this);
    this._onWindowFocus = () => {
      if (this.getBridge()?.focusReporting()) this.onData("\x1B[I");
    };
    this._onWindowBlur = () => {
      if (this.getBridge()?.focusReporting()) this.onData("\x1B[O");
    };
    this.element.addEventListener("mousedown", this._onMouseDown);
    this.element.addEventListener("mouseup", this._onMouseUp);
    this.element.addEventListener("mousemove", this._onMouseMove);
    this.element.addEventListener("wheel", this._onMouseScroll, { passive: false });
    window.addEventListener("focus", this._onWindowFocus);
    window.addEventListener("blur", this._onWindowBlur);
  }
  focus() {
    this.textarea.focus({ preventScroll: true });
  }
  mouseToCell(e) {
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
  sendMouseEvent(button, col, row, press) {
    const bridge = this.getBridge();
    if (!bridge || bridge.mouseMode() === 0) return;
    const c = Math.min(255, col + 1);
    const r = Math.min(255, row + 1);
    if (bridge.mouseSGR()) {
      this.onData(`\x1B[<${button};${c};${r}${press ? "M" : "m"}`);
    } else {
      const b = String.fromCharCode(button + 32);
      const cx = String.fromCharCode(Math.min(255, c + 31));
      const rx = String.fromCharCode(Math.min(255, r + 31));
      this.onData(`\x1B[M${b}${cx}${rx}`);
    }
  }
  // P2-2: Multi-click selection
  handleClickSelection(e) {
    const { col, row } = this.mouseToCell(e);
    const now = Date.now();
    if (this._clickTimer && now - this._lastClickTime < 400 && col === this._lastClickCol && row === this._lastClickRow) {
      this._clickCount++;
    } else {
      this._clickCount = 1;
    }
    this._lastClickTime = now;
    this._lastClickCol = col;
    this._lastClickRow = row;
    if (this._clickTimer) clearTimeout(this._clickTimer);
    this._clickTimer = setTimeout(() => {
      this._clickCount = 0;
    }, 400);
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
  _wordStart(row, col) {
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
  _wordEnd(row, col) {
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
  _isDelimiter(ch) {
    return ch >= 33 && ch <= 47 || ch >= 58 && ch <= 64 || ch >= 91 && ch <= 96 || ch >= 123 && ch <= 126;
  }
  _applySelection() {
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
    const startEl = rows[startIdx];
    const endEl = rows[endIdx];
    try {
      if (startEl === endEl) {
        range.selectNodeContents(startEl);
      } else {
        range.setStart(startEl, 0);
        range.setEnd(endEl, endEl.childNodes.length);
      }
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
    }
  }
  handleMouseDown(e) {
    const bridge = this.getBridge();
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
  handleMouseUp(e) {
    const bridge = this.getBridge();
    if (!bridge || bridge.mouseMode() === 0) return;
    e.preventDefault();
    const { col, row } = this.mouseToCell(e);
    const button = e.button === 2 ? 2 : e.button === 1 ? 1 : 0;
    this.sendMouseEvent(button, col, row, false);
  }
  handleMouseMove(e) {
    const bridge = this.getBridge();
    if (!bridge || bridge.mouseMode() < 2) return;
    const { col, row } = this.mouseToCell(e);
    if (col === this._lastClickCol && row === this._lastClickRow) return;
    this._lastClickCol = col;
    this._lastClickRow = row;
    const button = e.buttons > 0 ? Math.log2(e.buttons) | 0 : 3;
    this.sendMouseEvent(button, col, row, true);
  }
  handleMouseWheel(e) {
    const bridge = this.getBridge?.() || null;
    const mode = bridge?.mouseMode?.() ?? 0;
    if (bridge && mode === 0 && bridge.mouseAltScroll?.() && bridge.usingAltScreen?.()) {
      e.preventDefault();
      const steps = Math.max(1, Math.min(5, Math.round(Math.abs(e.deltaY) / 40) || 1));
      const seq = e.deltaY < 0 ? "\x1BOA" : "\x1BOB";
      for (let i = 0; i < steps; i++) this.onData(seq);
      return;
    }
    if (!bridge || mode === 0) return;
    e.preventDefault();
    const { col, row } = this.mouseToCell(e);
    const button = e.deltaY < 0 ? 64 : 65;
    this.sendMouseEvent(button, col, row, true);
  }
  destroy() {
    this.textarea.removeEventListener("keydown", this._onKeyDown);
    this.textarea.removeEventListener("keyup", this._onKeyUp);
    this.textarea.removeEventListener("paste", this._onPaste);
    this.textarea.removeEventListener(
      "compositionstart",
      this._onCompositionStart
    );
    this.textarea.removeEventListener(
      "compositionend",
      this._onCompositionEnd
    );
    this.textarea.removeEventListener("input", this._onInput);
    this.textarea.removeEventListener("focus", this._onFocus);
    this.textarea.removeEventListener("blur", this._onBlur);
    this.element.classList.remove("focused");
    this.element.removeEventListener("mousedown", this._onMouseDown);
    this.element.removeEventListener("mouseup", this._onMouseUp);
    this.element.removeEventListener("mousemove", this._onMouseMove);
    this.element.removeEventListener("wheel", this._onMouseScroll);
    window.removeEventListener("focus", this._onWindowFocus);
    window.removeEventListener("blur", this._onWindowBlur);
    this.textarea.remove();
  }
  handleKeyUp(e) {
    const flags = this.getBridge()?.kittyKeyboardFlags() || 0;
    if ((flags & 2) === 0) return;
    const seq = this.kittySequence(e, 3, flags);
    if (seq !== null) {
      e.preventDefault();
      e.stopPropagation();
      this.onData(seq);
    }
  }
  handleKeyDown(e) {
    if (this.composing) return;
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
        this.onData("");
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
    const seq = this.keyToSequence(e, e.repeat ? 2 : 1);
    if (seq) this.onData(seq);
  }
  handlePaste(e) {
    e.preventDefault();
    const text = e.clipboardData?.getData("text");
    if (!text) return;
    const bridge = this.getBridge();
    if (bridge && bridge.bracketedPaste()) {
      const safe = text.replace(/\x1b/g, "");
      this.onData("\x1B[200~" + safe + "\x1B[201~");
    } else {
      this.onData(text);
    }
  }
  handleCompositionStart() {
    this.composing = true;
  }
  handleCompositionEnd(e) {
    this.composing = false;
    e.preventDefault();
    if (e.data) this.onData(e.data);
    requestAnimationFrame(() => {
      this.textarea.value = "";
    });
  }
  handleInput() {
    if (this.composing) return;
    const value = this.textarea.value;
    if (value) {
      this.onData(value);
      this.textarea.value = "";
    }
  }
  kittySequence(e, eventType, flags) {
    if (!flags) return null;
    const mods = 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0) + (e.metaKey ? 8 : 0) + (e.getModifierState("CapsLock") ? 64 : 0) + (e.getModifierState("NumLock") ? 128 : 0);
    const event = flags & 2 ? `:${eventType}` : "";
    const text = flags & 16 && eventType !== 3 && e.key.length === 1 ? `;${[...e.key].map((ch) => ch.codePointAt(0)).join(":")}` : "";
    const suffix = `${mods}${event}${text}`;
    const privateCode = KITTY_PRIVATE[e.code] || KITTY_PRIVATE[e.key];
    if (privateCode) return `\x1B[${privateCode};${suffix}u`;
    const final = KITTY_FINAL[e.key];
    if (final) return `\x1B[1;${suffix}${final}`;
    const tilde = KITTY_TILDE[e.key];
    if (tilde) return `\x1B[${tilde};${suffix}~`;
    const simple = { Escape: 27, Enter: 13, Tab: 9, Backspace: 127 };
    if (simple[e.key] !== void 0 && (flags & 9 || mods > 1 || eventType === 3)) return `\x1B[${simple[e.key]};${suffix}u`;
    if (e.key.length === 1) {
      if ((flags & 8) === 0 && mods === 1 && eventType !== 3) return e.key;
      const main = e.key.codePointAt(0);
      let keyField = String(main);
      if (flags & 4) {
        let base = main;
        if (/^Key[A-Z]$/.test(e.code)) base = e.code.charCodeAt(3) + 32;
        else if (/^Digit[0-9]$/.test(e.code)) base = e.code.charCodeAt(5);
        keyField += `:${main}:${base}`;
      }
      return `\x1B[${keyField};${suffix}u`;
    }
    return null;
  }
  keyToSequence(e, eventType = 1) {
    const kittyFlags = this.getBridge()?.kittyKeyboardFlags() || 0;
    const kitty = this.kittySequence(e, eventType, kittyFlags);
    if (kitty !== null) return kitty;
    const mods = (e.shiftKey ? 1 : 0) | (e.altKey ? 2 : 0) | (e.ctrlKey ? 4 : 0) | (e.metaKey ? 8 : 0);
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.key.length === 1) {
        const code = e.key.toLowerCase().charCodeAt(0);
        if (code >= 97 && code <= 122) {
          if (e.shiftKey) return `\x1B[${code - 96 + 64};${mods + 1}u`;
          return String.fromCharCode(code - 96);
        }
      }
      if (e.key === "[") return "\x1B";
      if (e.key === "\\") return "";
      if (e.key === "]") return "";
      if (e.key === "^") return "";
      if (e.key === "_") return "";
    }
    if (e.key === "Enter") {
      if (mods > 0) return `\x1B[13;${mods + 1}u`;
      return "\r";
    }
    if (e.key === "Tab") {
      if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) return "\x1B[Z";
      if (mods > 0) return `\x1B[9;${mods + 1}u`;
      return "	";
    }
    const fixed = FIXED_KEYS[e.key];
    if (fixed) {
      if (mods > 0 && !e.altKey) {
        const code = e.key === "Escape" ? 27 : 0;
        if (code) return `\x1B[${code};${mods + 1}u`;
      }
      return e.altKey ? "\x1B" + fixed : fixed;
    }
    const bridge = this.getBridge();
    const appMode = bridge && bridge.cursorKeysApp();
    const navMap = appMode ? APP_KEYS : NORMAL_KEYS;
    const nav = navMap[e.key];
    if (nav) {
      const navCodes = {
        ArrowUp: 65,
        ArrowDown: 66,
        ArrowRight: 67,
        ArrowLeft: 68,
        Home: 72,
        End: 70
      };
      const code = navCodes[e.key];
      if (code && mods > 1) {
        return `\x1B[${code};${mods + 1}u`;
      }
      return e.altKey ? "\x1B" + nav : nav;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      return e.altKey ? "\x1B" + e.key : e.key;
    }
    const keypad = this.getBridge()?.keypadApp?.();
    if (keypad) {
      const map = {
        Numpad0: "\x1BOp",
        Numpad1: "\x1BOq",
        Numpad2: "\x1BOr",
        Numpad3: "\x1BOs",
        Numpad4: "\x1BOt",
        Numpad5: "\x1BOu",
        Numpad6: "\x1BOv",
        Numpad7: "\x1BOw",
        Numpad8: "\x1BOx",
        Numpad9: "\x1BOy",
        NumpadAdd: "\x1BOk",
        NumpadSubtract: "\x1BOm",
        NumpadMultiply: "\x1BOj",
        NumpadDivide: "\x1BOo",
        NumpadDecimal: "\x1BOn",
        NumpadEnter: "\x1BOM"
      };
      if (map[e.code]) return map[e.code];
    }
    return null;
  }
}
export {
  InputHandler
};
