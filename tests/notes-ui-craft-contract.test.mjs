import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appHtml = fs.readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
const notesJs = fs.readFileSync(new URL('../public/notes.js', import.meta.url), 'utf8');
const styleCss = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('notes view uses craft shell layout (sidebar / list / editor)', () => {
  assert.match(appHtml, /id="notesShell"/);
  assert.match(appHtml, /class="notes-sidebar"/);
  assert.match(appHtml, /id="notesListHeading"/);
  assert.match(appHtml, /id="notesModeSwitch"/);
  assert.match(appHtml, /id="notesMetaRow"/);
  assert.match(appHtml, /id="notesMoreMenu"/);
  assert.match(appHtml, /id="notesBackBtn"/);
  assert.match(appHtml, /id="notesRestoreBtn"/);
  assert.match(appHtml, /id="notesSelectModeBtn"/);
  assert.match(appHtml, /id="notesSelectionBar"/);
  assert.match(appHtml, /id="notesPurgePermanentBtn"/);
  // Markdown toolbar uses SVG, not emoji chrome
  assert.match(appHtml, /id="notesToolbar"[\s\S]*?<svg/);
  assert.doesNotMatch(appHtml, /data-md="link"[^>]*>🔗/);
});

test('notes controller never uses browser prompt/confirm', () => {
  // Strip block + line comments so documentation mentions don't false-positive.
  const code = notesJs
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(code, /\bwindow\.prompt\b/);
  assert.doesNotMatch(code, /\bwindow\.confirm\b/);
  // bare prompt/confirm also forbidden (native dialogs only)
  assert.doesNotMatch(code, /(?<![\w.$])prompt\s*\(/);
  assert.doesNotMatch(code, /(?<![\w.$])confirm\s*\(/);
  assert.match(notesJs, /function openNativeDialog/);
  assert.match(notesJs, /function nativeConfirm/);
  assert.match(notesJs, /function nativePrompt/);
  assert.match(notesJs, /notes-dialog-backdrop/);
});

test('notes keeps required editor controls and save path ids', () => {
  for (const id of [
    'notesNewBtn',
    'notesSearchInput',
    'notesList',
    'notesTitleInput',
    'notesContentInput',
    'notesPreview',
    'notesSaveState',
    'notesTagsInput',
    'notesGroupInput',
    'notesDeleteBtn',
    'notesPurgeBtn',
    'notesEmptyTrashBtn',
    'notesImportBtn',
    'notesExportBtn',
    'notesLinkConnBtn',
    'notesShareBtn',
    'notesToolbar',
    'notesSortSelect',
    'notesTagFilter',
  ]) {
    assert.match(appHtml, new RegExp(`id="${id}"`));
  }
  assert.match(notesJs, /expectedRevision/);
  assert.match(notesJs, /flushSave/);
  assert.match(notesJs, /filterByConnection/);
  assert.match(notesJs, /showConflictWindow/);
});

test('notes CSS covers glass chrome, mode thumb, dialogs, mobile master-detail', () => {
  assert.match(styleCss, /\.notes-shell/);
  assert.match(styleCss, /\.notes-mode-thumb/);
  assert.match(styleCss, /notes-mobile-detail/);
  assert.match(styleCss, /\.notes-dialog-backdrop/);
  assert.match(styleCss, /prefers-reduced-motion:\s*reduce/);
  assert.match(styleCss, /prefers-reduced-transparency:\s*reduce/);
  assert.match(styleCss, /backdrop-filter:\s*blur/);
  // press feedback, not ease-in
  assert.match(styleCss, /\.notes-icon-btn:active\s*\{\s*transform:\s*scale\(0\.96\)/);
  assert.doesNotMatch(styleCss, /\.notes-list-item[^{]*\{[^}]*ease-in[^}]*\}/);
});

test('app wires craft notes module and current app cache-bust', () => {
  assert.match(appJs, /notes\.js\?v=20260720-notes-select1/);
  assert.match(appHtml, /style\.css\?v=20260727-ai-confirm-fix1/);
  assert.match(appHtml, /app\.js\?v=20260727-ai-confirm-fix1/);
});

test('keyboard shortcuts exist for high-frequency notes actions', () => {
  assert.match(notesJs, /meta\s*&&\s*key\s*===\s*'n'/);
  assert.match(notesJs, /meta\s*&&\s*key\s*===\s*'s'/);
  assert.match(notesJs, /meta\s*&&\s*key\s*===\s*'f'/);
  assert.match(notesJs, /meta\s*&&\s*key\s*===\s*'e'/);
});
