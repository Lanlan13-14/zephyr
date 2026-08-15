import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(ROOT, 'android');
const MAIN = path.join(ANDROID, 'app/src/main/kotlin/one/zephyr/mobile/app/MainActivity.kt');
const LOCALE = path.join(ANDROID, 'app/src/main/kotlin/one/zephyr/mobile/app/LocaleController.kt');
const POLICY = path.join(ANDROID, 'core-ui/src/main/kotlin/one/zephyr/mobile/ui/locale/AppLanguage.kt');
const DEST = path.join(ANDROID, 'app/src/main/kotlin/one/zephyr/mobile/app/AppDestinations.kt');
const EDITOR = path.join(ANDROID, 'feature-tools/src/main/kotlin/one/zephyr/mobile/feature/tools/ToolScreens.kt');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

test('language collect does not pretend the pref is system before it loads', () => {
  const main = read(MAIN);
  assert.match(main, /collectAsState\(initial = null\)/);
  assert.doesNotMatch(main, /collectAsState\(initial = "system"\)/);
  assert.match(main, /LocaleController\.applyIfNeeded/);
  assert.doesNotMatch(main, /fromStored\(languageCode\)/);
});

test('locale apply is skipped when already applied or not yet loaded', () => {
  const policy = read(POLICY);
  assert.match(policy, /object LocaleApplyPolicy/);
  assert.match(policy, /if \(stored == null\) return null/);
  assert.match(policy, /return if \(wanted == applied\) null else wanted/);
  const locale = read(LOCALE);
  assert.match(locale, /fun applyIfNeeded/);
  assert.match(locale, /if \(applied\(context\) == language\) return/);
  const dest = read(DEST);
  assert.match(dest, /if \(code != selected\)/);
  assert.match(dest, /putStringPreference[\s\S]*applyIfNeeded/);
});

test('resource save leaves the main thread and does not clip the private key', () => {
  const editor = read(EDITOR);
  assert.match(editor, /withContext\(Dispatchers\.IO\)/);
  assert.match(editor, /savingState\.value = true/);
  assert.match(editor, /if \(saving\) "保存中…"/);
  assert.match(editor, /minLines = 8/);
  assert.match(editor, /BEGIN OPENSSH PRIVATE KEY/);
  assert.doesNotMatch(editor, /height\(minHeight/);
  assert.match(editor, /singleLine = minLines == 1/);
});
