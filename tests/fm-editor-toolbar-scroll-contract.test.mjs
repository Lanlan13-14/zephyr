import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const styleCss = readFileSync(join(root, 'public/style.css'), 'utf8');
const editorCss = readFileSync(join(root, 'public/editor/zephyr-editor.css'), 'utf8');
const terminalJs = readFileSync(join(root, 'public/terminal.js'), 'utf8');
const terminalHtml = readFileSync(join(root, 'public/terminal.html'), 'utf8');

test('fm-editor header-actions is single-row horizontally scrollable', () => {
    // Base rule in style.css
    assert.match(styleCss, /\.fm-editor-header-actions\s*\{[^}]*overflow-x:\s*auto/s);
    assert.match(styleCss, /\.fm-editor-header-actions\s*\{[^}]*flex-wrap:\s*nowrap/s);
    assert.match(styleCss, /\.fm-editor-header-actions\s*\{[^}]*min-width:\s*0/s);
    assert.match(styleCss, /\.fm-editor-header-actions\s*\{[^}]*touch-action:\s*pan-x/s);
    assert.match(styleCss, /\.fm-editor-header-actions \.tool-btn\s*\{[^}]*flex:\s*0 0 auto/s);
    // Must not keep the old non-scrollable shrink lock as the only rule.
    assert.doesNotMatch(
        styleCss,
        /\.fm-editor-header-actions \{ display: flex; align-items: center; gap: 6px; flex-shrink: 0; \}/,
    );
});

test('mobile editor css reinforces horizontal scroll on actions and toolbar', () => {
    assert.match(editorCss, /\.fm-editor-header-actions\s*\{[^}]*overflow-x:\s*auto/s);
    assert.match(editorCss, /\.fm-editor-header-actions\s*\{[^}]*touch-action:\s*pan-x/s);
    assert.match(editorCss, /\.fm-editor-toolbar\s*\{[^}]*overflow-x:\s*auto/s);
    assert.match(editorCss, /\.fm-editor-toolbar\s*\{[^}]*flex-wrap:\s*nowrap/s);
});

test('editor header drag ignores actions strip', () => {
    assert.match(
        terminalJs,
        /closest\('button,input,select,textarea,label,\.fm-editor-header-actions'\)/,
    );
});

test('editor header markup still hosts the action buttons', () => {
    assert.match(terminalHtml, /class="fm-editor-header-actions"/);
    assert.match(terminalHtml, /id="fmEditorCompactBtn"/);
    assert.match(terminalHtml, /id="fmEditorAiBtn"/);
    assert.match(terminalHtml, /id="fmEditorFormatBtn"/);
});
