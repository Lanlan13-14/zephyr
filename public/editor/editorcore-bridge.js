// Desktop bridge. The page keeps CodeMirror for painting and asks this bridge
// for the document. Open, edit, selection and the UTF-8 used for saving all
// come back from one editorcore-host process.
import {createEditorCoreClient} from './src/editorcore-client.js';

const client = createEditorCoreClient(async (payload) => {
  const response = await fetch('/api/editorcore', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && data.ok !== true) {
    throw new Error(data.error || response.statusText || 'editorcore unavailable');
  }
  return data;
});

const bindings = new WeakMap();

function scalarLength(text) {
  return Array.from(String(text ?? '')).length;
}

// CodeMirror positions are UTF-16 code units. The core counts scalars, so a
// unit offset is converted with the document text before the change.
function unitsToScalars(text, unit) {
  return Array.from(String(text ?? '').slice(0, unit)).length;
}

function rangeFrom(change) {
  const before = change.before ?? '';
  const from = change.from ?? 0;
  const to = change.to ?? from;
  return {
    start: unitsToScalars(before, from),
    end: unitsToScalars(before, to),
    text: change.text ?? '',
  };
}

export async function openCoreDocument(instance, text, options = {}) {
  if (!instance) return null;
  const previous = bindings.get(instance);
  if (previous) {
    try { await client.close(previous.id); } catch {}
  }
  const snapshot = await client.open(text ?? '', {
    encoding: options.encoding || instance?.encoding || '',
    eol: options.eol || instance?.eol || '',
    tabSize: Number(options.tabSize || instance?.tabSize || 0),
  });
  bindings.set(instance, snapshot);
  instance.coreDocumentId = snapshot.id;
  instance.coreVersion = snapshot.version;
  return snapshot;
}

export async function editCoreDocument(instance, change) {
  const binding = bindings.get(instance);
  if (!binding) return null;
  const range = rangeFrom(change);
  const selection = change.selection;
  const snapshot = await client.edit(binding.id, {
    ...range,
    base: selection ? unitsToScalars(change.before, selection.anchor) : range.start,
    extent: selection ? unitsToScalars(change.after, selection.head) : range.start + scalarLength(range.text),
  });
  bindings.set(instance, snapshot);
  instance.coreVersion = snapshot.version;
  return snapshot;
}

export async function selectCoreDocument(instance) {
  const binding = bindings.get(instance);
  const selection = instance?.view?.state?.selection?.main;
  if (!binding || !selection) return null;
  const text = instance.view.state.doc.toString();
  const snapshot = await client.select(binding.id, unitsToScalars(text, selection.anchor), unitsToScalars(text, selection.head));
  bindings.set(instance, snapshot);
  instance.coreVersion = snapshot.version;
  return snapshot;
}

export async function coreDocumentText(instance) {
  const binding = bindings.get(instance);
  if (!binding) return null;
  const text = await client.text(binding.id);
  return text;
}

export async function closeCoreDocument(instance) {
  const binding = bindings.get(instance);
  if (!binding) return;
  bindings.delete(instance);
  try { await client.close(binding.id); } catch {}
}

async function command(instance, op, fields = {}) {
  const binding = bindings.get(instance);
  if (!binding) return null;
  const result = await client.command(binding.id, op, fields);
  if (result.snapshot) {
    bindings.set(instance, result.snapshot);
    instance.coreVersion = result.snapshot.version;
    if (typeof result.text === 'string') instance.coreText = result.text;
  }
  return result;
}

export function findInCore(instance, query, options = {}) {
  return command(instance, 'find', {query: String(query ?? ''), caseSensitive: !!options.caseSensitive, regex: !!options.regex, from: options.from});
}
export function findNextInCore(instance, query, options = {}) {
  return command(instance, 'findNext', {query: String(query ?? ''), caseSensitive: !!options.caseSensitive, regex: !!options.regex, from: options.from});
}
export function findPreviousInCore(instance, query, options = {}) {
  return command(instance, 'findPrevious', {query: String(query ?? ''), caseSensitive: !!options.caseSensitive, regex: !!options.regex, from: options.from});
}
export function replaceOneInCore(instance, query, replacement, options = {}) {
  return command(instance, 'replaceOne', {query: String(query ?? ''), replacement: String(replacement ?? ''), caseSensitive: !!options.caseSensitive, regex: !!options.regex, from: options.from});
}
export function replaceAllInCore(instance, query, replacement, options = {}) {
  return command(instance, 'replaceAll', {query: String(query ?? ''), replacement: String(replacement ?? ''), caseSensitive: !!options.caseSensitive, regex: !!options.regex});
}
export function undoCoreDocument(instance) { return command(instance, 'undo'); }
export function redoCoreDocument(instance) { return command(instance, 'redo'); }
export function indentCoreDocument(instance) { return command(instance, 'indent'); }
export function formatCoreDocument(instance) { return command(instance, 'format'); }
export function trimCoreTrailingWhitespace(instance) { return command(instance, 'trimTrailingWhitespace'); }
export function outdentCoreDocument(instance) { return command(instance, 'outdent'); }
export function breakCoreLine(instance) { return command(instance, 'breakLine'); }
export function toggleCoreComment(instance, language) { return command(instance, 'toggleLineComment', {language: language || ''}); }
export function copyCoreDocument(instance) { return command(instance, 'copy'); }
export function cutCoreDocument(instance) { return command(instance, 'cut'); }
export function pasteCoreDocument(instance, text) { return command(instance, 'paste', {text: String(text ?? '')}); }
export function setCoreReadOnly(instance, readOnly) { return command(instance, 'setReadOnly', {readOnly: !!readOnly}); }
export function setCoreTabSize(instance, tabSize) { return command(instance, 'setTabSize', {tabSize: Number(tabSize) || 0}); }
export function bracketCoreDocument(instance, open) { return command(instance, 'bracket', {text: String(open ?? '')}); }
export function setCoreEncoding(instance, encoding) { return command(instance, 'setEncoding', {encoding}); }
export function setCoreEOL(instance, eol) { return command(instance, 'setEOL', {eol}); }
export function markCoreSaved(instance) { return command(instance, 'markSaved'); }
export function coreMeta(instance) { return command(instance, 'meta'); }
export function coreCapabilities(instance) { return command(instance, 'capabilities'); }

export const editorCoreClient = client;
