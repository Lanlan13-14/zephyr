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
class InputHandler {
  constructor(element, onData, getBridge) {
    __publicField(this, "element");
    __publicField(this, "textarea");
    __publicField(this, "onData");
    __publicField(this, "getBridge");
    __publicField(this, "composing", false);
    __publicField(this, "_onKeyDown");
    __publicField(this, "_onPaste");
    __publicField(this, "_onCompositionStart");
    __publicField(this, "_onCompositionEnd");
    __publicField(this, "_onInput");
    __publicField(this, "_onFocus");
    __publicField(this, "_onBlur");
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
  }
  focus() {
    this.textarea.focus({ preventScroll: true });
  }
  destroy() {
    this.textarea.removeEventListener("keydown", this._onKeyDown);
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
    this.textarea.remove();
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
    const seq = this.keyToSequence(e);
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
  keyToSequence(e) {
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
    return null;
  }
}
export {
  InputHandler
};
