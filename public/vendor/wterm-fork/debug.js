var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const FLAG_NAMES = {
  1: "bold",
  2: "dim",
  4: "italic",
  8: "underline",
  16: "blink",
  32: "reverse",
  64: "invisible",
  128: "strikethrough"
};
function flagsToNames(flags) {
  const names = [];
  for (const [bit, name] of Object.entries(FLAG_NAMES)) {
    if (flags & Number(bit)) names.push(name);
  }
  return names;
}
const ESC = 27;
function scanSequences(data) {
  const entries = [];
  const ts = Date.now();
  let i = 0;
  let textStart = 0;
  const flushText = () => {
    if (i > textStart) {
      const raw = data.slice(textStart, i);
      if (raw.length > 0 && !/^[\x00-\x1f]+$/.test(raw)) {
        entries.push({ ts, type: "text", raw: raw.slice(0, 60) });
      }
    }
  };
  while (i < data.length) {
    if (data.charCodeAt(i) !== ESC) {
      i++;
      continue;
    }
    flushText();
    const seqStart = i;
    i++;
    if (i >= data.length) break;
    const next = data[i];
    if (next === "[") {
      i++;
      let priv = "";
      if (i < data.length && (data[i] === "?" || data[i] === ">" || data[i] === "!")) {
        priv = data[i];
        i++;
      }
      let paramStr = "";
      while (i < data.length && (data.charCodeAt(i) >= 48 && data.charCodeAt(i) <= 59 || data[i] === ":")) {
        paramStr += data[i];
        i++;
      }
      while (i < data.length && data.charCodeAt(i) >= 32 && data.charCodeAt(i) <= 47) {
        i++;
      }
      let final = "";
      if (i < data.length && data.charCodeAt(i) >= 64 && data.charCodeAt(i) <= 126) {
        final = data[i];
        i++;
      }
      const raw = data.slice(seqStart, i);
      const params = paramStr ? paramStr.split(/[;:]/).map(Number).filter((n) => !isNaN(n)) : [];
      const type = final === "m" ? "sgr" : "csi";
      entries.push({
        ts,
        type,
        raw,
        params: params.length > 0 ? params : void 0,
        private: priv || void 0,
        final
      });
    } else if (next === "]") {
      i++;
      while (i < data.length && data.charCodeAt(i) !== 7 && !(data.charCodeAt(i) === ESC && i + 1 < data.length && data[i + 1] === "\\")) {
        i++;
      }
      if (i < data.length) {
        if (data.charCodeAt(i) === 7) i++;
        else if (data.charCodeAt(i) === ESC) i += 2;
      }
      const raw = data.slice(seqStart, i);
      entries.push({ ts, type: "osc", raw: raw.slice(0, 80) });
    } else if (next >= " " && next <= "~") {
      i++;
      entries.push({
        ts,
        type: "esc",
        raw: data.slice(seqStart, i),
        final: next
      });
    } else {
      i++;
    }
    textStart = i;
  }
  flushText();
  return entries;
}
const MAX_TRACES = 500;
class DebugAdapter {
  constructor() {
    __publicField(this, "_traces", []);
    __publicField(this, "_bridge", null);
    __publicField(this, "_perf", {
      frameCount: 0,
      totalRenderMs: 0,
      avgRenderMs: 0,
      maxRenderMs: 0,
      lastDirtyRows: 0
    });
  }
  get traces() {
    return this._traces;
  }
  get perf() {
    return this._perf;
  }
  setBridge(bridge) {
    this._bridge = bridge;
  }
  traceWrite(data) {
    const str = typeof data === "string" ? data : new TextDecoder().decode(data);
    const entries = scanSequences(str);
    for (const entry of entries) {
      this._traces.push(entry);
    }
    if (this._traces.length > MAX_TRACES) {
      this._traces = this._traces.slice(-MAX_TRACES);
    }
  }
  recordRender(renderMs, dirtyRows) {
    this._perf.frameCount++;
    this._perf.totalRenderMs += renderMs;
    this._perf.avgRenderMs = this._perf.totalRenderMs / this._perf.frameCount;
    if (renderMs > this._perf.maxRenderMs) {
      this._perf.maxRenderMs = renderMs;
    }
    this._perf.lastDirtyRows = dirtyRows;
  }
  resetPerf() {
    this._perf = {
      frameCount: 0,
      totalRenderMs: 0,
      avgRenderMs: 0,
      maxRenderMs: 0,
      lastDirtyRows: 0
    };
  }
  // -- Cell inspector --
  cell(row, col) {
    if (!this._bridge) return null;
    const c = this._bridge.getCell(row, col);
    return {
      ...c,
      charStr: c.char >= 32 ? String.fromCodePoint(c.char) : "",
      flagNames: flagsToNames(c.flags)
    };
  }
  row(row) {
    if (!this._bridge) return null;
    const cols = this._bridge.getCols();
    const cells = [];
    for (let c = 0; c < cols; c++) {
      cells.push(this.cell(row, c));
    }
    return cells;
  }
  grid() {
    if (!this._bridge) return null;
    const cursor = this._bridge.getCursor();
    return {
      rows: this._bridge.getRows(),
      cols: this._bridge.getCols(),
      cursor,
      altScreen: this._bridge.usingAltScreen(),
      scrollbackCount: this._bridge.getScrollbackCount()
    };
  }
  unhandled() {
    if (!this._bridge) return [];
    return this._bridge.getUnhandledSequences();
  }
  // -- Console-friendly dump --
  dump(count = 50) {
    const entries = this._traces.slice(-count);
    console.group(
      `%cwterm debug \u2014 last ${entries.length} traces`,
      "color: #569cd6; font-weight: bold"
    );
    for (const e of entries) {
      const badge = e.type === "sgr" ? "%cSGR" : e.type === "csi" ? "%cCSI" : e.type === "osc" ? "%cOSC" : e.type === "esc" ? "%cESC" : "%cTXT";
      const color = e.type === "sgr" ? "background:#2d5a27;color:#fff;padding:1px 4px;border-radius:2px" : e.type === "csi" ? "background:#1e4a7a;color:#fff;padding:1px 4px;border-radius:2px" : "background:#555;color:#fff;padding:1px 4px;border-radius:2px";
      const detail = [
        e.private ? `private=${e.private}` : "",
        e.params ? `params=[${e.params}]` : "",
        e.final ? `final=${e.final}` : ""
      ].filter(Boolean).join(" ");
      console.log(
        `${badge} ${e.raw.slice(0, 40)}`,
        color,
        detail ? `  ${detail}` : ""
      );
    }
    console.groupEnd();
  }
  dumpUnhandled() {
    const entries = this.unhandled();
    if (entries.length === 0) {
      console.log("%cwterm debug \u2014 no unhandled sequences", "color: #6a9955");
      return;
    }
    console.group(
      `%cwterm debug \u2014 ${entries.length} unhandled sequences`,
      "color: #d7ba7d; font-weight: bold"
    );
    for (const e of entries) {
      console.log(
        `  final=${e.final} private=${e.private || "-"} params=[${e.params.slice(0, e.paramCount)}]`
      );
    }
    console.groupEnd();
  }
}
export {
  DebugAdapter
};
