import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const root = new URL('../', import.meta.url);
const read = p => fs.readFileSync(new URL(p, root), 'utf8');
const tv = read('android/feature-sessions/src/main/java/com/termux/view/TerminalView.java');
const bridge = read('android/feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TermuxSessionBridge.kt');
const route = read('android/feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/SessionRoutes.kt');
test('terminal requests ordinary multiline text IME', () => {
  assert.match(tv, /TYPE_CLASS_TEXT[\s\S]*TYPE_TEXT_VARIATION_NORMAL[\s\S]*TYPE_TEXT_FLAG_MULTI_LINE/);
  assert.doesNotMatch(tv, /outAttrs\.inputType = InputType\.TYPE_NULL/);
  assert.match(bridge, /shouldEnforceCharBasedInput\(\): Boolean = false/);
});
test('copy uses exact native selection, never fixed scrollback', () => {
  assert.match(bridge, /fun selectedText\(\).*\.selectedText/);
  assert.match(route, /viewModel\.selectedText\(\)/);
  assert.doesNotMatch(route, /readScrollback\(0, 24\)/);
});
const workspace = read('android/feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalWorkspace.kt');
const pane = read('android/feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SftpBrowserPane.kt');
const notes = read('android/feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SnippetScreens.kt');
const exec = read('android/app/src/main/kotlin/one/zephyr/mobile/app/LiveSshExecPort.kt');
test('SFTP drawer expands fully and browser has navigation/edit safety', () => {
  assert.match(workspace, /SHEET_MAX_FRACTION = 1\.00f/);
  for (const p of [/canonicalPath/, /parentPath/, /LazyColumn/, /port\.write\(/, /decodeUtf8Text/, /BackHandler/, /未保存/]) assert.match(pane, p);
  assert.match(notes, /fun SftpBrowserRoute/);
  assert.doesNotMatch(notes, /prod-web-01|deploy-2026/);
  assert.match(exec, /managed\.withSession/);
  assert.doesNotMatch(exec, /请先连接该 SSH 主机/);
});
const editor = read('android/feature-connections/src/main/kotlin/one/zephyr/mobile/feature/connections/ConnectionEditorScreen.kt');
const editorVm = read('android/feature-connections/src/main/kotlin/one/zephyr/mobile/feature/connections/ConnectionEditorViewModel.kt');
test('password is one selectable editable row and reveal remains authenticated', () => {
  assert.match(editor, /BasicTextField/);
  assert.match(editor, /fun InlineSecretInput/);
  assert.match(editor, /existingHidden = stored\.hasValue && revealedValue == null && replacement == null/);
  assert.match(editor, /onChange\(SecretState\.Replace\(""\)\)/);
  assert.match(editor, /onChange\(SecretState\.Clear\)/);
  assert.match(editor, /if \(revealAllowed && state is SecretState\.Unchanged\)/);
  assert.match(editorVm, /passwordRevealer\(connection\)/);
});
