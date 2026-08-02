import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function extractFunction(name) {
    const start = app.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} is missing`);
    const next = app.indexOf('\nfunction ', start + 10);
    return app.slice(start, next < 0 ? app.length : next);
}

test('composer exposes the reference-style cancel edit action', () => {
    assert.match(html, /id="aiCancelEditBtn"[^>]*data-i18n="退出编辑"/);
    assert.match(app, /aiCancelEditBtn'\)\?\.addEventListener\('click', \(\) => cancelAiMessageEdit\(\)\)/);
    assert.match(app, /e\.key === 'Escape' && aiEditingMessageIndex >= 0/);
});

test('cancel edit clears only the draft editing state and does not truncate history', () => {
    const cancel = extractFunction('cancelAiMessageEdit');
    assert.match(cancel, /aiEditingMessageIndex = -1/);
    assert.match(cancel, /aiEditingSessionId = ''/);
    assert.match(cancel, /input\.value = ''/);
    assert.match(cancel, /syncAiEditingState\(\)/);
    assert.doesNotMatch(cancel, /messages|splice|slice/);
});

test('entering edit synchronizes the visible editing state', () => {
    const edit = extractFunction('editAiMessageFromMenu');
    assert.match(edit, /aiEditingMessageIndex = aiMessageMenuState\.index/);
    assert.match(edit, /syncAiEditingState\(\)/);
});
