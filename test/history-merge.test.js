'use strict';
/* Regression: canonical history reload must keep local tool traces and the
 * persisted reasoning transcript, reinserted after their anchor message. */

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
const start = src.indexOf('function mergeCanonicalWithEphemeral(');
const end = src.indexOf('function installClosestFallback()');
assert.ok(start > 0 && end > start, 'function must be extractable');

const sandbox = {};
vm.runInNewContext(src.slice(start, end), sandbox);
const { mergeCanonicalWithEphemeral } = sandbox;

const conversation = {
    id: 'c1',
    messages: [
        { id: 'u1', role: 'user', content: 'hi' },
        { id: 'a1', role: 'assistant', content: 'answer' },
    ],
};
const prev = {
    id: 'c1',
    messages: [
        { id: 'u1', role: 'user', content: 'hi' },
        { id: 't1', role: 'trace', content: '<tool>grep</tool>', anchorMessageId: 'u1' },
        { id: 'a1', role: 'assistant', content: 'answer' },
        { id: 'r1', role: 'trace', content: '<details>reasoning</details>', anchorMessageId: 'a1' },
    ],
};

const merged = mergeCanonicalWithEphemeral(conversation, prev, { title: 'cached' });
const roles = merged.messages.map((m) => m.id);
assert.deepStrictEqual(roles, ['u1', 't1', 'a1', 'r1'], `order must be user,trace,assistant,reasoning got ${JSON.stringify(roles)}`);
assert.strictEqual(merged.title, 'cached', 'cached metadata preserved');

// Trace whose anchor was deleted (canonical message gone) lands at the end.
const prev2 = {
    messages: [
        { id: 't2', role: 'trace', content: 'orphan', anchorMessageId: 'gone' },
        { id: 's1', role: 'system', content: 'notice' },
    ],
};
const merged2 = mergeCanonicalWithEphemeral(conversation, prev2, {});
const ids2 = merged2.messages.map((m) => m.id);
assert.deepStrictEqual(ids2, ['u1', 'a1', 't2', 's1'], `unanchored at end got ${JSON.stringify(ids2)}`);

// No ephemeral messages: canonical messages unchanged.
const merged3 = mergeCanonicalWithEphemeral(conversation, { messages: [{ id: 'u1', role: 'user' }] }, {});
assert.deepStrictEqual(merged3.messages.map((m) => m.id), ['u1', 'a1']);

// Canonical source must not be mutated.
assert.strictEqual(conversation.messages.length, 2, 'canonical input must stay untouched');

console.log('PASS canonical/ephemeral merge');
