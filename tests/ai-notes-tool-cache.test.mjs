import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cachedToolDefinitions } = require('../ai-agent-service.js');

function names(tools) {
    return new Set((tools || []).map((tool) => tool?.function?.name).filter(Boolean));
}

test('tool-definition cache invalidates when note permissions change', () => {
    const hidden = names(cachedToolDefinitions({ permissions: { notesRead: false, notesWrite: false } }));
    assert.equal(hidden.has('note_list'), false);
    assert.equal(hidden.has('note_create'), false);

    const readable = names(cachedToolDefinitions({ permissions: { notesRead: true, notesWrite: false } }));
    assert.equal(readable.has('note_list'), true);
    assert.equal(readable.has('note_search'), true);
    assert.equal(readable.has('note_get'), true);
    assert.equal(readable.has('note_create'), false);

    const writable = names(cachedToolDefinitions({ permissions: { notesRead: false, notesWrite: true } }));
    assert.equal(writable.has('note_list'), false);
    assert.equal(writable.has('note_create'), true);
    assert.equal(writable.has('note_update'), true);
});
