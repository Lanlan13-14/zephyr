import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {EditorCoreHost} from './editorcore-host.mjs';

const editor = fs.readFileSync(new URL('../public/editor/src/zephyr-editor.js', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../public/editor/editorcore-bridge.js', import.meta.url), 'utf8');
const android = fs.readFileSync(new URL('../zephyr_one/mobile/android/feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/EditorCore.kt', import.meta.url), 'utf8');
const pane = fs.readFileSync(new URL('../zephyr_one/mobile/android/feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SftpBrowserPane.kt', import.meta.url), 'utf8');

test('desktop and android call the same find, replace, undo and edit ops', () => {
  for (const op of ['find', 'replaceOne', 'replaceAll', 'undo', 'redo', 'indent', 'format', 'trimTrailingWhitespace', 'toggleLineComment', 'copy', 'cut', 'setEOL', 'setEncoding', 'capabilities']) {
    assert.match(bridge, new RegExp(op));
    assert.match(android, new RegExp(op === 'toggleLineComment' ? 'toggleComment' : op));
  }
  assert.match(editor, /findWithCore/);
  assert.match(editor, /undoWithCore/);
  assert.match(pane, /EditorCore\.replaceAll/);
  assert.match(pane, /EditorCore\.undo/);
  assert.doesNotMatch(pane, /getOrElse \{ latest \}/);
});

test('desktop and android controls call the core instead of only exposing the API', () => {
  assert.match(editor, /data-editor-role="coreSearch"/);
  assert.match(editor, /data-search="count"/);
  assert.match(editor, /data-search="case"/);
  assert.match(editor, /data-search="regex"/);
  assert.match(editor, /data-search="previous"/);
  assert.match(editor, /data-search="next"/);
  assert.match(editor, /data-search="replace-one"/);
  assert.match(editor, /data-search="replace-all"/);
  assert.match(editor, /query\.value/);
  assert.doesNotMatch(editor, /openSearchPanel|searchKeymap/);
  assert.match(editor, /formatWithCore/);
  assert.match(editor, /trimTrailingWhitespaceWithCore/);
  assert.doesNotMatch(editor, /prettierFormat|deleteTrailingWhitespace/);
  assert.match(editor, /bracketCoreDocument/);
  assert.match(editor, /breakCoreLine/);
  assert.match(editor, /setCoreEncoding/);
  assert.match(editor, /setCoreEOL/);
  assert.match(pane, /EditorCore\.findNext/);
  assert.match(pane, /EditorCore\.findPrevious/);
  assert.match(pane, /EditorCore\.replaceOne/);
  assert.match(pane, /大小写/);
  assert.match(pane, /正则/);
  assert.match(pane, /上一项/);
  assert.match(pane, /下一项/);
  assert.match(pane, /LocalClipboardManager/);
  assert.match(pane, /EditorCore\.copy/);
  assert.match(pane, /EditorCore\.cut/);
  assert.match(pane, /EditorCore\.bracket/);
  assert.match(pane, /EditorCore\.breakLine/);
  assert.match(pane, /EditorCore\.format/);
  assert.match(pane, /EditorCore\.trimTrailingWhitespace/);
  assert.doesNotMatch(pane, /SftpEditorSupport\.formatDocument|SftpEditorSupport\.trimTrailingWhitespace/);
  assert.match(pane, /EditorCore\.setEncoding/);
  assert.match(pane, /EditorCore\.setEol/);
  assert.match(pane, /editorcore 不可用/);
  assert.doesNotMatch(pane, /findInText/);
});

test('find keeps spaces, case, regexp, count, the 1000 cap and wrap', async () => {
  const host = await EditorCoreHost.start();
  try {
    const opened = await host.call({op: 'open', text: 'a a \nA\naa'});
    const id = opened.snapshot.id;
    const spaced = await host.call({op: 'find', id, query: 'a '});
    const plain = await host.call({op: 'find', id, query: 'a'});
    assert.equal(spaced.payload.count, 2);
    assert.equal(plain.payload.count, 5);
    const sensitive = await host.call({op: 'find', id, query: 'A', caseSensitive: true});
    assert.equal(sensitive.payload.count, 1);
    const multiline = await host.call({op: 'find', id, query: '^a', regex: true});
    assert.equal(multiline.payload.count, 3);
    const bad = await host.call({op: 'find', id, query: '(', regex: true});
    assert.equal(typeof bad.payload.error, 'string');
    const wrapped = await host.call({op: 'findPrevious', id, query: 'a', from: 0});
    assert.equal(wrapped.payload.wrapped, true);
  } finally {
    await host.close();
  }
});

test('replacement is literal and replace-all covers matches past 1000', async () => {
  const host = await EditorCoreHost.start();
  try {
    const opened = await host.call({op: 'open', text: 'a'.repeat(1005)});
    const id = opened.snapshot.id;
    const found = await host.call({op: 'find', id, query: 'a'});
    assert.equal(found.payload.count, 1000);
    assert.equal(found.payload.truncated, true);
    const all = await host.call({op: 'replaceAll', id, query: 'a', replacement: '$1'});
    assert.equal(all.payload.count, 1005);
    assert.equal(all.text, '$1'.repeat(1005));
    const undone = await host.call({op: 'undo', id});
    assert.equal(undone.text, 'a'.repeat(1005));
  } finally {
    await host.close();
  }
});

test('undo, redo and a compound comment are one core history', async () => {
  const host = await EditorCoreHost.start();
  try {
    const opened = await host.call({op: 'open', text: 'a\nb'});
    const id = opened.snapshot.id;
    await host.call({op: 'setSelection', id, base: 0, extent: 3});
    await host.call({op: 'beginCompound', id});
    const commented = await host.call({op: 'toggleLineComment', id, language: 'yaml'});
    await host.call({op: 'endCompound', id});
    assert.equal(commented.text, '# a\n# b');
    const undone = await host.call({op: 'undo', id});
    assert.equal(undone.text, 'a\nb');
    const redone = await host.call({op: 'redo', id});
    assert.equal(redone.text, '# a\n# b');
  } finally {
    await host.close();
  }
});

test('indent, line comment, copy, cut and readonly share the core', async () => {
  const host = await EditorCoreHost.start();
  try {
    const opened = await host.call({op: 'open', text: 'ab\ncd'});
    const id = opened.snapshot.id;
    await host.call({op: 'setSelection', id, base: 0, extent: 5});
    await host.call({op: 'setTabSize', id, tabSize: 2});
    const indented = await host.call({op: 'indent', id});
    assert.equal(indented.text, '  ab\n  cd');
    await host.call({op: 'setSelection', id, base: 0, extent: 0});
    const copied = await host.call({op: 'copy', id});
    assert.equal(copied.payload.text, '  ab\n');
    await host.call({op: 'setReadOnly', id, readOnly: true});
    const cut = await host.call({op: 'cut', id});
    assert.equal(cut.payload.readOnly, true);
    assert.equal((await host.call({op: 'text', id})).text, '  ab\n  cd');
  } finally {
    await host.close();
  }
});

test('format reindents and trim keeps the line break', async () => {
  const host = await EditorCoreHost.start();
  try {
    const opened = await host.call({op: 'open', text: '  a  \n{\nb\n}\t', tabSize: 2});
    const id = opened.snapshot.id;
    const formatted = await host.call({op: 'format', id});
    assert.equal(formatted.text, 'a\n{\n  b\n}');
    assert.equal(formatted.payload.changed, true);
    const undone = await host.call({op: 'undo', id});
    assert.equal(undone.text, '  a  \n{\nb\n}\t');
    const trailing = await host.call({op: 'open', text: 'a  \nb\t'});
    const trimmed = await host.call({op: 'trimTrailingWhitespace', id: trailing.snapshot.id});
    assert.equal(trimmed.text, 'a\nb');
    const locked = await host.call({op: 'open', text: 'a  ', readOnly: true});
    const rejected = await host.call({op: 'format', id: locked.snapshot.id});
    assert.equal(rejected.payload.readOnly, true);
    assert.equal(rejected.text, 'a  ');
  } finally {
    await host.close();
  }
});

test('dirty follows text, encoding and eol, and 5801 lines degrades', async () => {
  const host = await EditorCoreHost.start();
  try {
    const opened = await host.call({op: 'open', text: 'a\nb', eol: 'lf'});
    const id = opened.snapshot.id;
    const eol = await host.call({op: 'setEOL', id, eol: 'crlf'});
    assert.equal(eol.payload.dirty, true);
    assert.equal(eol.payload.eolDirty, true);
    const back = await host.call({op: 'setEOL', id, eol: 'lf'});
    assert.equal(back.payload.dirty, false);
    const encoding = await host.call({op: 'setEncoding', id, encoding: 'latin1'});
    assert.equal(encoding.payload.encodingDirty, true);
    const full = await host.call({op: 'open', text: 'x\n'.repeat(5799) + 'x'});
    assert.equal((await host.call({op: 'capabilities', id: full.snapshot.id})).payload.degraded, false);
    const over = await host.call({op: 'open', text: 'x\n'.repeat(5800) + 'x'});
    const caps = await host.call({op: 'capabilities', id: over.snapshot.id});
    assert.equal(caps.payload.lines, 5801);
    assert.equal(caps.payload.degraded, true);
    assert.equal(caps.payload.syntax, false);
  } finally {
    await host.close();
  }
});
