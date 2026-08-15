import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, 'android', rel), 'utf8');
const editor = read('feature-connections/src/main/kotlin/one/zephyr/mobile/feature/connections/ConnectionEditorScreen.kt');
const draft = read('feature-connections/src/main/kotlin/one/zephyr/mobile/feature/connections/ConnectionDraft.kt');
const panels = read('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalPanels.kt');
const workspace = read('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalWorkspace.kt');
const renderer = read('feature-sessions/src/main/java/com/termux/view/TerminalRenderer.java');

test('stored SSH password has explicit replace clear and keep actions', () => {
  assert.match(editor, /onChange\(SecretState\.Replace\(""\)\)/);
  assert.match(editor, /onChange\(SecretState\.Clear\)/);
  assert.match(editor, /onChange\(SecretState\.Unchanged\)/);
  assert.match(draft, /put\("password", outgoingSecret\(password\)\)/);
});

test('terminal color overrides are stateful and reach native renderer', () => {
  assert.match(workspace, /customBackgroundColor/);
  assert.match(workspace, /customSelectionColor/);
  assert.match(panels, /workspace\.copy\(customBackgroundColor = enabled\)/);
  assert.match(panels, /workspace\.copy\(customSelectionColor = !workspace\.customSelectionColor\)/);
  assert.match(renderer, /selectionBackground/);
  assert.match(renderer, /selectionForeground/);
});
