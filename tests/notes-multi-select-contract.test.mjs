import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appHtml = fs.readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
const notesJs = fs.readFileSync(new URL('../public/notes.js', import.meta.url), 'utf8');
const styleCss = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const notesService = fs.readFileSync(new URL('../notes-service.js', import.meta.url), 'utf8');
const serverJs = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('notes multi-select chrome exists', () => {
  assert.match(appHtml, /id="notesSelectModeBtn"/);
  assert.match(appHtml, /id="notesSelectionBar"/);
  assert.match(appHtml, /data-sel-action="all"/);
  assert.match(appHtml, /data-sel-action="trash"/);
  assert.match(appHtml, /data-sel-action="restore"/);
  assert.match(appHtml, /data-sel-action="purge"/);
  assert.match(appHtml, /data-sel-action="purge_permanent"/);
  assert.match(appHtml, /id="notesPurgePermanentBtn"/);
  // Restore is an icon button, not bare text-only control.
  assert.match(appHtml, /id="notesRestoreBtn"[\s\S]*?<svg/);
});

test('notes controller implements select mode and bulk ops', () => {
  assert.match(notesJs, /function setSelectMode/);
  assert.match(notesJs, /function selectAllVisible/);
  assert.match(notesJs, /function runBulk/);
  assert.match(notesJs, /selectMode/);
  assert.match(notesJs, /selectedIds/);
  assert.match(notesJs, /\/api\/notes\/bulk/);
  assert.match(notesJs, /purge_permanent/);
  assert.match(notesJs, /force=1/);
  // SVG icon set includes restore / multi / purge
  assert.match(notesJs, /restore:\s*'<svg/);
  assert.match(notesJs, /multi:\s*'<svg/);
  assert.match(notesJs, /purge:\s*'<svg/);
});

test('notes list items expose checkbox and open targets', () => {
  assert.match(notesJs, /data-note-check=/);
  assert.match(notesJs, /data-note-open=/);
  assert.match(notesJs, /notes-list-check/);
  assert.match(styleCss, /\.notes-list-check/);
  assert.match(styleCss, /\.notes-selection-bar/);
  assert.match(styleCss, /\.notes-list-item\.is-checked/);
  // press feedback, not ease-in
  assert.match(styleCss, /\.notes-list-check:active/);
  assert.doesNotMatch(styleCss, /\.notes-selection-bar[^{]*\{[^}]*ease-in/);
});

test('backend supports permanent purge and bulk', () => {
  assert.match(notesService, /allowActive/);
  assert.match(notesService, /purge_permanent|note\.purge_permanent/);
  assert.match(notesService, /bulk\(/);
  assert.match(serverJs, /\/api\/notes\/bulk/);
  assert.match(serverJs, /allowActive:\s*!!force/);
});

test('more menu and context offer permanent delete + restore icon path', () => {
  assert.match(appHtml, /data-more-action="purge_permanent"/);
  assert.match(appHtml, /data-more-action="restore"/);
  assert.match(notesJs, /data-ctx-action="purge_permanent"/);
  assert.match(notesJs, /icon\('restore'\)/);
});
