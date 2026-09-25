import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('the undefined saveAiDraft call is gone', () => {
    assert.equal(app.includes('saveAiDraft'), false);
});

test('picker changes persist through a real function', () => {
    const start = app.indexOf('function persistAiSessionSelection(');
    assert.ok(start > 0, 'persistAiSessionSelection must exist');
    const body = app.slice(start, app.indexOf('\nfunction ', start + 1));
    // Local cache always, canonical PATCH only once the conversation has a revision.
    assert.match(body, /saveAiChats\(\)/);
    assert.match(body, /method: 'PATCH'/);
    assert.match(body, /providerId: session\.providerId/);
    assert.match(body, /model: session\.model/);
    assert.match(body, /Number\(session\.revision\) > 0/);
    // One retry on a stale revision, and nothing else bubbles to the user.
    assert.match(body, /revision_conflict/);
    assert.match(body, /loadAiChats\(\{ force: true \}\)/);
});

test('applyAiPickerChoice delegates persistence instead of calling a missing function', () => {
    const start = app.indexOf('function applyAiPickerChoice(');
    const body = app.slice(start, app.indexOf('\nfunction ', start + 1));
    assert.match(body, /persistAiSessionSelection\(session\)/);
    assert.equal(body.includes('saveAiDraft'), false);
});

test('header selectors restore the conversation choice over the global default', () => {
    const start = app.indexOf('function renderAiHeaderSelectors(');
    const body = app.slice(start, app.indexOf('\nfunction ', start + 1));
    assert.match(body, /sessionChoice\?\.providerId/);
    assert.match(body, /sessionChoice\?\.model/);
    const think = app.slice(app.indexOf('function renderAiThinkingSelector('));
    assert.match(think.slice(0, 900), /aiCurrentSession\(\)\?\.thinking/);
});

test('thinking intensity is kept in the device-local metadata cache', () => {
    const start = app.indexOf('function aiHistoryCacheMetadata(');
    const body = app.slice(start, app.indexOf('\nfunction ', start + 1));
    assert.match(body, /thinking: String\(session\?\.thinking \|\| ''\)/);
});
