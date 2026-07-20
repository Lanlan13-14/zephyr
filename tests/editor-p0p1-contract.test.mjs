import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('canvas minimap replaces HTML line dump', () => {
    const src = read('public/editor/src/zephyr-editor.js');
    assert.match(src, /canvasMinimapPlugin|getContext\('2d'/);
    assert.doesNotMatch(src, /lines\.push\(`<i style="--mm-i/);
    const css = read('public/editor/zephyr-editor.css');
    assert.match(css, /zephyr-cm-minimap-canvas/);
    const bundle = read('public/editor/zephyr-editor.bundle.js');
    assert.match(bundle, /minimap/i);
});

test('multi-cursor and outline/search exports exist', () => {
    const src = read('public/editor/src/zephyr-editor.js');
    assert.match(src, /function addCursorAbove/);
    assert.match(src, /function addCursorBelow/);
    assert.match(src, /Mod-Alt-ArrowUp/);
    assert.match(src, /export function getOutline/);
    assert.match(src, /export function openSearch/);
    assert.match(src, /export function markSaved/);
});

test('server supports mtime conflict and workspace search', () => {
    const s = read('server.js');
    assert.match(s, /mtime_conflict|expectedMtimeMs/);
    assert.match(s, /sftp-workspace-search/);
    assert.match(s, /mtimeMs/);
});

test('terminal wires tabs, conflict, workspace search', () => {
    const t = read('public/terminal.js');
    assert.match(t, /function renderEditorTabs/);
    assert.match(t, /function handleEditorSaveConflict/);
    assert.match(t, /function runWorkspaceSearch/);
    assert.match(t, /findEditorPanelByPath/);
    assert.match(t, /forceOverwrite/);
    const html = read('public/terminal.html');
    assert.match(html, /fmEditorTabs|data-editor-role="tabs"/);
    assert.match(html, /workspace-search/);
    assert.match(html, /data-editor-role="sidepanel"/);
    assert.match(html, /20260720-editor-p0p1/);
});
