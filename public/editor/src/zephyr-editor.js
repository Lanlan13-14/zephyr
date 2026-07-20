import {EditorState, Compartment, StateEffect, StateField, EditorSelection} from '@codemirror/state';
import {EditorView, basicSetup} from 'codemirror';
import {keymap, lineNumbers, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, Decoration, ViewPlugin} from '@codemirror/view';
import {defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, toggleComment, moveLineUp, moveLineDown, copyLineUp, copyLineDown, deleteLine, selectLine, selectParentSyntax, insertBlankLine, deleteTrailingWhitespace} from '@codemirror/commands';
import {searchKeymap, highlightSelectionMatches, openSearchPanel, findNext, findPrevious, selectNextOccurrence, gotoLine} from '@codemirror/search';
import {autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, startCompletion} from '@codemirror/autocomplete';
import {bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, defaultHighlightStyle, StreamLanguage, foldAll, unfoldAll} from '@codemirror/language';
import {linter, lintGutter} from '@codemirror/lint';
import {javascript} from '@codemirror/lang-javascript';
import {json} from '@codemirror/lang-json';
import {python} from '@codemirror/lang-python';
import {html} from '@codemirror/lang-html';
import {css} from '@codemirror/lang-css';
import {markdown} from '@codemirror/lang-markdown';
import {xml} from '@codemirror/lang-xml';
import {yaml} from '@codemirror/lang-yaml';
import {sql} from '@codemirror/lang-sql';
import {rust} from '@codemirror/lang-rust';
import {cpp} from '@codemirror/lang-cpp';
import {java} from '@codemirror/lang-java';
import {php} from '@codemirror/lang-php';
import {shell} from '@codemirror/legacy-modes/mode/shell';
import {toml} from '@codemirror/legacy-modes/mode/toml';
import {dockerFile} from '@codemirror/legacy-modes/mode/dockerfile';
import {githubLight, githubDark} from '@uiw/codemirror-theme-github';
import {LSPClient, languageServerExtensions} from '@codemirror/lsp-client';
import {MergeView} from '@codemirror/merge';
import {format as prettierFormat} from 'prettier/standalone';
import * as prettierYaml from 'prettier/plugins/yaml';
import * as prettierBabel from 'prettier/plugins/babel';
import * as prettierEstree from 'prettier/plugins/estree';

const LARGE_FILE_LIMIT = 5 * 1024 * 1024;
const MEDIUM_FILE_LIMIT = 1024 * 1024;
const SAVE_DEBOUNCE_MS = 800;
const LSP_LANGUAGES = new Set(['yaml', 'json']);
const MOBILE_QUERY = '(max-width: 720px), (pointer: coarse)';
const MINIMAP_MAX_LINES = 12000;

const languageConfig = new Compartment();
const tabConfig = new Compartment();
const wrapConfig = new Compartment();
const editableConfig = new Compartment();
const lspConfig = new Compartment();
const themeConfig = new Compartment();
const minimapConfig = new Compartment();
const compactConfig = new Compartment();

let yamlLspClient = null;
let jsonLspClient = null;
let lspConnecting = false;

const languageLabels = {
  plain: 'Plain', javascript: 'JavaScript', typescript: 'TypeScript', json: 'JSON', python: 'Python',
  html: 'HTML', css: 'CSS', markdown: 'Markdown', yaml: 'YAML', xml: 'XML', sql: 'SQL', rust: 'Rust',
  cpp: 'C/C++', java: 'Java', php: 'PHP', shell: 'Shell', toml: 'TOML', dockerfile: 'Dockerfile', go: 'Go',
};

const schemaHints = {
  'docker-compose': 'Compose Schema',
  '.github/workflows/': 'GitHub Actions Schema',
  'package.json': 'npm package.json',
  'tsconfig': 'TypeScript Config',
};

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (ch) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
}

function extensionFor(language) {
  switch (language) {
    case 'javascript':
    case 'typescript': return javascript({typescript: language === 'typescript'});
    case 'json': return json();
    case 'python': return python();
    case 'html': return html();
    case 'css': return css();
    case 'markdown': return markdown();
    case 'yaml': return yaml();
    case 'xml': return xml();
    case 'sql': return sql();
    case 'rust': return rust();
    case 'cpp': return cpp();
    case 'java': return java();
    case 'php': return php();
    case 'shell': return StreamLanguage.define(shell);
    case 'toml': return StreamLanguage.define(toml);
    case 'dockerfile': return StreamLanguage.define(dockerFile);
    case 'go': return StreamLanguage.define(shell); // lightweight until go mode added
    default: return [];
  }
}

function fileUri(path) {
  const safe = String(path || 'untitled').split('/').map(encodeURIComponent).join('/');
  return `file:///${safe.replace(/^\/+/, '')}`;
}

