import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {EditorCoreHost} from '../../../tests/editorcore-host.mjs';

const bridge = fs.readFileSync(new URL('../android/feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/EditorCore.kt', import.meta.url), 'utf8');
const pane = fs.readFileSync(new URL('../android/feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SftpBrowserPane.kt', import.meta.url), 'utf8');

test('android editor asks the shared core for the UTF-8 it saves', async () => {
  assert.match(bridge, /nativeCall/);
  assert.match(bridge, /fun text\(id: Long\): String/);
  assert.match(pane, /EditorCore\.text\(/);
  assert.match(pane, /EditorCore\.findNext/);
  assert.match(pane, /EditorCore\.replaceOne/);
  assert.match(bridge, /fun format\(/);
  assert.match(bridge, /trimTrailingWhitespace/);
  assert.match(pane, /EditorCore\.format/);
  assert.match(pane, /EditorCore\.trimTrailingWhitespace/);
  assert.doesNotMatch(pane, /SftpEditorSupport\.formatDocument|SftpEditorSupport\.trimTrailingWhitespace/);
  assert.match(pane, /LocalClipboardManager/);
  assert.match(pane, /error\(failure\.message \?: "editorcore 不可用"\)/);
  assert.doesNotMatch(pane, /source = latest|getOrElse \{ latest \}/);
  const host = await EditorCoreHost.start();
  try {
    const opened = await host.call({op: 'open', text: 'a😀'});
    const edited = await host.call({op: 'replace', id: opened.snapshot.id, start: 1, end: 2, text: '中', preserve: true});
    const selected = await host.call({op: 'setSelection', id: opened.snapshot.id, base: 0, extent: 2});
    const saved = await host.call({op: 'text', id: opened.snapshot.id});
    assert.equal(edited.text, 'a中');
    assert.deepEqual(selected.snapshot.selection, {base: 0, extent: 2});
    assert.equal(saved.text, 'a中');
  } finally {
    await host.close();
  }
});