function languageId(language) {
  if (language === 'shell') return 'shellscript';
  if (language === 'dockerfile') return 'dockerfile';
  if (language === 'typescript') return 'typescript';
  if (language === 'javascript') return 'javascript';
  return language || 'plaintext';
}

function simpleWebSocketTransport(url) {
  let socket;
  let handlers = [];
  return new Promise((resolve, reject) => {
    socket = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('LSP 连接超时')), 5000);
    socket.onmessage = (event) => handlers.forEach((handler) => handler(String(event.data || '')));
    socket.onerror = () => reject(new Error('LSP WebSocket 连接失败'));
    socket.onopen = () => {
      clearTimeout(timer);
      resolve({
        send(message) { if (socket.readyState === WebSocket.OPEN) socket.send(message); },
        subscribe(handler) { handlers.push(handler); },
        unsubscribe(handler) { handlers = handlers.filter((item) => item !== handler); },
      });
    };
  });
}

async function ensureLspClient(kind) {
  if (kind === 'yaml' && yamlLspClient?.connected) return yamlLspClient;
  if (kind === 'json' && jsonLspClient?.connected) return jsonLspClient;
  if (lspConnecting) return null;
  lspConnecting = true;
  try {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const transport = await simpleWebSocketTransport(`${protocol}//${location.host}/editor-lsp?language=${encodeURIComponent(kind)}`);
    const client = new LSPClient({
      rootUri: 'file:///',
      timeout: 5000,
      sanitizeHTML: (html) => String(html || '').replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, ''),
      extensions: languageServerExtensions(),
    }).connect(transport);
    if (kind === 'yaml') yamlLspClient = client;
    else jsonLspClient = client;
    return client;
  } catch (error) {
    console.warn('[editor-lsp]', error);
    return null;
  } finally {
    lspConnecting = false;
  }
}

function lspExtensionFor(instance) {
  if (!instance || !LSP_LANGUAGES.has(instance.language) || instance.largeFile) return [];
  const client = instance.language === 'yaml' ? yamlLspClient : jsonLspClient;
  if (!client?.connected) return [];
  return client.plugin(fileUri(instance.path), languageId(instance.language));
}

function isLightTheme() {
  return document.documentElement.dataset.theme === 'light' || document.documentElement.getAttribute('data-theme') === 'light';
}

function editorThemeExtension(instance) {
  const extensions = [isLightTheme() ? githubLight : githubDark, zephyrEditorTheme];
  return extensions;
}

const zephyrEditorTheme = EditorView.theme({
  '&': {height: '100%', fontSize: '13px'},
  '.cm-scroller': {fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)', lineHeight: '1.55'},
  '.cm-content': {caretColor: 'var(--accent)'},
  '.cm-gutters': {background: 'var(--cm-gutter-bg)', color: 'var(--cm-gutter-fg)', borderRight: '1px solid var(--cm-gutter-border)'},
  '.cm-activeLineGutter': {background: 'var(--cm-active-gutter)'},
  '.cm-activeLine': {background: 'var(--cm-active-line)'},
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {background: 'var(--cm-selection) !important'},
  '.cm-foldGutter .cm-gutterElement': {cursor: 'pointer'},
  '.cm-cursor, .cm-dropCursor': {borderLeftColor: 'var(--accent)'},
  '.cm-panels': {background: 'color-mix(in srgb, var(--surface) 92%, var(--bg))', color: 'var(--text)'},
  '.cm-searchMatch': {background: 'color-mix(in srgb, var(--accent) 28%, transparent)'},
  '.cm-searchMatch.cm-searchMatch-selected': {background: 'color-mix(in srgb, var(--accent) 48%, transparent)'},
  '.cm-tooltip': {border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', borderRadius: '10px'},
  '.cm-diagnostic': {paddingLeft: '2px'},
  '.cm-lintRange-error': {backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'6\' height=\'3\'%3E%3Cpath d=\'M0 3 L3 0 L6 3\' fill=\'none\' stroke=\'%23ef4444\' stroke-width=\'1\'/%3E%3C/svg%3E")'},
}, {dark: !isLightTheme()});

function compactExtension(instance) {
  if (!instance.compact) return [];
  return EditorView.theme({
    '.cm-scroller': {fontSize: '12px', lineHeight: '1.45'},
    '.cm-gutters': {fontSize: '11px'},
  });
}

/* ── Canvas minimap (performant, VS Code–like navigation) ── */
function createMinimapExtension(instance) {
  if (instance.largeFile || !instance.minimap) return [];
  return [canvasMinimapPlugin(instance)];
}

function canvasMinimapPlugin(instance) {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.instance = instance;
      this.dom = document.createElement('div');
      this.dom.className = 'zephyr-cm-minimap zephyr-cm-minimap-canvas';
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'zephyr-cm-minimap-canvas-el';
      this.thumb = document.createElement('div');
      this.thumb.className = 'zephyr-cm-minimap-thumb';
      this.dom.append(this.canvas, this.thumb);
      this.ctx = this.canvas.getContext('2d', {alpha: true});
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.dragging = false;
      this._raf = 0;
      this._dirty = true;
      this.onPointerDown = this.onPointerDown.bind(this);
      this.onScroll = this.onScroll.bind(this);
      this.dom.addEventListener('pointerdown', this.onPointerDown, {passive: false});
      view.scrollDOM.addEventListener('scroll', this.onScroll, {passive: true});
      view.dom.appendChild(this.dom);
      this.scheduleRender(true);
    }
    update(update) {
      if (update.docChanged || update.geometryChanged || update.viewportChanged) {
        this._dirty = this._dirty || update.docChanged || update.geometryChanged;
        this.scheduleRender(update.docChanged || update.geometryChanged);
      }
    }
    destroy() {
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
      this.dom.removeEventListener('pointerdown', this.onPointerDown);
      if (this._raf) cancelAnimationFrame(this._raf);
      this.dom.remove();
    }
    onScroll() { this.scheduleRender(false); }
    scheduleRender(full) {
      if (full) this._dirty = true;
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        this.render();
      });
    }
    onPointerDown(event) {
      event.preventDefault();
      event.stopPropagation();
      this.dragging = true;
      this.dom.setPointerCapture?.(event.pointerId);
      this.jump(event);
      const move = (ev) => { if (this.dragging) this.jump(ev); };
      const up = () => {
        this.dragging = false;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointermove', move, {passive: false});
      window.addEventListener('pointerup', up, {once: true});
      window.addEventListener('pointercancel', up, {once: true});
    }
    jump(event) {
      const rect = this.dom.getBoundingClientRect();
      const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
      const ratio = y / Math.max(1, rect.height);
      const doc = this.view.state.doc;
      const targetLine = Math.max(1, Math.min(doc.lines, Math.round(1 + ratio * Math.max(0, doc.lines - 1))));
      const line = doc.line(targetLine);
      // Prefer CM scrollIntoView for correct block geometry
      this.view.dispatch({
        selection: {anchor: line.from},
        effects: EditorView.scrollIntoView(line.from, {y: 'center'}),
      });
      this.view.focus();
      this.scheduleRender(false);
    }
    colors() {
      const light = isLightTheme();
      return {
        bg: light ? 'rgba(246,248,250,0.96)' : 'rgba(15,23,42,0.94)',
        text: light ? 'rgba(36,41,47,0.55)' : 'rgba(219,234,254,0.42)',
        keyword: light ? 'rgba(9,105,218,0.75)' : 'rgba(96,165,250,0.7)',
        string: light ? 'rgba(15,123,61,0.7)' : 'rgba(74,222,128,0.55)',
        comment: light ? 'rgba(110,119,129,0.55)' : 'rgba(148,163,184,0.4)',
        error: 'rgba(239,68,68,0.85)',
        warn: 'rgba(245,158,11,0.85)',
      };
    }
    classifyLine(text) {
      const t = text.trim();
      if (!t) return 'empty';
      if (t.startsWith('//') || t.startsWith('#') || t.startsWith('/*') || t.startsWith('*')) return 'comment';
      if (/^["'`]|:\s*["'`]|=>/.test(t) || /["'`]/.test(t.slice(0, 24))) return 'string';
      if (/^(function|class|const|let|var|import|export|return|if|for|while|def|package|type|interface|struct|fn|pub|async|await|module|from|select|create)\b/i.test(t)) return 'keyword';
      return 'text';
    }
    render() {
      const view = this.view;
      const doc = view.state.doc;
      const scroll = view.scrollDOM;
      const cssW = Math.max(48, this.dom.clientWidth || 72);
      const cssH = Math.max(40, this.dom.clientHeight || scroll.clientHeight || 200);
      const dpr = this.dpr;
      if (this.canvas.width !== Math.floor(cssW * dpr) || this.canvas.height !== Math.floor(cssH * dpr)) {
        this.canvas.width = Math.floor(cssW * dpr);
        this.canvas.height = Math.floor(cssH * dpr);
        this.canvas.style.width = `${cssW}px`;
        this.canvas.style.height = `${cssH}px`;
        this._dirty = true;
      }
      const ctx = this.ctx;
      if (!ctx) return;
      const colors = this.colors();
      if (this._dirty) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        ctx.fillStyle = colors.bg;
        ctx.fillRect(0, 0, cssW, cssH);
        const lines = doc.lines;
        const sample = lines > MINIMAP_MAX_LINES ? Math.ceil(lines / MINIMAP_MAX_LINES) : 1;
        const drawn = Math.ceil(lines / sample);
        const rowH = Math.max(1, cssH / Math.max(1, drawn));
        const barMax = cssW - 6;
        for (let i = 0, y = 0; i < lines; i += sample, y += rowH) {
          const line = doc.line(Math.min(lines, i + 1));
          const raw = line.text;
          const kind = this.classifyLine(raw);
          if (kind === 'empty') continue;
          const indent = Math.min(12, (raw.match(/^\s*/)?.[0]?.length || 0) * 0.45);
          const dens = Math.min(1, Math.max(0.12, raw.trim().length / 48));
          ctx.globalAlpha = 0.55 + dens * 0.45;
          ctx.fillStyle = kind === 'keyword' ? colors.keyword
            : kind === 'string' ? colors.string
              : kind === 'comment' ? colors.comment
                : colors.text;
          const w = Math.max(2, dens * barMax);
          ctx.fillRect(3 + indent, y, w, Math.max(1, rowH * 0.72));
        }
        ctx.globalAlpha = 1;
        // diagnostic markers
        const diags = this.instance?._diagnostics || [];
        for (const d of diags) {
          if (!d || d.from == null) continue;
          const ln = doc.lineAt(Math.max(0, Math.min(doc.length, d.from))).number;
          const y = ((ln - 1) / Math.max(1, lines - 1)) * cssH;
          ctx.fillStyle = d.severity === 'warning' ? colors.warn : colors.error;
          ctx.fillRect(cssW - 4, y - 1, 3, 3);
        }
        this._dirty = false;
      }
      // thumb
      const maxScroll = Math.max(1, scroll.scrollHeight - scroll.clientHeight);
      const topRatio = scroll.scrollTop / maxScroll;
      const heightPct = Math.max(6, Math.min(100, (scroll.clientHeight / Math.max(scroll.scrollHeight, 1)) * 100));
      this.thumb.style.top = `${topRatio * (100 - heightPct)}%`;
      this.thumb.style.height = `${heightPct}%`;
    }
  });
}

function statusParts(instance) {
  const text = instance.view?.state.doc.toString() || '';
  const bytes = new TextEncoder().encode(text).length;
  const lineCount = instance.view?.state.doc.lines || 1;
  const label = languageLabels[instance.language] || languageLabels.plain;
  const dirty = instance.dirty ? '● 未保存' : '已保存';
  const perf = instance.largeFile ? '大文件降级' : instance.mediumFile ? '性能模式' : instance.compact ? '紧凑' : 'IDE';
  const lsp = LSP_LANGUAGES.has(instance.language) && !instance.largeFile ? 'LSP' : '';
  const schema = schemaHint(instance.path);
  const sel = instance.view?.state.selection;
  const cursors = sel ? sel.ranges.length : 1;
  const multi = cursors > 1 ? `${cursors} 光标` : '';
  return [dirty, `${lineCount} 行`, multi, `${text.length} 字符`, `${bytes} bytes`, label, perf, lsp, schema].filter(Boolean);
}

function schemaHint(path = '') {
  const lower = String(path).toLowerCase();
  for (const [needle, label] of Object.entries(schemaHints)) if (lower.includes(needle)) return label;
  return '';
}

function updateStatus(instance) {
  if (!instance?.statusEl) return;
  instance.statusEl.textContent = statusParts(instance).join(' · ');
  if (instance.titleEl) {
    const name = instance.path || '未命名文件';
    instance.titleEl.textContent = `${instance.dirty ? '● ' : ''}编辑: ${name}`;
  }
  instance.onDiagnostics?.(instance._diagnostics || []);
}

const addSnippetEffect = StateEffect.define();
const snippetMark = Decoration.mark({class: 'cm-snippet-placeholder'});
const snippetField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(addSnippetEffect)) value = value.update({add: [snippetMark.range(effect.value.from, effect.value.to)]});
    }
    if (tr.selection || tr.docChanged) {
      const pos = tr.state.selection.main.head;
      value = value.update({filter: (from, to) => pos >= from && pos <= to});
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Multi-cursor: add cursor above/below (VS Code Alt+Cmd+↑/↓ style) */
function addCursorAbove(view) {
  const ranges = [];
  for (const r of view.state.selection.ranges) {
    const line = view.state.doc.lineAt(r.head);
    if (line.number <= 1) { ranges.push(r); continue; }
    const prev = view.state.doc.line(line.number - 1);
    const col = Math.min(r.head - line.from, prev.length);
    ranges.push(r, EditorSelection.cursor(prev.from + col));
  }
  view.dispatch({selection: EditorSelection.create(ranges, view.state.selection.mainIndex)});
  return true;
}
function addCursorBelow(view) {
  const ranges = [];
  for (const r of view.state.selection.ranges) {
    const line = view.state.doc.lineAt(r.head);
    if (line.number >= view.state.doc.lines) { ranges.push(r); continue; }
    const next = view.state.doc.line(line.number + 1);
    const col = Math.min(r.head - line.from, next.length);
    ranges.push(r, EditorSelection.cursor(next.from + col));
  }
  view.dispatch({selection: EditorSelection.create(ranges, view.state.selection.mainIndex)});
  return true;
}

function collectOutline(view) {
  if (!view) return [];
  const out = [];
  const doc = view.state.doc;
  const max = Math.min(doc.lines, 4000);
  const re = /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|class\s+(\w+)|const\s+(\w+)\s*=|let\s+(\w+)\s*=|def\s+(\w+)|fn\s+(\w+)|type\s+(\w+)|interface\s+(\w+)|struct\s+(\w+)|#\s+(.+)|##\s+(.+))/;
  for (let n = 1; n <= max; n++) {
    const line = doc.line(n);
    const m = line.text.match(re);
    if (!m) continue;
    const name = m[1] || m[2] || m[3] || m[4] || m[5] || m[6] || m[7] || m[8] || m[9] || m[10] || m[11];
    if (!name) continue;
    out.push({name: String(name).slice(0, 80), line: n, from: line.from});
    if (out.length >= 200) break;
  }
  return out;
}

function simpleJsonYamlLinter(instance) {
  return linter((view) => {
    const diags = [];
    if (instance.language === 'json') {
      try {
        JSON.parse(view.state.doc.toString() || 'null');
      } catch (err) {
        const msg = String(err.message || err);
        const m = msg.match(/position\s+(\d+)/i) || msg.match(/at position\s+(\d+)/i);
        const pos = m ? Number(m[1]) : 0;
        const from = Math.max(0, Math.min(view.state.doc.length, pos));
        diags.push({from, to: Math.min(view.state.doc.length, from + 1), severity: 'error', message: msg});
      }
    }
    instance._diagnostics = diags;
    instance.onDiagnostics?.(diags);
    return diags;
  }, {delay: 400});
}

function buildExtensions(instance) {
  const extensions = [
    basicSetup,
    lineNumbers(),
    foldGutter(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    syntaxHighlighting(defaultHighlightStyle, {fallback: true}),
    lintGutter(),
    snippetField,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        instance.dirty = instance.view ? update.state.doc.toString() !== instance.originalText : true;
        scheduleAutoSave(instance);
      }
      if (update.docChanged || update.selectionSet) updateStatus(instance);
    }),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
      {key: 'Mod-s', run: () => { instance.requestSave?.(); return true; }},
      {key: 'Mod-Shift-f', run: () => { formatDocument(instance); return true; }},
      {key: 'Mod-Shift-Space', run: () => { requestAiCompletion(instance); return true; }},
      {key: 'Mod-/', run: toggleComment},
      {key: 'Alt-ArrowUp', run: moveLineUp},
      {key: 'Alt-ArrowDown', run: moveLineDown},
      {key: 'Shift-Alt-ArrowUp', run: copyLineUp},
      {key: 'Shift-Alt-ArrowDown', run: copyLineDown},
      {key: 'Mod-Shift-k', run: deleteLine},
      {key: 'Mod-l', run: selectLine},
      {key: 'Mod-Shift-o', run: selectParentSyntax},
      {key: 'Mod-Enter', run: insertBlankLine},
      {key: 'Mod-d', run: selectNextOccurrence},
      {key: 'Mod-Shift-l', run: selectNextOccurrence},
      {key: 'Mod-Alt-ArrowUp', run: addCursorAbove},
      {key: 'Mod-Alt-ArrowDown', run: addCursorBelow},
      {key: 'F1', run: () => openCommandPalette(instance)},
      {key: 'Mod-p', run: () => openCommandPalette(instance)},
      {key: 'Mod-Shift-o', run: () => { instance.onOutline?.(collectOutline(instance.view)); return true; }},
      {key: 'Mod-g', run: gotoLine},
      {key: 'Escape', run: () => { closeCommandPalette(instance); instance.view?.contentDOM.blur(); return false; }},
    ]),
    languageConfig.of(extensionFor(instance.language)),
    tabConfig.of(EditorState.tabSize.of(instance.tabSize || 4)),
    wrapConfig.of(instance.wrap ? EditorView.lineWrapping : []),
    editableConfig.of(EditorView.editable.of(true)),
    lspConfig.of(lspExtensionFor(instance)),
    themeConfig.of(editorThemeExtension(instance)),
    minimapConfig.of(createMinimapExtension(instance)),
    compactConfig.of(compactExtension(instance)),
  ];
  if (!instance.largeFile) {
    extensions.push(autocompletion({activateOnTyping: true, maxRenderedOptions: 80}));
    if (instance.language === 'json' || instance.language === 'yaml') {
      extensions.push(simpleJsonYamlLinter(instance));
    }
  }
  return extensions;
}

function scheduleAutoSave(instance) {
  clearTimeout(instance.saveTimer);
  if (!instance.dirty || !instance.autoSave) return;
  instance.saveTimer = setTimeout(() => instance.requestSave?.({silent: true}), SAVE_DEBOUNCE_MS);
}

async function requestAiCompletion(instance) {
  if (!instance?.view || instance.largeFile) return false;
  const view = instance.view;
  const pos = view.state.selection.main.head;
  const doc = view.state.doc.toString();
  const prefix = doc.slice(Math.max(0, pos - 5000), pos);
  const suffix = doc.slice(pos, Math.min(doc.length, pos + 2000));
  try {
    const res = await fetch('/api/ai/complete', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({path: instance.path, language: instance.language, prefix, suffix, maxTokens: 180}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    const text = data.suggestions?.[0]?.apply || data.text || data.completion || '';
    if (!text) {
      instance.notify?.('AI 未返回补全', 'info');
      return true;
    }
    view.dispatch(view.state.replaceSelection(String(text)));
    return true;
  } catch (error) {
    instance.notify?.(`AI 补全失败: ${error.message || error}`, 'error');
    return true;
  }
}

async function formatDocument(instance) {
  if (!instance?.view || instance.largeFile) return false;
  const language = instance.language;
  const text = instance.view.state.doc.toString();
  let parser = '';
  let plugins = [];
  if (language === 'yaml') { parser = 'yaml'; plugins = [prettierYaml]; }
  else if (language === 'json') { parser = 'json'; plugins = [prettierBabel, prettierEstree]; }
  else if (language === 'javascript' || language === 'typescript') { parser = 'babel'; plugins = [prettierBabel, prettierEstree]; }
  else if (language === 'html') { parser = 'html'; plugins = [prettierBabel, prettierEstree]; }
  else if (language === 'css') { parser = 'css'; plugins = [prettierBabel, prettierEstree]; }
  else if (language === 'markdown') { parser = 'markdown'; plugins = [prettierBabel, prettierEstree]; }
  else return false;
  try {
    const formatted = await prettierFormat(text, {parser, plugins, tabWidth: instance.tabSize || 2, printWidth: 100});
    if (formatted !== text) instance.view.dispatch({changes: {from: 0, to: instance.view.state.doc.length, insert: formatted}});
    return true;
  } catch (error) {
    instance.notify?.(`格式化失败: ${error.message || error}`, 'error');
    return false;
  }
}

function commandList(instance) {
  return [
    ['查找', openSearchPanel], ['查找下一个', findNext], ['查找上一个', findPrevious], ['跳转到行', gotoLine],
    ['格式化文档', () => formatDocument(instance)], ['删除尾随空格', deleteTrailingWhitespace], ['触发补全', startCompletion],
    ['折叠全部', foldAll], ['展开全部', unfoldAll], ['切换注释', toggleComment], ['上移行', moveLineUp], ['下移行', moveLineDown],
    ['向上复制行', copyLineUp], ['向下复制行', copyLineDown], ['删除行', deleteLine], ['选择当前行', selectLine],
    ['添加上方光标', addCursorAbove], ['添加下方光标', addCursorBelow], ['选中下一处相同', selectNextOccurrence],
    ['显示大纲', () => { instance.onOutline?.(collectOutline(instance.view)); return true; }],
    ['AI 代码补全', () => requestAiCompletion(instance)],
    ['切换概览', () => { toggleMinimap(instance); return true; }], ['切换紧凑模式', () => { toggleCompact(instance); return true; }],
  ];
}

function openCommandPalette(instance) {
  if (!instance?.panel) return false;
  let palette = instance.panel.querySelector('[data-editor-role="commandPalette"]');
  if (!palette) {
    palette = document.createElement('div');
    palette.className = 'cm-command-palette';
    palette.dataset.editorRole = 'commandPalette';
    palette.innerHTML = '<input placeholder="输入命令 / Command Palette"><div class="cm-command-list"></div>';
    instance.panel.appendChild(palette);
  }
  const input = palette.querySelector('input');
  const list = palette.querySelector('.cm-command-list');
  const render = () => {
    const query = input.value.trim().toLowerCase();
    list.innerHTML = '';
    commandList(instance).filter(([name]) => !query || name.toLowerCase().includes(query)).slice(0, 14).forEach(([name, run]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name;
      button.addEventListener('click', () => { run(instance.view); closeCommandPalette(instance); instance.view.focus(); });
      list.appendChild(button);
    });
  };
  input.oninput = render;
  input.onkeydown = (event) => {
    if (event.key === 'Escape') { closeCommandPalette(instance); instance.view.focus(); }
    if (event.key === 'Enter') list.querySelector('button')?.click();
  };
  palette.classList.add('open');
  input.value = '';
  render();
  setTimeout(() => input.focus(), 0);
  return true;
}

function closeCommandPalette(instance) {
  instance?.panel?.querySelector('[data-editor-role="commandPalette"]')?.classList.remove('open');
}

function toggleCommandPalette(instance) {
  const palette = instance?.panel?.querySelector('[data-editor-role="commandPalette"]');
  if (palette?.classList.contains('open')) { closeCommandPalette(instance); instance.view?.focus(); return true; }
  return openCommandPalette(instance);
}

function createMobileToolbar(instance, parent) {
  let toolbar = parent.querySelector('[data-editor-role="mobileToolbar"]');
  if (!toolbar) {
    toolbar = document.createElement('div');
    toolbar.className = 'cm-mobile-toolbar';
    toolbar.dataset.editorRole = 'mobileToolbar';
    const actions = [
      ['保存', () => instance.requestSave?.()],
      ['查找', () => openSearchPanel(instance.view)],
      ['撤销', () => undo(instance.view)],
      ['重做', () => redo(instance.view)],
      ['格式化', () => formatDocument(instance)],
      ['命令', () => openCommandPalette(instance)],
    ];
    actions.forEach(([label, run]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.addEventListener('click', (e) => { e.preventDefault(); run(); });
      toolbar.appendChild(btn);
    });
    parent.appendChild(toolbar);
  }
}

function installViewportAdapter(instance) {
  const onResize = () => {
    try { instance.view?.requestMeasure?.(); } catch {}
  };
  window.addEventListener('resize', onResize);
  instance.viewportCleanup = () => window.removeEventListener('resize', onResize);
}

function installThemeObserver(instance) {
  const obs = new MutationObserver(() => {
    if (!instance.view) return;
    instance.view.dispatch({effects: themeConfig.reconfigure(editorThemeExtension(instance))});
  });
  obs.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme', 'class']});
  instance.themeObserver = obs;
}

function setPanelFlags(instance) {
  instance.panel?.classList.toggle('cm-editor-compact', !!instance.compact);
  instance.panel?.classList.toggle('cm-editor-minimap-on', !!instance.minimap && !instance.largeFile);
}

export function createZephyrEditor(options) {
  const instance = {
    path: options.path || '',
    language: options.language || 'plain',
    originalText: options.text || '',
    dirty: false,
    largeFile: (options.size || 0) > LARGE_FILE_LIMIT,
    mediumFile: (options.size || 0) > MEDIUM_FILE_LIMIT,
    tabSize: Number(options.tabSize || 4),
    wrap: options.wrap !== false,
    autoSave: options.autoSave === true,
    minimap: options.minimap === true,
    compact: options.compact === true || matchMedia(MOBILE_QUERY).matches,
    themeName: options.themeName || 'auto',
    panel: options.panel,
    titleEl: options.titleEl,
    statusEl: options.statusEl,
    notify: options.notify,
    requestSave: options.onSave,
    onDiagnostics: options.onDiagnostics,
    onOutline: options.onOutline,
    mtimeMs: options.mtimeMs || 0,
    size: options.size || 0,
    _diagnostics: [],
  };
  if (instance.largeFile) instance.minimap = false;
  const parent = options.parent;
  parent.innerHTML = '';
  const view = new EditorView({
    state: EditorState.create({doc: instance.originalText, extensions: buildExtensions(instance)}),
    parent,
  });
  instance.view = view;
  createMobileToolbar(instance, options.panel || parent);
  installViewportAdapter(instance);
  installThemeObserver(instance);
  setPanelFlags(instance);
  updateStatus(instance);
  if (LSP_LANGUAGES.has(instance.language) && !instance.largeFile) {
    ensureLspClient(instance.language).then((client) => {
      if (!client || instance.destroyed) return;
      view.dispatch({effects: lspConfig.reconfigure(lspExtensionFor(instance))});
      updateStatus(instance);
    });
  }
  return instance;
}

export function updateZephyrEditorOptions(instance, options = {}) {
  if (!instance?.view) return;
  if (options.language && options.language !== instance.language) {
    instance.language = options.language;
    instance.view.dispatch({effects: languageConfig.reconfigure(extensionFor(instance.language))});
  }
  if (options.tabSize) {
    instance.tabSize = Number(options.tabSize) || 4;
    instance.view.dispatch({effects: tabConfig.reconfigure(EditorState.tabSize.of(instance.tabSize))});
  }
  if (typeof options.wrap === 'boolean') {
    instance.wrap = options.wrap;
    instance.view.dispatch({effects: wrapConfig.reconfigure(instance.wrap ? EditorView.lineWrapping : [])});
  }
  if (typeof options.minimap === 'boolean') {
    instance.minimap = options.minimap && !instance.largeFile;
    instance.view.dispatch({effects: minimapConfig.reconfigure(createMinimapExtension(instance))});
    setPanelFlags(instance);
  }
  if (typeof options.compact === 'boolean') {
    instance.compact = options.compact;
    instance.view.dispatch({effects: [compactConfig.reconfigure(compactExtension(instance)), minimapConfig.reconfigure(createMinimapExtension(instance))]});
    setPanelFlags(instance);
  }
  if (options.mtimeMs != null) instance.mtimeMs = options.mtimeMs;
  if (options.size != null) instance.size = options.size;
  updateStatus(instance);
}

export function getZephyrEditorText(instance) {
  return instance?.view?.state.doc.toString() || '';
}

export function setZephyrEditorText(instance, text, {asSaved = true, mtimeMs, size} = {}) {
  if (!instance?.view) return;
  const next = String(text || '');
  if (asSaved) {
    instance.originalText = next;
    instance.dirty = false;
  } else {
    instance.dirty = next !== instance.originalText;
  }
  if (mtimeMs != null) instance.mtimeMs = mtimeMs;
  if (size != null) instance.size = size;
  instance.view.dispatch({changes: {from: 0, to: instance.view.state.doc.length, insert: next}});
  updateStatus(instance);
}

export function destroyZephyrEditor(instance) {
  if (!instance || instance.destroyed) return;
  instance.destroyed = true;
  clearTimeout(instance.saveTimer);
  instance.themeObserver?.disconnect();
  instance.viewportCleanup?.();
  closeCommandPalette(instance);
  instance.view?.destroy();
}

export function undoZephyrEditor(instance) { undo(instance?.view); updateStatus(instance); }
export function redoZephyrEditor(instance) { redo(instance?.view); updateStatus(instance); }
export function formatZephyrEditor(instance) { return formatDocument(instance); }
export function aiCompleteZephyrEditor(instance) { return requestAiCompletion(instance); }
export function focusZephyrEditor(instance) { instance?.view?.focus(); }
export function isZephyrEditorDirty(instance) { return !!instance?.dirty; }
export function toggleMinimap(instance) { updateZephyrEditorOptions(instance, {minimap: !instance?.minimap}); return true; }
export function toggleCompact(instance) { updateZephyrEditorOptions(instance, {compact: !instance?.compact}); return true; }
export function openPalette(instance) { return toggleCommandPalette(instance); }
export function getOutline(instance) { return collectOutline(instance?.view); }
export function gotoEditorLine(instance, line) {
  if (!instance?.view) return false;
  const doc = instance.view.state.doc;
  const n = Math.max(1, Math.min(doc.lines, Number(line) || 1));
  const from = doc.line(n).from;
  instance.view.dispatch({selection: {anchor: from}, effects: EditorView.scrollIntoView(from, {y: 'center'})});
  instance.view.focus();
  return true;
}
export function openSearch(instance) {
  if (!instance?.view) return false;
  openSearchPanel(instance.view);
  return true;
}
export function markSaved(instance, {text, mtimeMs, size} = {}) {
  if (!instance) return;
  if (text != null) instance.originalText = String(text);
  else instance.originalText = getZephyrEditorText(instance);
  instance.dirty = false;
  if (mtimeMs != null) instance.mtimeMs = mtimeMs;
  if (size != null) instance.size = size;
  updateStatus(instance);
}

window.ZephyrCodeEditor = {
  create: createZephyrEditor,
  updateOptions: updateZephyrEditorOptions,
  getText: getZephyrEditorText,
  setText: setZephyrEditorText,
  destroy: destroyZephyrEditor,
  undo: undoZephyrEditor,
  redo: redoZephyrEditor,
  format: formatZephyrEditor,
  aiComplete: aiCompleteZephyrEditor,
  focus: focusZephyrEditor,
  dirty: isZephyrEditorDirty,
  toggleMinimap,
  toggleCompact,
  openPalette,
  getOutline,
  gotoLine: gotoEditorLine,
  openSearch,
  markSaved,
  MergeView,
};
